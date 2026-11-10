/**
 * Explicit (non-ATA) token accounts in transfers + lookup-table-aware
 * compilation. Offline — fake connection (plan.test.ts pattern).
 */
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  type Connection,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { ClusterConnection } from "../connection/connection.js";
import { accountBase, legacyAccountInfo, legacyMintInfo, mintBase } from "../inspect/__fixtures__/accounts.js";
import { buildTransferInstructions, buildTransferPlan, type BuildTransferOptions } from "./build.js";
import { preflightTransfer } from "./preflight.js";
import { transfer } from "./transfer.js";

const payer = Keypair.generate();
const recipient = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const ACTIVE = BigInt("18446744073709551615");

function fakeConn() {
  const mint = Keypair.generate().publicKey;
  const accounts = new Map<string, { owner: PublicKey; data: Buffer }>();
  accounts.set(mint.toBase58(), legacyMintInfo(mintBase({ decimals: 6 })));
  const ownAta = getAssociatedTokenAddressSync(mint, payer.publicKey, true, TOKEN_PROGRAM_ID);
  accounts.set(ownAta.toBase58(), legacyAccountInfo(accountBase({ mint, owner: payer.publicKey, amount: 10_000n })));
  const fake = {
    getAccountInfo: vi.fn().mockImplementation((addr: PublicKey) => Promise.resolve(accounts.get(addr.toBase58()) ?? null)),
    getMultipleAccountsInfo: vi
      .fn()
      .mockImplementation((addrs: PublicKey[]) => Promise.resolve(addrs.map((a) => accounts.get(a.toBase58()) ?? null))),
    getAddressLookupTable: vi
      .fn()
      .mockResolvedValue({ context: { slot: 1 }, value: null }),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: BLOCKHASH, lastValidBlockHeight: 9 }),
    getEpochInfo: vi.fn().mockResolvedValue({ epoch: 1 }),
    sendRawTransaction: vi.fn().mockResolvedValue("SIG_TX"),
    simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: ["ok"], unitsConsumed: 1 } }),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null }, context: { slot: 42 } }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
  };
  const conn = new ClusterConnection(
    { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" },
    { connection: fake as unknown as Connection },
  );
  /** Register a non-ATA token account for `mint` (or another mint). */
  const addTokenAccount = (owner: PublicKey, amount = 0n, accountMint = mint): PublicKey => {
    const addr = Keypair.generate().publicKey;
    accounts.set(addr.toBase58(), legacyAccountInfo(accountBase({ mint: accountMint, owner, amount })));
    return addr;
  };
  return { conn, fake, mint, ownAta, addTokenAccount };
}

function table(addresses: PublicKey[], deactivationSlot = ACTIVE): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: payer.publicKey,
      addresses,
    },
  });
}

function opts(mint: PublicKey, extra: Partial<BuildTransferOptions> = {}): BuildTransferOptions {
  return { payer: payer.publicKey, destination: recipient, mint, amount: 100n, decimals: 6, ...extra };
}

describe("explicit token accounts", () => {
  it("destinationTokenAccount: targets that account, no ATA creation, destination owner optional", async () => {
    const { conn, mint, ownAta, addTokenAccount } = fakeConn();
    const dest = addTokenAccount(recipient);
    const built = await buildTransferInstructions(conn, opts(mint, { destination: undefined, destinationTokenAccount: dest }));
    expect(built.labels).toEqual(["transferChecked"]);
    const ix = built.instructions[0]!;
    expect(ix.keys[0]!.pubkey.equals(ownAta)).toBe(true);
    expect(ix.keys[2]!.pubkey.equals(dest)).toBe(true);
    expect(built.destinationAta?.equals(dest)).toBe(true);
    expect(built.destinationAtaCreated).toBe(false);
  });

  it("sourceTokenAccount: debits that account", async () => {
    const { conn, mint, addTokenAccount } = fakeConn();
    const src = addTokenAccount(payer.publicKey, 500n);
    const built = await buildTransferInstructions(conn, opts(mint, { sourceTokenAccount: src, ataMode: "none" }));
    expect(built.instructions.at(-1)!.keys[0]!.pubkey.equals(src)).toBe(true);
  });

  it("missing explicit accounts are reported", async () => {
    const { conn, mint } = fakeConn();
    await expect(
      buildTransferInstructions(conn, opts(mint, { sourceTokenAccount: Keypair.generate().publicKey })),
    ).rejects.toMatchObject({ code: "SOURCE_ATA_MISSING" });
    await expect(
      buildTransferInstructions(conn, opts(mint, { destinationTokenAccount: Keypair.generate().publicKey })),
    ).rejects.toMatchObject({ code: "DESTINATION_ACCOUNT_MISSING" });
    // ataMode "none" skips the lookup (lets callers provoke the on-chain error)
    const built = await buildTransferInstructions(
      conn,
      opts(mint, { destinationTokenAccount: Keypair.generate().publicKey, ataMode: "none" }),
    );
    expect(built.labels).toEqual(["transferChecked"]);
  });

  it("option conflicts", async () => {
    const { conn, mint, addTokenAccount } = fakeConn();
    const acct = addTokenAccount(payer.publicKey);
    await expect(
      buildTransferInstructions(conn, opts(mint, { sourceTokenAccount: acct, sourceOwner: payer.publicKey })),
    ).rejects.toMatchObject({ code: "OPTION_CONFLICT" });
    await expect(
      buildTransferInstructions(conn, opts(mint, { destinationTokenAccount: acct, ataMode: "create" })),
    ).rejects.toMatchObject({ code: "ATA_MODE_CONFLICT" });
    await expect(
      buildTransferInstructions(conn, opts(mint, { destination: undefined })),
    ).rejects.toMatchObject({ code: "DESTINATION_REQUIRED" });
    await expect(
      buildTransferInstructions(conn, { payer: payer.publicKey, amount: 1n }),
    ).rejects.toMatchObject({ code: "DESTINATION_REQUIRED" });
    await expect(
      buildTransferInstructions(conn, { payer: payer.publicKey, destination: recipient, amount: 1n, sourceTokenAccount: acct }),
    ).rejects.toMatchObject({ code: "OPTION_TOKEN_ONLY" });
  });

  it("preflight evaluates explicit accounts (balance, owner, mint mismatch, missing destination)", async () => {
    const { conn, mint, addTokenAccount } = fakeConn();
    const other = Keypair.generate().publicKey;
    // explicit source owned by someone else, signer is payer → AUTHORITY_NOT_DELEGATE
    const foreign = addTokenAccount(other, 1_000n);
    let res = await preflightTransfer(conn, opts(mint, { sourceTokenAccount: foreign }));
    expect(res.findings.map((f) => f.code)).toContain("AUTHORITY_NOT_DELEGATE");
    expect(res.resolved?.sourceAta).toBe(foreign.toBase58());

    // low balance on explicit source
    const poor = addTokenAccount(payer.publicKey, 1n);
    res = await preflightTransfer(conn, opts(mint, { sourceTokenAccount: poor }));
    expect(res.findings.map((f) => f.code)).toContain("INSUFFICIENT_TOKEN_BALANCE");

    // destination of a different mint
    const wrongMint = addTokenAccount(recipient, 0n, Keypair.generate().publicKey);
    res = await preflightTransfer(conn, opts(mint, { destinationTokenAccount: wrongMint }));
    expect(res.ok).toBe(false);
    expect(res.findings.map((f) => f.code)).toContain("TOKEN_ACCOUNT_MINT_MISMATCH");

    // missing explicit destination blocks (never created)
    res = await preflightTransfer(conn, opts(mint, { destinationTokenAccount: Keypair.generate().publicKey }));
    const missing = res.findings.find((f) => f.code === "DESTINATION_ACCOUNT_MISSING");
    expect(missing?.severity).toBe("block");
    expect(res.findings.map((f) => f.code)).not.toContain("DEST_ATA_MISSING");
  });
});

describe("lookup-table-aware compilation", () => {
  it("compiles the destination and mint through the table", async () => {
    const fx = fakeConn();
    const dest = getAssociatedTokenAddressSync(fx.mint, recipient, true, TOKEN_PROGRAM_ID);
    const t = table([dest, fx.mint]);
    // the table depends on fx.mint, so register it on the mock afterwards
    fx.fake.getAddressLookupTable.mockImplementation((addr: PublicKey) =>
      Promise.resolve({ context: { slot: 1 }, value: addr.equals(t.key) ? t : null }),
    );
    const { plan } = await buildTransferPlan(fx.conn, {
      ...opts(fx.mint, { ataMode: "none" }),
      blockhash: BLOCKHASH,
      lookupTables: [t.key],
    });
    expect(plan.addressTableLookups).toEqual([
      { table: t.key.toBase58(), writableIndexes: [0], readonlyIndexes: [1] },
    ]);
    // the looked-up accounts are no longer static keys → smaller than without
    const { plan: plain } = await buildTransferPlan(fx.conn, { ...opts(fx.mint, { ataMode: "none" }), blockhash: BLOCKHASH });
    expect(plain.addressTableLookups).toEqual([]);
    expect(plan.estimatedBytes).toBeLessThan(plain.estimatedBytes);
  });

  it("transfer() sends a v0 message using the tables", async () => {
    const fx = fakeConn();
    const t = table([recipient]);
    fx.fake.getAddressLookupTable.mockImplementation((addr: PublicKey) =>
      Promise.resolve({ context: { slot: 1 }, value: addr.equals(t.key) ? t : null }),
    );
    const res = await transfer(fx.conn, {
      from: payer,
      destination: recipient,
      amount: 1_000n,
      lookupTables: [t.key],
      skipPreflight: true,
    });
    expect(res.error).toBeUndefined();
    expect(res.plan?.addressTableLookups).toEqual([{ table: t.key.toBase58(), writableIndexes: [0], readonlyIndexes: [] }]);
  });

  it("unknown / deactivated tables are rejected", async () => {
    const fx = fakeConn();
    await expect(
      buildTransferPlan(fx.conn, { ...opts(fx.mint), blockhash: BLOCKHASH, lookupTables: [Keypair.generate().publicKey] }),
    ).rejects.toMatchObject({ code: "ALT_NOT_FOUND" });
    const dead = table([recipient], 5n);
    fx.fake.getAddressLookupTable.mockResolvedValue({ context: { slot: 1 }, value: dead });
    await expect(
      transfer(fx.conn, { from: payer, destination: recipient, amount: 1n, lookupTables: [dead.key], skipPreflight: true }),
    ).rejects.toMatchObject({ code: "ALT_DEACTIVATED" });
  });
});
