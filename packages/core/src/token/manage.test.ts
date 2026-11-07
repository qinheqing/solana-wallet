/**
 * Task #9 tests: Token-2022 runtime management. Fake connection pattern
 * from transfer.test.ts — the mint registry answers getAccountInfo with the
 * owning program (SPL vs Token-2022) so program dispatch and the
 * TOKEN_PROGRAM_MISMATCH guard are exercised for real.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { ClusterConnection } from "../connection/connection.js";
import {
  burnTokens,
  freezeTokenAccount,
  mintTokens,
  setFreezeAuthority,
  setMintAuthority,
  setTransferFee,
  thawTokenAccount,
  updateTokenMetadata,
} from "./manage.js";

function fakeConn(opts: {
  mintOwner?: PublicKey; // default TOKEN_2022_PROGRAM_ID
  existingAtas?: Set<string>;
} = {}) {
  const mint = Keypair.generate().publicKey;
  const mintOwner = opts.mintOwner ?? TOKEN_2022_PROGRAM_ID;
  const accounts = new Map<string, { owner: PublicKey }>([
    [mint.toBase58(), { owner: mintOwner }],
  ]);
  for (const ata of opts.existingAtas ?? []) accounts.set(ata, { owner: PublicKey.default });

  const txs: VersionedTransaction[] = [];
  const fake = {
    getAccountInfo: vi.fn().mockImplementation((addr: PublicKey) => {
      const hit = accounts.get(addr.toBase58());
      return hit
        ? Promise.resolve({ owner: hit.owner, data: Buffer.alloc(0) })
        : Promise.resolve(null);
    }),
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 999,
    }),
    sendRawTransaction: vi.fn().mockImplementation((raw: Uint8Array) => {
      txs.push(VersionedTransaction.deserialize(raw));
      return Promise.resolve("SIG_MGMT");
    }),
    simulateTransaction: vi.fn().mockResolvedValue({
      value: { err: null, logs: ["Program log: ok"], unitsConsumed: 500 },
    }),
    confirmTransaction: vi
      .fn()
      .mockResolvedValue({ value: { err: null }, context: { slot: 11 } }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
  };
  const conn = new ClusterConnection(
    { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" },
    { connection: fake as unknown as Connection },
  );
  return { conn, fake, txs, mint, mintOwner, accounts };
}

function decode(tx: VersionedTransaction) {
  return tx.message.compiledInstructions.map((ci) => ({
    programId: tx.message.staticAccountKeys[ci.programIdIndex]!,
    keys: ci.accountKeyIndexes.map((i) => tx.message.staticAccountKeys[i]!),
    data: Buffer.from(ci.data),
  }));
}

const authority = Keypair.generate();
const owner = Keypair.generate().publicKey;

describe("mintTokens / burnTokens (8.5)", () => {
  it("mints to an existing ATA with a single mintTo instruction", async () => {
    const { conn, txs, mint, accounts } = fakeConn();
    const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
    accounts.set(ata.toBase58(), { owner: PublicKey.default });
    const result = await mintTokens(conn, authority, mint, owner, 100n);
    expect(result).toMatchObject({ signature: "SIG_MGMT", slot: 11, feeLamports: 5000, simulatedOnly: false });
    const ixs = decode(txs[0]!);
    expect(ixs).toHaveLength(1);
    expect(ixs[0]!.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    // MintTo = 7; amount (little-endian u64) = 100
    expect(ixs[0]!.data[0]).toBe(7);
    expect(ixs[0]!.data.readBigUInt64LE(1)).toBe(100n);
  });

  it("creates the missing destination ATA idempotently before mintTo (2 instructions)", async () => {
    const { conn, txs, mint } = fakeConn();
    await mintTokens(conn, authority, mint, owner, 5n);
    const ixs = decode(txs[0]!);
    expect(ixs).toHaveLength(2);
    expect(ixs[0]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[1]!.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(ixs[1]!.data[0]).toBe(7); // MintTo
  });

  it("mints through the classic SPL program when the mint is SPL", async () => {
    const { conn, txs, mint } = fakeConn({ mintOwner: TOKEN_PROGRAM_ID });
    await mintTokens(conn, authority, mint, owner, 1n);
    const ixs = decode(txs[0]!);
    expect(ixs[ixs.length - 1]!.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  it("burns from the wallet's own ATA", async () => {
    const { conn, txs, mint } = fakeConn();
    await burnTokens(conn, authority, mint, 42n);
    const ixs = decode(txs[0]!);
    expect(ixs).toHaveLength(1);
    expect(ixs[0]!.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(ixs[0]!.data[0]).toBe(8); // Burn
    expect(ixs[0]!.data.readBigUInt64LE(1)).toBe(42n);
  });

  it("rejects zero/negative amounts with AMOUNT_INVALID", async () => {
    const { conn, mint } = fakeConn();
    await expect(mintTokens(conn, authority, mint, owner, 0n)).rejects.toMatchObject({ code: "AMOUNT_INVALID" });
    await expect(burnTokens(conn, authority, mint, -1n)).rejects.toMatchObject({ code: "AMOUNT_INVALID" });
  });
});

describe("setTransferFee (9.2)", () => {
  it("sends a single Token-2022 SetTransferFee instruction", async () => {
    const { conn, txs, mint } = fakeConn();
    const result = await setTransferFee(conn, authority, mint, {
      transferFeeBasisPoints: 500,
      maximumFee: 1_000n,
    });
    expect(result.signature).toBe("SIG_MGMT");
    const ixs = decode(txs[0]!);
    expect(ixs).toHaveLength(1);
    expect(ixs[0]!.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    // TransferFeeExtension = 26, TransferFeeInstruction.SetTransferFee = 5
    expect(ixs[0]!.data[0]).toBe(26);
    expect(ixs[0]!.data[1]).toBe(5);
  });

  it("rejects out-of-range fees with TRANSFER_FEE_INVALID", async () => {
    const { conn, mint } = fakeConn();
    await expect(
      setTransferFee(conn, authority, mint, { transferFeeBasisPoints: -1, maximumFee: 0n }),
    ).rejects.toMatchObject({ code: "TRANSFER_FEE_INVALID" });
    await expect(
      setTransferFee(conn, authority, mint, { transferFeeBasisPoints: 20_000, maximumFee: 0n }),
    ).rejects.toMatchObject({ code: "TRANSFER_FEE_INVALID" });
  });

  it("throws TOKEN_PROGRAM_MISMATCH (with hint) on a classic SPL mint", async () => {
    const { conn, mint } = fakeConn({ mintOwner: TOKEN_PROGRAM_ID });
    const err = await setTransferFee(conn, authority, mint, {
      transferFeeBasisPoints: 100,
      maximumFee: 0n,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "TOKEN_PROGRAM_MISMATCH" });
    expect((err as { hint?: string }).hint).toMatch(/createToken2022/i);
  });
});

describe("freeze / thaw (9.2)", () => {
  it("freeze and thaw target the derived ATA via the mint's program", async () => {
    const { conn, txs, mint } = fakeConn();
    await freezeTokenAccount(conn, authority, mint, owner);
    await thawTokenAccount(conn, authority, mint, owner);
    const frozen = decode(txs[0]!);
    const thawed = decode(txs[1]!);
    expect(frozen[0]!.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(thawed[0]!.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    // FreezeAccount = 10, ThawAccount = 11
    expect(frozen[0]!.data[0]).toBe(10);
    expect(thawed[0]!.data[0]).toBe(11);
    const expectedAta = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
    expect(frozen[0]!.keys[0]!.equals(expectedAta)).toBe(true);
    expect(frozen[0]!.keys[1]!.equals(mint)).toBe(true);
    expect(frozen[0]!.keys[2]!.equals(authority.publicKey)).toBe(true);
  });
});

describe("setMintAuthority / setFreezeAuthority (9.3)", () => {
  it("encodes AuthorityType MintTokens vs FreezeAccount", async () => {
    const { conn, txs, mint } = fakeConn();
    const next = Keypair.generate().publicKey;
    await setMintAuthority(conn, authority, mint, next);
    await setFreezeAuthority(conn, authority, mint, next);
    const mintIx = decode(txs[0]!)[0]!;
    const freezeIx = decode(txs[1]!)[0]!;
    expect(mintIx.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    // SetAuthority = 6; authority type at byte 1: MintTokens=0, FreezeAccount=1
    expect(mintIx.data[0]).toBe(6);
    expect(mintIx.data[1]).toBe(0);
    expect(freezeIx.data[1]).toBe(1);
    // account layout: [mint, current authority, (new authority)]
    expect(mintIx.keys[0]!.equals(mint)).toBe(true);
    expect(mintIx.keys[1]!.equals(authority.publicKey)).toBe(true);
  });

  it("revocation requires confirmRevoke", async () => {
    const { conn, mint } = fakeConn();
    await expect(setMintAuthority(conn, authority, mint, null)).rejects.toMatchObject({
      code: "REVOCATION_UNCONFIRMED",
    });
    await expect(setFreezeAuthority(conn, authority, mint, null)).rejects.toMatchObject({
      code: "REVOCATION_UNCONFIRMED",
    });
  });

  it("revocation proceeds with confirmRevoke (option byte = 0 → no new authority)", async () => {
    const { conn, txs, mint } = fakeConn();
    await setMintAuthority(conn, authority, mint, null, { confirmRevoke: true });
    const ix = decode(txs[0]!)[0]!;
    expect(ix.data[0]).toBe(6);
    expect(ix.data[2]).toBe(0); // no new authority follows
  });
});

describe("updateTokenMetadata (9.3)", () => {
  it("updates a known field via the Token-2022 program, metadata = mint", async () => {
    const { conn, txs, mint } = fakeConn();
    await updateTokenMetadata(conn, authority, mint, { field: "name", value: "Renamed" });
    const ix = decode(txs[0]!)[0]!;
    expect(ix.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    // metadata keys: [metadata (= the mint), update authority]
    expect(ix.keys[0]!.equals(mint)).toBe(true);
    expect(ix.keys[1]!.equals(authority.publicKey)).toBe(true);
    // 8-byte anchor discriminator, then field enum (Name=0), then value
    expect(ix.data.toString("utf8")).toContain("Renamed");
  });

  it("accepts custom keys as additional metadata", async () => {
    const { conn, txs, mint } = fakeConn();
    await updateTokenMetadata(conn, authority, mint, { field: "myCustomKey", value: "v" });
    const ix = decode(txs[0]!)[0]!;
    expect(ix.data.toString("utf8")).toContain("myCustomKey");
  });

  it("throws TOKEN_PROGRAM_MISMATCH on SPL mints and rejects long values", async () => {
    const { conn, mint } = fakeConn({ mintOwner: TOKEN_PROGRAM_ID });
    await expect(
      updateTokenMetadata(conn, authority, mint, { field: "name", value: "x" }),
    ).rejects.toMatchObject({ code: "TOKEN_PROGRAM_MISMATCH" });

    const { conn: conn2, mint: mint2 } = fakeConn();
    await expect(
      updateTokenMetadata(conn2, authority, mint2, { field: "uri", value: "x".repeat(201) }),
    ).rejects.toMatchObject({ code: "METADATA_INVALID" });
  });
});

describe("dryRun support", () => {
  it("management operations simulate instead of sending", async () => {
    const { conn, fake, mint } = fakeConn();
    const result = await setTransferFee(
      conn,
      authority,
      mint,
      { transferFeeBasisPoints: 100, maximumFee: 1n },
      { dryRun: true },
    );
    expect(result.simulatedOnly).toBe(true);
    expect(result.signature).toBe("");
    expect(result.logs).toContain("Program log: ok");
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
  });
});
