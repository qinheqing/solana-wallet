/**
 * PRD T-F tests: TOKEN_PRESETS resolve for every preset, payer-dependent
 * defaults, override precedence, and createFromPreset dispatch + mintTo.
 */
import { ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMintLen } from "@solana/spl-token";
import { Keypair, PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { ClusterConnection } from "../connection/connection.js";
import {
  TOKEN_PRESETS,
  TRANSFER_HOOK_PLACEHOLDER_PROGRAM_ID,
  createFromPreset,
  isTokenPresetName,
  resolvePreset,
  type TokenPresetName,
} from "./presets.js";

const payer = Keypair.generate();

function recordingConn() {
  const txs: VersionedTransaction[] = [];
  const fake = {
    getAccountInfo: vi.fn().mockImplementation((addr: PublicKey) =>
      // mints created in this test file are "owned" by Token-2022 once sent
      Promise.resolve(created.has(addr.toBase58()) ? { owner: created.get(addr.toBase58()), data: Buffer.alloc(0) } : null),
    ),
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 999,
    }),
    sendRawTransaction: vi.fn().mockImplementation((raw: Uint8Array) => {
      const tx = VersionedTransaction.deserialize(raw);
      txs.push(tx);
      return Promise.resolve(`SIG_${txs.length}`);
    }),
    simulateTransaction: vi.fn().mockResolvedValue({
      value: { err: null, logs: ["Program log: ok"], unitsConsumed: 2000 },
    }),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null }, context: { slot: 7 } }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
    getMinimumBalanceForRentExemption: vi.fn().mockResolvedValue(1_500_000),
  };
  const created = new Map<string, PublicKey>();
  const conn = new ClusterConnection(
    { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" },
    { connection: fake as unknown as Connection },
  );
  return { conn, fake, txs, created };
}

function programOf(tx: VersionedTransaction, ixIndex: number): PublicKey {
  const ci = tx.message.compiledInstructions[ixIndex]!;
  return tx.message.staticAccountKeys[ci.programIdIndex]!;
}

describe("TOKEN_PRESETS / resolvePreset (T-F)", () => {
  const names = Object.keys(TOKEN_PRESETS) as TokenPresetName[];

  it("covers the seven PRD presets, each with description + notes", () => {
    expect(names.sort()).toEqual(
      ["legacy-spl", "memo-required", "permanent-delegate", "plain-2022", "scaled-ui", "transfer-fee", "transfer-hook"].sort(),
    );
    for (const name of names) {
      const p = TOKEN_PRESETS[name];
      expect(p.name).toBe(name);
      expect(p.description.length).toBeGreaterThan(10);
      expect(p.notes.length).toBeGreaterThan(0);
      expect(isTokenPresetName(name)).toBe(true);
    }
    expect(isTokenPresetName("nope")).toBe(false);
  });

  it("every preset resolves to concrete options with decimals", () => {
    for (const name of names) {
      const r = resolvePreset(name, {}, { payer });
      expect(r.preset).toBe(name);
      expect(r.options.decimals).toBe(9);
      expect(r.program).toBe(TOKEN_PRESETS[name].program);
      if (r.program === "spl-token") expect(r.options.extensions).toBeUndefined();
    }
  });

  it("preset-specific defaults: fee 0/0, delegate = payer, multiplier 1.5, hook placeholder", () => {
    expect(resolvePreset("transfer-fee", {}, { payer }).options.extensions).toEqual({
      transferFeeConfig: { transferFeeBasisPoints: 0, maximumFee: 0n },
    });
    const pd = resolvePreset("permanent-delegate", {}, { payer }).options.extensions!.permanentDelegate!;
    expect((pd.delegate as PublicKey).equals(payer.publicKey)).toBe(true);
    expect(resolvePreset("scaled-ui", {}, { payer }).options.extensions).toEqual({ scaledUiAmount: { multiplier: 1.5 } });
    const hook = resolvePreset("transfer-hook", {}, { payer }).options.extensions!.transferHook!;
    expect(hook.programId).toEqual(TRANSFER_HOOK_PLACEHOLDER_PROGRAM_ID);
    expect(TRANSFER_HOOK_PLACEHOLDER_PROGRAM_ID.equals(PublicKey.default)).toBe(true);
    expect(resolvePreset("memo-required", {}, { payer }).notes.join(" ")).toMatch(/enableMemoTransfer/);
    expect(resolvePreset("plain-2022", {}, { payer }).options.extensions).toBeUndefined();
  });

  it("explicit overrides win over preset defaults (per-extension replace)", () => {
    const other = Keypair.generate().publicKey;
    const r = resolvePreset(
      "transfer-fee",
      {
        decimals: 6,
        dryRun: true,
        extensions: { transferFeeConfig: { transferFeeBasisPoints: 250, maximumFee: 10n }, permanentDelegate: { delegate: other } },
      },
      { payer },
    );
    expect(r.options.decimals).toBe(6);
    expect(r.options.dryRun).toBe(true);
    expect(r.options.extensions).toEqual({
      transferFeeConfig: { transferFeeBasisPoints: 250, maximumFee: 10n },
      permanentDelegate: { delegate: other },
    });
    // program override drops extensions for spl-token
    expect(resolvePreset("transfer-fee", { program: "spl-token" }, { payer }).options.extensions).toBeUndefined();
  });

  it("unknown preset → PRESET_UNKNOWN", () => {
    expect(() => resolvePreset("bogus" as TokenPresetName, {}, { payer })).toThrow(
      expect.objectContaining({ code: "PRESET_UNKNOWN" }),
    );
  });
});

describe("createFromPreset (T-F)", () => {
  it("legacy-spl dispatches to the SPL Token program", async () => {
    const { conn, txs } = recordingConn();
    const r = await createFromPreset(conn, payer, "legacy-spl");
    expect(r.preset).toBe("legacy-spl");
    expect(r.tokenProgram).toBe("spl-token");
    expect(r.extensions).toEqual([]);
    expect(programOf(txs[0]!, 1).equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(r.mintTo).toBeUndefined();
  });

  it("scaled-ui dispatches to Token-2022 with the ScaledUiAmount space + instruction", async () => {
    const { conn, txs, fake } = recordingConn();
    const r = await createFromPreset(conn, payer, "scaled-ui");
    expect(r.tokenProgram).toBe("token-2022");
    expect(r.extensions).toEqual(["scaledUiAmount"]);
    expect(fake.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(getMintLen([ExtensionType.ScaledUiAmountConfig]));
    expect(programOf(txs[0]!, 1).equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(r.notes.join(" ")).toMatch(/Display-only/);
  });

  it("mintTo mints right after creation (second tx, ATA created) and returns both signatures", async () => {
    const { conn, txs, created } = recordingConn();
    const owner = Keypair.generate().publicKey;
    // After the creation tx is sent, the fake registry knows the new mint.
    conn.connection.sendRawTransaction = vi.fn().mockImplementation((raw: Uint8Array) => {
      const tx = VersionedTransaction.deserialize(raw);
      txs.push(tx);
      if (txs.length === 1) created.set(tx.message.staticAccountKeys[1]!.toBase58(), TOKEN_2022_PROGRAM_ID);
      return Promise.resolve(`SIG_${txs.length}`);
    }) as unknown as Connection["sendRawTransaction"];

    const r = await createFromPreset(conn, payer, "plain-2022", { mintTo: { owner, amount: 1_000n } });
    expect(r.signature).toBe("SIG_1");
    expect(r.mintTo).toMatchObject({ signature: "SIG_2", owner: owner.toBase58(), amount: "1000" });
    expect(txs).toHaveLength(2);
    const mintTx = txs[1]!;
    expect(mintTx.message.compiledInstructions).toHaveLength(2); // createATA + mintTo
    const last = mintTx.message.compiledInstructions[1]!;
    expect(Buffer.from(last.data)[0]).toBe(7); // MintTo
    expect(Buffer.from(last.data).readBigUInt64LE(1)).toBe(1_000n);
  });

  it("mintTo is skipped on dryRun (mint does not exist on chain)", async () => {
    const { conn, txs } = recordingConn();
    const r = await createFromPreset(conn, payer, "plain-2022", {
      dryRun: true,
      mintTo: { owner: payer.publicKey, amount: 5n },
    });
    expect(r.simulatedOnly).toBe(true);
    expect(r.mintTo).toBeUndefined();
    expect(txs).toHaveLength(0);
  });
});
