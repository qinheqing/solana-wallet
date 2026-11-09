/**
 * Task #9 tests: Token-2022 runtime management. Fake connection pattern
 * from transfer.test.ts — the mint registry answers getAccountInfo with the
 * owning program (SPL vs Token-2022) so program dispatch and the
 * TOKEN_PROGRAM_MISMATCH guard are exercised for real.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { ClusterConnection } from "../connection/connection.js";
import {
  burnTokens,
  closeMint,
  disableMemoTransfer,
  findWithheldAccounts,
  pauseMint,
  resumeMint,
  setExtensionAuthority,
  updateDefaultAccountState,
  updateInterestRate,
  enableMemoTransfer,
  freezeTokenAccount,
  harvestWithheldToMint,
  mintTokens,
  setFreezeAuthority,
  setMintAuthority,
  setTransferFee,
  thawTokenAccount,
  updateScaledUiMultiplier,
  updateTokenMetadata,
  updateTransferHookProgram,
  withdrawWithheldFromAccounts,
  withdrawWithheldFromMint,
} from "./manage.js";
import { accountBase, ext, token2022AccountInfo } from "../inspect/__fixtures__/accounts.js";

function fakeConn(opts: {
  mintOwner?: PublicKey; // default TOKEN_2022_PROGRAM_ID
  existingAtas?: Set<string>;
} = {}) {
  const mint = Keypair.generate().publicKey;
  const mintOwner = opts.mintOwner ?? TOKEN_2022_PROGRAM_ID;
  const accounts = new Map<string, { owner: PublicKey; data?: Buffer }>([
    [mint.toBase58(), { owner: mintOwner }],
  ]);
  for (const ata of opts.existingAtas ?? []) accounts.set(ata, { owner: PublicKey.default });

  const txs: VersionedTransaction[] = [];
  const fake = {
    getAccountInfo: vi.fn().mockImplementation((addr: PublicKey) => {
      const hit = accounts.get(addr.toBase58());
      return hit
        ? Promise.resolve({ owner: hit.owner, data: hit.data ?? Buffer.alloc(0) })
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

// ---------------------------------------------------------------------------
// PRD T-F: updateScaledUiMultiplier
// ---------------------------------------------------------------------------

describe("updateScaledUiMultiplier (T-F)", () => {
  it("encodes ScaledUiAmountExtension/UpdateMultiplier with f64 multiplier + i64 timestamp", async () => {
    const { conn, txs, mint } = fakeConn();
    const result = await updateScaledUiMultiplier(conn, {
      mint,
      authority,
      multiplier: 2.5,
      effectiveTimestamp: 1_700_000_000,
    });
    expect(result.signature).toBe("SIG_MGMT");
    const ixs = decode(txs[0]!);
    expect(ixs).toHaveLength(1);
    const ix = ixs[0]!;
    expect(ix.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(ix.keys[0]!.equals(mint)).toBe(true);
    expect(ix.keys[1]!.equals(authority.publicKey)).toBe(true);
    expect(ix.data[0]).toBe(43); // ScaledUiAmountExtension
    expect(ix.data[1]).toBe(1); // UpdateMultiplier
    expect(ix.data.readDoubleLE(2)).toBe(2.5);
    expect(ix.data.readBigInt64LE(10)).toBe(1_700_000_000n);
  });

  it("defaults effectiveTimestamp to 0 and validates the multiplier / program", async () => {
    const { conn, txs, mint } = fakeConn();
    await updateScaledUiMultiplier(conn, { mint, authority, multiplier: 1 });
    expect(decode(txs[0]!)[0]!.data.readBigInt64LE(10)).toBe(0n);
    await expect(
      updateScaledUiMultiplier(conn, { mint, authority, multiplier: -1 }),
    ).rejects.toMatchObject({ code: "SCALED_UI_MULTIPLIER_INVALID" });
    const spl = fakeConn({ mintOwner: TOKEN_PROGRAM_ID });
    await expect(
      updateScaledUiMultiplier(spl.conn, { mint: spl.mint, authority, multiplier: 1 }),
    ).rejects.toMatchObject({ code: "TOKEN_PROGRAM_MISMATCH" });
  });
});

// ---------------------------------------------------------------------------
// PRD T-G: account-level extension operations
// ---------------------------------------------------------------------------

describe("enableMemoTransfer / disableMemoTransfer (T-G)", () => {
  const ownerKp = Keypair.generate();

  it("missing ATA → createATA + Reallocate(MemoTransfer) + Enable", async () => {
    const { conn, txs, mint } = fakeConn();
    const result = await enableMemoTransfer(conn, { owner: ownerKp, mint });
    expect(result.signature).toBe("SIG_MGMT");
    const ixs = decode(txs[0]!);
    expect(ixs).toHaveLength(3);
    expect(ixs[0]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[1]!.data[0]).toBe(29); // Reallocate
    expect(ixs[1]!.data.readUInt16LE(1)).toBe(ExtensionType.MemoTransfer);
    expect(ixs[2]!.data[0]).toBe(30); // MemoTransferExtension
    expect(ixs[2]!.data[1]).toBe(0); // Enable
    const ata = getAssociatedTokenAddressSync(mint, ownerKp.publicKey, true, TOKEN_2022_PROGRAM_ID);
    expect(ixs[2]!.keys[0]!.equals(ata)).toBe(true);
    expect(ixs[2]!.keys[1]!.equals(ownerKp.publicKey)).toBe(true);
  });

  it("existing ATA without the extension → Reallocate + Disable", async () => {
    const { conn, txs, mint, accounts } = fakeConn();
    const ata = getAssociatedTokenAddressSync(mint, ownerKp.publicKey, true, TOKEN_2022_PROGRAM_ID);
    const info = token2022AccountInfo(accountBase({ mint, owner: ownerKp.publicKey }), [ext.immutableOwner()]);
    accounts.set(ata.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: info.data });
    await disableMemoTransfer(conn, { owner: ownerKp, mint });
    const ixs = decode(txs[0]!);
    expect(ixs).toHaveLength(2);
    expect(ixs[0]!.data[0]).toBe(29); // Reallocate (owner pays)
    expect(ixs[0]!.keys[1]!.equals(ownerKp.publicKey)).toBe(true);
    expect(ixs[1]!.data[0]).toBe(30);
    expect(ixs[1]!.data[1]).toBe(1); // Disable
  });

  it("ATA that already has MemoTransfer → single Enable instruction, no realloc", async () => {
    const { conn, txs, mint, accounts } = fakeConn();
    const ata = getAssociatedTokenAddressSync(mint, ownerKp.publicKey, true, TOKEN_2022_PROGRAM_ID);
    const info = token2022AccountInfo(accountBase({ mint, owner: ownerKp.publicKey }), [
      ext.immutableOwner(),
      ext.memoTransfer(false),
    ]);
    accounts.set(ata.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: info.data });
    await enableMemoTransfer(conn, { owner: ownerKp, mint });
    const ixs = decode(txs[0]!);
    expect(ixs).toHaveLength(1);
    expect(ixs[0]!.data[0]).toBe(30);
    expect(ixs[0]!.data[1]).toBe(0);
  });

  it("rejects SPL mints", async () => {
    const { conn, mint } = fakeConn({ mintOwner: TOKEN_PROGRAM_ID });
    await expect(enableMemoTransfer(conn, { owner: ownerKp, mint })).rejects.toMatchObject({
      code: "TOKEN_PROGRAM_MISMATCH",
    });
  });
});

describe("withheld-fee collection (T-G)", () => {
  it("withdrawWithheldFromAccounts → default destination = authority ATA (created) + ix 26/3 with sources", async () => {
    const { conn, txs, mint } = fakeConn();
    const sources = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    await withdrawWithheldFromAccounts(conn, { mint, authority, sources });
    const ixs = decode(txs[0]!);
    expect(ixs).toHaveLength(2);
    expect(ixs[0]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    const ix = ixs[1]!;
    expect(ix.data[0]).toBe(26); // TransferFeeExtension
    expect(ix.data[1]).toBe(3); // WithdrawWithheldTokensFromAccounts
    expect(ix.data[2]).toBe(2); // numTokenAccounts
    const ata = getAssociatedTokenAddressSync(mint, authority.publicKey, true, TOKEN_2022_PROGRAM_ID);
    expect(ix.keys[0]!.equals(mint)).toBe(true);
    expect(ix.keys[1]!.equals(ata)).toBe(true);
    expect(ix.keys[2]!.equals(authority.publicKey)).toBe(true);
    expect(ix.keys.slice(3).map((k) => k.toBase58())).toEqual(sources.map((k) => k.toBase58()));
  });

  it("withdrawWithheldFromAccounts rejects an empty source list", async () => {
    const { conn, mint } = fakeConn();
    await expect(
      withdrawWithheldFromAccounts(conn, { mint, authority, sources: [] }),
    ).rejects.toMatchObject({ code: "SOURCES_EMPTY" });
  });

  it("harvestWithheldToMint → single permissionless ix 26/4 (mint + sources)", async () => {
    const { conn, txs, mint } = fakeConn();
    const payer = Keypair.generate();
    const src = Keypair.generate().publicKey;
    await harvestWithheldToMint(conn, { payer, mint, sources: [src] });
    const ixs = decode(txs[0]!);
    expect(ixs).toHaveLength(1);
    expect(ixs[0]!.data[0]).toBe(26);
    expect(ixs[0]!.data[1]).toBe(4);
    expect(ixs[0]!.keys[0]!.equals(mint)).toBe(true);
    expect(ixs[0]!.keys[1]!.equals(src)).toBe(true);
    expect(txs[0]!.message.staticAccountKeys[0]!.equals(payer.publicKey)).toBe(true);
  });

  it("withdrawWithheldFromMint → explicit destination, ix 26/2, no ATA creation", async () => {
    const { conn, txs, mint } = fakeConn();
    const destination = Keypair.generate().publicKey;
    await withdrawWithheldFromMint(conn, { mint, authority, destination });
    const ixs = decode(txs[0]!);
    expect(ixs).toHaveLength(1);
    expect(ixs[0]!.data[0]).toBe(26);
    expect(ixs[0]!.data[1]).toBe(2);
    expect(ixs[0]!.keys[1]!.equals(destination)).toBe(true);
    expect(ixs[0]!.keys[2]!.equals(authority.publicKey)).toBe(true);
  });
});

describe("updateTransferHookProgram (T-G)", () => {
  it("encodes TransferHookExtension/Update with the new program id", async () => {
    const { conn, txs, mint } = fakeConn();
    const hook = Keypair.generate().publicKey;
    await updateTransferHookProgram(conn, { mint, authority, programId: hook });
    const ix = decode(txs[0]!)[0]!;
    expect(ix.data[0]).toBe(36); // TransferHookExtension
    expect(ix.data[1]).toBe(1); // Update
    expect(ix.data.subarray(2, 34)).toEqual(Buffer.from(hook.toBytes()));
    expect(ix.keys[0]!.equals(mint)).toBe(true);
    expect(ix.keys[1]!.equals(authority.publicKey)).toBe(true);
  });

  it("null clears the hook (zero pubkey)", async () => {
    const { conn, txs, mint } = fakeConn();
    await updateTransferHookProgram(conn, { mint, authority, programId: null });
    const ix = decode(txs[0]!)[0]!;
    expect(ix.data.subarray(2, 34)).toEqual(Buffer.alloc(32));
  });
});

describe("extension runtime management", () => {
  it("pauseMint / resumeMint → PausableExtension Pause(1)/Resume(2) signed by the authority", async () => {
    const { conn, txs, mint } = fakeConn();
    await pauseMint(conn, { mint, authority });
    await resumeMint(conn, { mint, authority });
    const [pause, resume] = [decode(txs[0]!)[0]!, decode(txs[1]!)[0]!];
    expect(pause.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(pause.data[0]).toBe(TokenInstruction.PausableExtension);
    expect(pause.data[1]).toBe(1);
    expect(resume.data[1]).toBe(2);
    expect(pause.keys[0]!.equals(mint)).toBe(true);
  });

  it("pauseMint rejects SPL mints", async () => {
    const { conn, mint } = fakeConn({ mintOwner: TOKEN_PROGRAM_ID });
    await expect(pauseMint(conn, { mint, authority })).rejects.toMatchObject({ code: "TOKEN_PROGRAM_MISMATCH" });
  });

  it("closeMint requires confirmClose", async () => {
    const { conn, mint, fake } = fakeConn();
    await expect(closeMint(conn, { mint, authority })).rejects.toMatchObject({ code: "CLOSE_UNCONFIRMED" });
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("updateInterestRate → InterestBearingMintExtension UpdateRate with i16 rate", async () => {
    const { conn, txs, mint } = fakeConn();
    await updateInterestRate(conn, { mint, authority, rate: -250 });
    const ix = decode(txs[0]!)[0]!;
    expect(ix.data[0]).toBe(TokenInstruction.InterestBearingMintExtension);
    expect(ix.data[1]).toBe(1); // UpdateRate
    expect(ix.data.readInt16LE(2)).toBe(-250);
    await expect(updateInterestRate(conn, { mint, authority, rate: 40_000 })).rejects.toMatchObject({
      code: "INTEREST_RATE_INVALID",
    });
  });

  it("updateDefaultAccountState → DefaultAccountStateExtension Update with the new state", async () => {
    const { conn, txs, mint } = fakeConn();
    await updateDefaultAccountState(conn, { mint, freezeAuthority: authority, state: "initialized" });
    const ix = decode(txs[0]!)[0]!;
    expect(ix.data[0]).toBe(TokenInstruction.DefaultAccountStateExtension);
    expect(ix.data[1]).toBe(1); // Update
    expect(ix.data[2]).toBe(1); // AccountState.Initialized
  });

  it("setExtensionAuthority → SetAuthority with the extension AuthorityType; revoke needs confirm", async () => {
    const { conn, txs, mint } = fakeConn();
    const next = Keypair.generate().publicKey;
    await setExtensionAuthority(conn, authority, mint, "pausable", next);
    const ix = decode(txs[0]!)[0]!;
    expect(ix.data[0]).toBe(6); // SetAuthority
    expect(ix.data[1]).toBe(16); // AuthorityType.PausableConfig
    await expect(setExtensionAuthority(conn, authority, mint, "closeMint", null)).rejects.toMatchObject({
      code: "REVOCATION_UNCONFIRMED",
    });
    await setExtensionAuthority(conn, authority, mint, "closeMint", null, { confirmRevoke: true });
    expect(decode(txs[1]!)[0]!.data[1]).toBe(6); // AuthorityType.CloseMint
  });

  it("findWithheldAccounts filters the mint's accounts by memcmp and returns [] when none", async () => {
    const { conn, mint, fake } = fakeConn();
    (fake as Record<string, unknown>).getProgramAccounts = vi.fn().mockResolvedValue([]);
    await expect(findWithheldAccounts(conn, mint)).resolves.toEqual([]);
    const call = ((fake as Record<string, unknown>).getProgramAccounts as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0].equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(call[1].filters[0].memcmp.bytes).toBe(mint.toBase58());
  });
});
