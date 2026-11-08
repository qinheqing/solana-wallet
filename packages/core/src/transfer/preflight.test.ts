/**
 * PRD T-C: preflightTransfer / evaluatePreflight findings on byte-faithful
 * fixture buffers, plus transfer() gating (blocked / force / skipPreflight).
 */
import { AccountState, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { ClusterConnection } from "../connection/connection.js";
import { decodeTokenAccount } from "../inspect/account.js";
import { decodeMintAccount } from "../inspect/mint.js";
import {
  accountBase,
  ext,
  legacyAccountInfo,
  legacyMintInfo,
  mintBase,
  token2022AccountInfo,
  token2022MintInfo,
  type TlvEntry,
} from "../inspect/__fixtures__/accounts.js";
import type { BuildTransferOptions } from "./build.js";
import { computeTransferFee, evaluatePreflight, pickFeeTier, preflightTransfer, type PreflightResult } from "./preflight.js";
import { transfer } from "./transfer.js";

const payer = Keypair.generate();
const recipient = Keypair.generate().publicKey;
const mintKey = Keypair.generate().publicKey;
const auth = Keypair.generate().publicKey;

const codes = (r: PreflightResult) => r.findings.map((f) => f.code);
const find = (r: PreflightResult, code: string) => r.findings.find((f) => f.code === code);

function mint2022(extensions: TlvEntry[] = []) {
  return decodeMintAccount(mintKey, token2022MintInfo(mintBase({ decimals: 6 }), extensions));
}
function account2022(owner: PublicKey, o: { amount?: bigint; state?: AccountState; ext?: TlvEntry[] } = {}) {
  const ata = getAssociatedTokenAddressSync(mintKey, owner, true, TOKEN_2022_PROGRAM_ID);
  return decodeTokenAccount(
    ata,
    token2022AccountInfo(accountBase({ mint: mintKey, owner, amount: o.amount ?? 10_000n, state: o.state }), [
      ext.immutableOwner(),
      ...(o.ext ?? []),
    ]),
  );
}
function opts(extra: Partial<BuildTransferOptions> = {}): BuildTransferOptions {
  return { payer: payer.publicKey, destination: recipient, mint: mintKey, amount: 1_000n, decimals: 6, ...extra };
}
const funded = () => account2022(payer.publicKey);

describe("evaluatePreflight (T-C) — pure rules", () => {
  it("clean Token-2022 mint, both ATAs present and funded → ok with no findings", () => {
    const r = evaluatePreflight({ mint: mint2022(), sourceAccount: funded(), destAccount: account2022(recipient), opts: opts() });
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.resolved?.sourceAta).toBe(getAssociatedTokenAddressSync(mintKey, payer.publicKey, true, TOKEN_2022_PROGRAM_ID).toBase58());
  });

  it("SOL transfer (no mint) → trivially ok", () => {
    const r = evaluatePreflight({ mint: mint2022(), sourceAccount: null, destAccount: null, opts: { ...opts(), mint: undefined } });
    expect(r).toEqual({ ok: true, findings: [] });
  });

  it("TRANSFER_HOOK_PRESENT blocks only with a non-null program id", () => {
    const hookProgram = Keypair.generate().publicKey;
    const blocked = evaluatePreflight({ mint: mint2022([ext.transferHook(auth, hookProgram)]), sourceAccount: funded(), destAccount: account2022(recipient), opts: opts() });
    expect(blocked.ok).toBe(false);
    expect(find(blocked, "TRANSFER_HOOK_PRESENT")).toMatchObject({ severity: "block", data: { programId: hookProgram.toBase58() } });

    const disabled = evaluatePreflight({ mint: mint2022([ext.transferHook(auth, PublicKey.default)]), sourceAccount: funded(), destAccount: account2022(recipient), opts: opts() });
    expect(codes(disabled)).not.toContain("TRANSFER_HOOK_PRESENT");
  });

  it("NON_TRANSFERABLE blocks", () => {
    const r = evaluatePreflight({ mint: mint2022([ext.nonTransferable()]), sourceAccount: funded(), destAccount: account2022(recipient), opts: opts() });
    expect(find(r, "NON_TRANSFERABLE")?.severity).toBe("block");
    expect(r.ok).toBe(false);
  });

  it("MEMO_REQUIRED blocks when dest requires memos and none is given; a memo clears it", () => {
    const dest = account2022(recipient, { ext: [ext.memoTransfer(true)] });
    const r = evaluatePreflight({ mint: mint2022(), sourceAccount: funded(), destAccount: dest, opts: opts() });
    expect(find(r, "MEMO_REQUIRED")).toMatchObject({ severity: "block", data: { destAta: dest.address } });
    const ok = evaluatePreflight({ mint: mint2022(), sourceAccount: funded(), destAccount: dest, opts: opts({ memo: "hi" }) });
    expect(codes(ok)).not.toContain("MEMO_REQUIRED");
    const off = evaluatePreflight({ mint: mint2022(), sourceAccount: funded(), destAccount: account2022(recipient, { ext: [ext.memoTransfer(false)] }), opts: opts() });
    expect(codes(off)).not.toContain("MEMO_REQUIRED");
  });

  it("ACCOUNT_FROZEN names source vs destination", () => {
    const src = evaluatePreflight({ mint: mint2022(), sourceAccount: account2022(payer.publicKey, { state: AccountState.Frozen }), destAccount: account2022(recipient), opts: opts() });
    expect(find(src, "ACCOUNT_FROZEN")).toMatchObject({ severity: "block", data: { role: "source" } });
    const dst = evaluatePreflight({ mint: mint2022(), sourceAccount: funded(), destAccount: account2022(recipient, { state: AccountState.Frozen }), opts: opts() });
    expect(find(dst, "ACCOUNT_FROZEN")).toMatchObject({ data: { role: "destination" } });
  });

  it("DefaultAccountState=frozen blocks only when the destination ATA will be created", () => {
    const mint = mint2022([ext.defaultAccountState(AccountState.Frozen)]);
    const create = evaluatePreflight({ mint, sourceAccount: funded(), destAccount: null, opts: opts() });
    expect(find(create, "ACCOUNT_FROZEN")).toMatchObject({ severity: "block", data: { reason: "DefaultAccountState" } });
    expect(codes(create)).toContain("DEST_ATA_MISSING");
    const exists = evaluatePreflight({ mint, sourceAccount: funded(), destAccount: account2022(recipient), opts: opts() });
    expect(codes(exists)).not.toContain("ACCOUNT_FROZEN");
    const none = evaluatePreflight({ mint, sourceAccount: funded(), destAccount: null, opts: opts({ ataMode: "none" }) });
    expect(codes(none)).not.toContain("ACCOUNT_FROZEN");
  });

  it("DEST_ATA_MISSING is info and reports the effective ataMode", () => {
    const r = evaluatePreflight({ mint: mint2022(), sourceAccount: funded(), destAccount: null, opts: opts() });
    expect(r.ok).toBe(true);
    expect(find(r, "DEST_ATA_MISSING")).toMatchObject({ severity: "info", data: { ataMode: "auto", allowAtaCreation: true } });
    const none = evaluatePreflight({ mint: mint2022(), sourceAccount: funded(), destAccount: null, opts: opts({ ataMode: "none" }) });
    expect(find(none, "DEST_ATA_MISSING")?.message).toContain('"none"');
  });

  it("TRANSFER_FEE picks the tier by epoch and computes ceil(bps)/maxFee/net", () => {
    const mint = mint2022([
      ext.transferFeeConfig({
        configAuthority: auth,
        withdrawAuthority: auth,
        withheld: 0n,
        older: { epoch: 0n, bps: 100, maxFee: 1_000_000n },
        newer: { epoch: 500n, bps: 250, maxFee: 5n },
      }),
    ]);
    const base = { mint, sourceAccount: funded(), destAccount: account2022(recipient) };
    const older = evaluatePreflight({ ...base, opts: opts({ amount: 1_001n }), epoch: 499 });
    // ceil(1001 * 100 / 10000) = ceil(10.01) = 11
    expect(find(older, "TRANSFER_FEE")).toMatchObject({ severity: "info", data: { tier: "older", expectedFee: "11", net: "990", epoch: "499" } });
    const newer = evaluatePreflight({ ...base, opts: opts({ amount: 1_001n }), epoch: 500 });
    // ceil(1001 * 250 / 10000) = 26, capped at maxFee 5
    expect(find(newer, "TRANSFER_FEE")?.data).toMatchObject({ tier: "newer", expectedFee: "5", net: "996" });
    expect(older.ok && newer.ok).toBe(true);
  });

  it("FEE_MISMATCH blocks when transferCheckedWithFee carries a different fee (chain: FeeMismatch, custom 32)", () => {
    const mint = mint2022([
      ext.transferFeeConfig({ configAuthority: auth, withdrawAuthority: auth, withheld: 0n, older: { epoch: 0n, bps: 100, maxFee: 1_000n }, newer: { epoch: 0n, bps: 100, maxFee: 1_000n } }),
    ]);
    const base = { mint, sourceAccount: funded(), destAccount: account2022(recipient), epoch: 10 };
    const wrong = evaluatePreflight({ ...base, opts: opts({ instruction: "transferCheckedWithFee", fee: 3n }) });
    expect(find(wrong, "FEE_MISMATCH")).toMatchObject({ severity: "block", data: { expectedFee: "10", providedFee: "3" } });
    expect(find(wrong, "FEE_MISMATCH")?.message).toMatch(/custom error 32/);
    expect(codes(wrong)).not.toContain("TRANSFER_FEE");
    expect(wrong.ok).toBe(false);
    const right = evaluatePreflight({ ...base, opts: opts({ instruction: "transferCheckedWithFee", fee: 10n }) });
    expect(codes(right)).toContain("TRANSFER_FEE");
    expect(codes(right)).not.toContain("FEE_MISMATCH");
    expect(find(right, "NON_STANDARD_CONSTRUCTION")?.data).toEqual({ instruction: "transferCheckedWithFee" });
  });

  it("SCALED_UI_AMOUNT warns with the multiplier", () => {
    const mint = mint2022([ext.scaledUiAmount({ authority: auth, multiplier: 2.5, newMultiplier: 3, effectiveAt: 0n })]);
    const r = evaluatePreflight({ mint, sourceAccount: funded(), destAccount: account2022(recipient), opts: opts() });
    expect(find(r, "SCALED_UI_AMOUNT")).toMatchObject({ severity: "warn", data: { multiplier: 2.5, newMultiplier: 3 } });
    expect(r.ok).toBe(true);
  });

  it("INSUFFICIENT_TOKEN_BALANCE / SOURCE_ATA_MISSING block", () => {
    const poor = evaluatePreflight({ mint: mint2022(), sourceAccount: account2022(payer.publicKey, { amount: 999n }), destAccount: account2022(recipient), opts: opts() });
    expect(find(poor, "INSUFFICIENT_TOKEN_BALANCE")).toMatchObject({ severity: "block", data: { balance: "999", amount: "1000" } });
    const exact = evaluatePreflight({ mint: mint2022(), sourceAccount: account2022(payer.publicKey, { amount: 1_000n }), destAccount: account2022(recipient), opts: opts() });
    expect(exact.ok).toBe(true);
    const missing = evaluatePreflight({ mint: mint2022(), sourceAccount: null, destAccount: account2022(recipient), opts: opts() });
    expect(find(missing, "SOURCE_ATA_MISSING")?.severity).toBe("block");
  });

  it("UNCHECKED_TRANSFER_REJECTED blocks instruction \"transfer\" on Token-2022 mints with TransferFeeConfig / TransferHook (custom 31)", () => {
    const feeMint = mint2022([
      ext.transferFeeConfig({ configAuthority: auth, withdrawAuthority: auth, withheld: 0n, older: { epoch: 0n, bps: 100, maxFee: 1_000n }, newer: { epoch: 0n, bps: 100, maxFee: 1_000n } }),
    ]);
    const base = { sourceAccount: funded(), destAccount: account2022(recipient), epoch: 10 };
    const fee = evaluatePreflight({ ...base, mint: feeMint, opts: opts({ instruction: "transfer" }) });
    expect(find(fee, "UNCHECKED_TRANSFER_REJECTED")).toMatchObject({
      severity: "block",
      data: { instruction: "transfer", extension: "TransferFeeConfig", extensions: ["TransferFeeConfig"] },
    });
    expect(find(fee, "UNCHECKED_TRANSFER_REJECTED")?.message).toMatch(/MintRequiredForTransfer \(custom error 31\)/);
    expect(find(fee, "UNCHECKED_TRANSFER_REJECTED")?.message).toMatch(/transferChecked/);
    expect(fee.ok).toBe(false);
    // The construction note is kept alongside the block.
    expect(find(fee, "NON_STANDARD_CONSTRUCTION")?.data).toEqual({ instruction: "transfer" });

    // TransferHook with a disabled (default) program still carries the extension → mint required.
    const hookMint = mint2022([ext.transferHook(auth, PublicKey.default)]);
    const hook = evaluatePreflight({ ...base, mint: hookMint, opts: opts({ instruction: "transfer" }) });
    expect(find(hook, "UNCHECKED_TRANSFER_REJECTED")?.data).toMatchObject({ extension: "TransferHook" });
    expect(codes(hook)).not.toContain("TRANSFER_HOOK_PRESENT"); // null hook program is fine for transferChecked

    // transferChecked on the same mint, and "transfer" on a plain mint, are not flagged.
    expect(codes(evaluatePreflight({ ...base, mint: feeMint, opts: opts() }))).not.toContain("UNCHECKED_TRANSFER_REJECTED");
    const plain = evaluatePreflight({ ...base, mint: mint2022(), opts: opts({ instruction: "transfer" }) });
    expect(codes(plain)).toEqual(["NON_STANDARD_CONSTRUCTION"]);
    // Legacy SPL Token has no such requirement.
    const legacy = evaluatePreflight({
      mint: decodeMintAccount(mintKey, legacyMintInfo(mintBase({ decimals: 6 }))),
      sourceAccount: decodeTokenAccount(
        getAssociatedTokenAddressSync(mintKey, payer.publicKey, true, TOKEN_PROGRAM_ID),
        legacyAccountInfo(accountBase({ mint: mintKey, owner: payer.publicKey, amount: 10_000n })),
      ),
      destAccount: null,
      opts: opts({ instruction: "transfer" }),
    });
    expect(codes(legacy)).not.toContain("UNCHECKED_TRANSFER_REJECTED");
  });

  it("NON_STANDARD_CONSTRUCTION lists every deviating knob; authority === payer is standard", () => {
    const delegate = Keypair.generate().publicKey;
    const r = evaluatePreflight({
      mint: mint2022(),
      sourceAccount: account2022(delegate),
      destAccount: account2022(recipient),
      opts: opts({ instruction: "transfer", ataMode: "create", authority: delegate, sourceOwner: delegate }),
    });
    expect(find(r, "NON_STANDARD_CONSTRUCTION")).toMatchObject({
      severity: "info",
      data: { instruction: "transfer", ataMode: "create", authority: delegate.toBase58(), sourceOwner: delegate.toBase58() },
    });
    const std = evaluatePreflight({ mint: mint2022(), sourceAccount: funded(), destAccount: account2022(recipient), opts: opts({ authority: payer.publicKey }) });
    expect(codes(std)).not.toContain("NON_STANDARD_CONSTRUCTION");
  });

  describe("authority ≠ source owner (T-H)", () => {
    const delegate = Keypair.generate().publicKey;
    const victim = Keypair.generate().publicKey;
    // Delegate pays and signs; the victim's ATA is the source.
    const delegated = () => opts({ payer: delegate, authority: delegate, sourceOwner: victim });

    it("PERMANENT_DELEGATE_TRANSFER (info) when the mint's permanent delegate is the authority", () => {
      const r = evaluatePreflight({ mint: mint2022([ext.permanentDelegate(delegate)]), sourceAccount: account2022(victim), destAccount: account2022(recipient), opts: delegated() });
      expect(r.ok).toBe(true);
      expect(find(r, "PERMANENT_DELEGATE_TRANSFER")).toMatchObject({
        severity: "info",
        data: { authority: delegate.toBase58(), sourceOwner: victim.toBase58(), permanentDelegate: delegate.toBase58() },
      });
      expect(codes(r)).not.toContain("AUTHORITY_NOT_DELEGATE");
    });

    it("DELEGATE_TRANSFER (info) when the source account's delegate is the authority with enough allowance", () => {
      const src = account2022(victim, { ext: [] });
      const withDelegate = decodeTokenAccount(
        new PublicKey(src.address),
        token2022AccountInfo(accountBase({ mint: mintKey, owner: victim, amount: 10_000n, delegate, delegatedAmount: 5_000n }), [ext.immutableOwner()]),
      );
      const r = evaluatePreflight({ mint: mint2022(), sourceAccount: withDelegate, destAccount: account2022(recipient), opts: delegated() });
      expect(r.ok).toBe(true);
      expect(find(r, "DELEGATE_TRANSFER")).toMatchObject({ severity: "info", data: { delegatedAmount: "5000", amount: "1000" } });
    });

    it("INSUFFICIENT_DELEGATED_AMOUNT blocks when the allowance is below the amount", () => {
      const src = decodeTokenAccount(
        getAssociatedTokenAddressSync(mintKey, victim, true, TOKEN_2022_PROGRAM_ID),
        token2022AccountInfo(accountBase({ mint: mintKey, owner: victim, amount: 10_000n, delegate, delegatedAmount: 999n }), [ext.immutableOwner()]),
      );
      const r = evaluatePreflight({ mint: mint2022(), sourceAccount: src, destAccount: account2022(recipient), opts: delegated() });
      expect(r.ok).toBe(false);
      expect(find(r, "INSUFFICIENT_DELEGATED_AMOUNT")).toMatchObject({ severity: "block", data: { delegatedAmount: "999", amount: "1000" } });
    });

    it("AUTHORITY_NOT_DELEGATE blocks when the authority is neither delegate nor permanent delegate", () => {
      const other = Keypair.generate().publicKey;
      const r = evaluatePreflight({ mint: mint2022([ext.permanentDelegate(other)]), sourceAccount: account2022(victim), destAccount: account2022(recipient), opts: delegated() });
      expect(r.ok).toBe(false);
      expect(find(r, "AUTHORITY_NOT_DELEGATE")).toMatchObject({
        severity: "block",
        data: { accountDelegate: null, permanentDelegate: other.toBase58(), sourceOwner: victim.toBase58() },
      });
    });

    it("source absent or undecodable → no authority verdict (SOURCE_ATA_MISSING covers it); authority === owner → nothing", () => {
      const absent = evaluatePreflight({ mint: mint2022(), sourceAccount: null, destAccount: account2022(recipient), opts: delegated() });
      expect(codes(absent)).toEqual(expect.arrayContaining(["SOURCE_ATA_MISSING"]));
      expect(codes(absent)).not.toContain("AUTHORITY_NOT_DELEGATE");
      const undecodable = evaluatePreflight({ mint: mint2022(), sourceAccount: undefined, destAccount: account2022(recipient), opts: delegated() });
      expect(codes(undecodable)).not.toContain("AUTHORITY_NOT_DELEGATE");
      // Owner moving their own funds while someone else pays the fee is standard.
      const ownerSigns = evaluatePreflight({ mint: mint2022(), sourceAccount: account2022(victim), destAccount: account2022(recipient), opts: opts({ payer: delegate, authority: victim, sourceOwner: victim }) });
      expect(codes(ownerSigns)).toEqual(["NON_STANDARD_CONSTRUCTION"]);
    });
  });

  it("legacy SPL mint/accounts: no extension findings", () => {
    const mint = decodeMintAccount(mintKey, legacyMintInfo(mintBase({ decimals: 6 })));
    const ata = (o: PublicKey) => getAssociatedTokenAddressSync(mintKey, o, true, TOKEN_PROGRAM_ID);
    const r = evaluatePreflight({
      mint,
      sourceAccount: decodeTokenAccount(ata(payer.publicKey), legacyAccountInfo(accountBase({ mint: mintKey, owner: payer.publicKey, amount: 5_000n }))),
      destAccount: decodeTokenAccount(ata(recipient), legacyAccountInfo(accountBase({ mint: mintKey, owner: recipient }))),
      opts: opts(),
    });
    expect(r).toMatchObject({ ok: true, findings: [], resolved: { program: "spl-token", destinationAta: ata(recipient).toBase58() } });
  });

  it("helpers: computeTransferFee and pickFeeTier", () => {
    const tier = { epoch: "0", transferFeeBasisPoints: 50, maximumFee: "7" };
    expect(computeTransferFee(0n, tier)).toBe(0n);
    expect(computeTransferFee(1n, tier)).toBe(1n); // ceil(0.005)
    expect(computeTransferFee(10_000n, tier)).toBe(7n); // 50 capped
    expect(computeTransferFee(10_000n, { ...tier, transferFeeBasisPoints: 0 })).toBe(0n);
    const cfg = { olderTransferFee: { ...tier, epoch: "0" }, newerTransferFee: { ...tier, epoch: "9" } };
    expect(pickFeeTier(cfg, 8).which).toBe("older");
    expect(pickFeeTier(cfg, 9n).which).toBe("newer");
    expect(pickFeeTier(cfg, undefined).which).toBe("newer");
  });
});

// --- fetching path + transfer() gating -----------------------------------------

function fakeConn(registry: Map<string, AccountInfo<Buffer>>, epoch = 100) {
  const fake = {
    getAccountInfo: vi.fn().mockImplementation((addr: PublicKey) => Promise.resolve(registry.get(addr.toBase58()) ?? null)),
    getEpochInfo: vi.fn().mockResolvedValue({ epoch, slotIndex: 0, slotsInEpoch: 432_000, absoluteSlot: 1 }),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 9 }),
    sendRawTransaction: vi.fn().mockResolvedValue("SIG_TX"),
    simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: ["ok"], unitsConsumed: 1 } }),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null }, context: { slot: 42 } }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
  };
  const conn = new ClusterConnection({ cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" }, { connection: fake as unknown as Connection });
  return { conn, fake };
}

function registry(o: { mintExt?: TlvEntry[]; source?: AccountInfo<Buffer> | null; dest?: AccountInfo<Buffer> | null }) {
  const reg = new Map<string, AccountInfo<Buffer>>();
  reg.set(mintKey.toBase58(), token2022MintInfo(mintBase({ decimals: 6 }), o.mintExt ?? []));
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mintKey, owner, true, TOKEN_2022_PROGRAM_ID).toBase58();
  const src = o.source === undefined
    ? token2022AccountInfo(accountBase({ mint: mintKey, owner: payer.publicKey, amount: 10_000n }), [ext.immutableOwner()])
    : o.source;
  if (src) reg.set(ata(payer.publicKey), src);
  if (o.dest) reg.set(ata(recipient), o.dest);
  return reg;
}

describe("preflightTransfer (T-C) — fetching", () => {
  it("fetches mint + both ATAs, pulls the epoch only for fee mints, and resolves addresses", async () => {
    const { conn, fake } = fakeConn(registry({}));
    const r = await preflightTransfer(conn, opts());
    expect(r.ok).toBe(true);
    expect(codes(r)).toEqual(["DEST_ATA_MISSING"]);
    expect(fake.getAccountInfo).toHaveBeenCalledTimes(3);
    expect(fake.getEpochInfo).not.toHaveBeenCalled();
    expect(r.resolved?.program).toBe("token-2022");

    const feeMint = registry({
      mintExt: [ext.transferFeeConfig({ configAuthority: auth, withdrawAuthority: auth, withheld: 0n, older: { epoch: 0n, bps: 10, maxFee: 99n }, newer: { epoch: 50n, bps: 20, maxFee: 99n } })],
    });
    const f = fakeConn(feeMint, 100);
    const fr = await preflightTransfer(f.conn, opts({ amount: 10_000n }));
    expect(f.fake.getEpochInfo).toHaveBeenCalledTimes(1);
    expect(find(fr, "TRANSFER_FEE")?.data).toMatchObject({ tier: "newer", expectedFee: "20", epoch: "100" });
    expect(fr.resolved?.epoch).toBe("100");
  });

  it("SOL transfer makes no RPC calls", async () => {
    const { conn, fake } = fakeConn(new Map());
    expect(await preflightTransfer(conn, { payer: payer.publicKey, destination: recipient, amount: 1n })).toEqual({ ok: true, findings: [] });
    expect(fake.getAccountInfo).not.toHaveBeenCalled();
  });

  it("missing mint throws MINT_NOT_FOUND; undecodable accounts degrade to PREFLIGHT_INCOMPLETE warnings", async () => {
    const { conn } = fakeConn(new Map());
    await expect(preflightTransfer(conn, opts())).rejects.toMatchObject({ code: "MINT_NOT_FOUND" });

    // Empty-data mint (the legacy fake-connection shape) → warn, still ok.
    const reg = new Map<string, AccountInfo<Buffer>>([[mintKey.toBase58(), { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(0), lamports: 1, executable: false }]]);
    const r = await preflightTransfer(fakeConn(reg).conn, opts());
    expect(r.ok).toBe(true);
    expect(codes(r)).toEqual(["PREFLIGHT_INCOMPLETE"]);

    // Decodable mint but garbage source account → warn + checks skipped (no balance verdict).
    const r2 = await preflightTransfer(
      fakeConn(registry({ source: { owner: payer.publicKey, data: Buffer.alloc(0), lamports: 1, executable: false } })).conn,
      opts(),
    );
    expect(find(r2, "PREFLIGHT_INCOMPLETE")?.data).toMatchObject({ role: "source" });
    expect(codes(r2)).not.toContain("SOURCE_ATA_MISSING");
    expect(r2.ok).toBe(true);
  });
});

describe("transfer() preflight gating (T-C)", () => {
  const hooked = () => registry({ mintExt: [ext.transferHook(auth, Keypair.generate().publicKey)] });
  const req = (conn: ClusterConnection, extra: Record<string, unknown> = {}) =>
    transfer(conn, { from: payer, destination: recipient, mint: mintKey, amount: 1_000n, decimals: 6, ...extra });

  it("blocked: returns PREFLIGHT_BLOCKED with findings and a best-effort plan; nothing sent", async () => {
    const { conn, fake } = fakeConn(hooked());
    const res = await req(conn);
    expect(res.error).toMatchObject({ code: "PREFLIGHT_BLOCKED" });
    expect(res.error?.message).toContain("TRANSFER_HOOK_PRESENT");
    expect(res.preflight?.ok).toBe(false);
    expect(res.plan?.instructions.map((i) => i.label)).toEqual(["createAssociatedTokenAccountIdempotent", "transferChecked"]);
    expect(res.program).toBe("token-2022");
    expect(res.signature).toBe("");
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
    expect(fake.simulateTransaction).not.toHaveBeenCalled();
  });

  it("blocked + dryRun: same gating, simulatedOnly reflects the request", async () => {
    const { conn, fake } = fakeConn(hooked());
    const res = await req(conn, { dryRun: true });
    expect(res.error?.code).toBe("PREFLIGHT_BLOCKED");
    expect(res.simulatedOnly).toBe(true);
    expect(fake.simulateTransaction).not.toHaveBeenCalled();
  });

  it("blocked and the plan cannot be built → plan omitted, verdict kept", async () => {
    const reg = hooked();
    reg.delete(getAssociatedTokenAddressSync(mintKey, payer.publicKey, true, TOKEN_2022_PROGRAM_ID).toBase58());
    const res = await req(fakeConn(reg).conn);
    expect(res.error?.code).toBe("PREFLIGHT_BLOCKED");
    expect(res.plan).toBeUndefined();
    expect(codes(res.preflight!)).toEqual(expect.arrayContaining(["TRANSFER_HOOK_PRESENT", "SOURCE_ATA_MISSING"]));
  });

  it("force: true sends anyway and still attaches the findings", async () => {
    const { conn, fake } = fakeConn(hooked());
    const res = await req(conn, { force: true });
    expect(res.error).toBeUndefined();
    expect(res.signature).toBe("SIG_TX");
    expect(res.preflight?.ok).toBe(false);
    expect(codes(res.preflight!)).toContain("TRANSFER_HOOK_PRESENT");
    expect(fake.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("skipPreflight: true never reads the mint extensions and attaches no findings", async () => {
    const { conn, fake } = fakeConn(hooked());
    const res = await req(conn, { skipPreflight: true });
    expect(res.error).toBeUndefined();
    expect(res.preflight).toBeUndefined();
    expect(fake.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("ok preflight: result carries info findings and the transfer proceeds", async () => {
    const { conn } = fakeConn(registry({}));
    const res = await req(conn, { dryRun: true });
    expect(res.error).toBeUndefined();
    expect(res.preflight?.ok).toBe(true);
    expect(codes(res.preflight!)).toEqual(["DEST_ATA_MISSING"]);
    expect(res.simulatedOnly).toBe(true);
  });
});
