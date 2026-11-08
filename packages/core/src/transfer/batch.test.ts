/**
 * Batch transfer tests (6.1–6.3, 6.5): size estimation vs real
 * serialization, splitting invariants (no loss / no duplication, both
 * caps), serial sending order, stop/continue failure semantics.
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction as Instruction,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { ClusterConnection } from "../connection/connection.js";
import {
  DEFAULT_MAX_INSTRUCTIONS_PER_TX,
  DEFAULT_SIZE_BUDGET_BYTES,
  MAX_TX_BYTES,
  estimateTransactionSize,
  executeBatchTransfer,
  splitIntoBatches,
  type BatchItem,
} from "./batch.js";

// ---------------------------------------------------------------------------
// Fake connection: deterministic RPC, per-call signatures (SIG_1, SIG_2, …).
// ---------------------------------------------------------------------------

function fakeConn(opts: { sendRawTransaction?: (call: number) => Promise<string> } = {}) {
  let call = 0;
  const fake = {
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 999,
    }),
    sendRawTransaction: vi.fn().mockImplementation(() => {
      call++;
      return opts.sendRawTransaction ? opts.sendRawTransaction(call) : Promise.resolve(`SIG_${call}`);
    }),
    simulateTransaction: vi.fn().mockResolvedValue({
      value: { err: null, logs: ["Program log: Simulated ok"], unitsConsumed: 100 },
    }),
    confirmTransaction: vi
      .fn()
      .mockResolvedValue({ value: { err: null }, context: { slot: 42 } }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
  };
  const conn = new ClusterConnection(
    { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" },
    { connection: fake as unknown as Connection },
  );
  return { conn, fake };
}

const payer = Keypair.generate();

/** One SOL transfer item (1 instruction). */
function solItem(destination?: PublicKey): BatchItem {
  return {
    destination: destination ?? Keypair.generate().publicKey,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: destination ?? Keypair.generate().publicKey,
        lamports: 1000,
      }),
    ],
  };
}

/** A fat mock instruction (~350+ encoded bytes), unique destination per item. */
function fatItem(): BatchItem {
  const destination = Keypair.generate().publicKey; // unique — Set-based assertions need distinct recipients
  return {
    destination,
    instructions: [
      new TransactionInstruction({
        programId: SystemProgram.programId,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: destination, isSigner: false, isWritable: true },
        ],
        data: Buffer.alloc(320, 1),
      }),
    ],
  };
}

describe("estimateTransactionSize (6.1)", () => {
  it("matches the real serialized transaction byte-for-byte", () => {
    const ixs: Instruction[] = [0, 1, 2].map(() =>
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1000,
      }),
    );
    const placeholder = Keypair.generate().publicKey; // 32-byte deterministic stand-in
    const estimated = estimateTransactionSize(payer.publicKey, ixs, placeholder);
    const real = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: placeholder.toBase58(),
        instructions: ixs,
      }).compileToV0Message(),
    ).serialize().length;
    expect(estimated).toBe(real);
    expect(estimated).toBeLessThanOrEqual(MAX_TX_BYTES);
  });

  it("empty instructions → header-only positive size", () => {
    const size = estimateTransactionSize(payer.publicKey, []);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(200); // signatures + header + blockhash only
  });

  it("grows with each added instruction and reports MAX_TX_BYTES", () => {
    const one = estimateTransactionSize(payer.publicKey, solItem().instructions);
    const five = estimateTransactionSize(
      payer.publicKey,
      Array.from({ length: 5 }, () => solItem().instructions).flat(),
    );
    expect(five).toBeGreaterThan(one);
    expect(MAX_TX_BYTES).toBe(1232);
  });
});

describe("splitIntoBatches (6.2)", () => {
  it("1000 recipients: count cap dominates, no loss, no duplication", () => {
    const items = Array.from({ length: 1000 }, () => solItem());
    const batches = splitIntoBatches(items, { payerKey: payer.publicKey });

    expect(batches.length).toBe(Math.ceil(1000 / DEFAULT_MAX_INSTRUCTIONS_PER_TX)); // 125
    for (const b of batches) {
      expect(b.instructions.length).toBeLessThanOrEqual(DEFAULT_MAX_INSTRUCTIONS_PER_TX);
      expect(b.estimatedBytes).toBeLessThanOrEqual(DEFAULT_SIZE_BUDGET_BYTES);
      expect(b.estimatedBytes).toBeLessThanOrEqual(MAX_TX_BYTES);
    }
    // Only the tail batch may be partial.
    for (const b of batches.slice(0, -1)) expect(b.items.length).toBe(DEFAULT_MAX_INSTRUCTIONS_PER_TX);

    // Set equality: every recipient exactly once.
    const sent = batches.flatMap((b) => b.items.map((i) => i.destination.toBase58()));
    expect(sent.length).toBe(1000);
    expect(new Set(sent).size).toBe(1000);
    for (const item of items) {
      expect(sent).toContain(item.destination.toBase58());
    }
  });

  it("byte budget binds before the instruction cap (fat mock instructions)", () => {
    // Each fat item ≈ 457 B serialized; 2 fit in 1032 B, 3 do not — while the
    // 8-instruction cap would have allowed 8. Same extra account everywhere →
    // message account keys dedupe → deterministic sizes.
    const items = Array.from({ length: 12 }, () => fatItem());
    const batches = splitIntoBatches(items, { payerKey: payer.publicKey });

    expect(batches.length).toBe(6); // count-cap math would predict only 2
    for (const b of batches) {
      expect(b.items.length).toBe(2);
      expect(b.estimatedBytes).toBeLessThanOrEqual(DEFAULT_SIZE_BUDGET_BYTES);
      expect(b.estimatedBytes).toBeGreaterThan(700);
    }
    const sent = batches.flatMap((b) => b.items.map((i) => i.destination.toBase58()));
    expect(new Set(sent).size).toBe(12);
  });

  it("a lone item over budget becomes its own oversized batch", () => {
    const huge: BatchItem = {
      destination: Keypair.generate().publicKey,
      instructions: [
        new TransactionInstruction({
          programId: SystemProgram.programId,
          keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
          data: Buffer.alloc(1400, 7),
        }),
      ],
    };
    const batches = splitIntoBatches([huge, solItem()], { payerKey: payer.publicKey });
    expect(batches.length).toBe(2);
    expect(batches[0]!.items.length).toBe(1);
    expect(batches[0]!.estimatedBytes).toBeGreaterThan(DEFAULT_SIZE_BUDGET_BYTES);
    expect(batches[1]!.estimatedBytes).toBeLessThanOrEqual(DEFAULT_SIZE_BUDGET_BYTES);
  });

  it("rejects maxInstructionsPerTx < 1 (14.2 boundary)", () => {
    expect(() =>
      splitIntoBatches([solItem()], { payerKey: payer.publicKey, maxInstructionsPerTx: 0 }),
    ).toThrowError(/maxInstructionsPerTx must be/);
    expect(() =>
      splitIntoBatches([solItem()], { payerKey: payer.publicKey, maxInstructionsPerTx: -1 }),
    ).toThrowError(/maxInstructionsPerTx must be/);
  });

  it("rejects sizeBudgetBytes < 1 (14.2 boundary)", () => {
    expect(() =>
      splitIntoBatches([solItem()], { payerKey: payer.publicKey, sizeBudgetBytes: 0 }),
    ).toThrowError(/sizeBudgetBytes must be/);
  });

  it("empty item list → empty batch list (14.2 boundary)", () => {
    expect(splitIntoBatches([], { payerKey: payer.publicKey })).toEqual([]);
  });

  it("single item → exactly one batch (14.2 boundary)", () => {
    const batches = splitIntoBatches([solItem()], { payerKey: payer.publicKey });
    expect(batches.length).toBe(1);
    expect(batches[0]!.items.length).toBe(1);
  });

  it("exact division (count cap) → no partial tail batch (14.2 boundary)", () => {
    const items = Array.from({ length: 16 }, () => solItem()); // 16 / 8 = 2 exactly
    const batches = splitIntoBatches(items, {
      payerKey: payer.publicKey,
      maxInstructionsPerTx: 8,
    });
    expect(batches.length).toBe(2);
    for (const b of batches) expect(b.items.length).toBe(8);
  });

  it("custom caps are honored (small explicit budget)", () => {
    const items = Array.from({ length: 20 }, () => solItem());
    const batches = splitIntoBatches(items, { payerKey: payer.publicKey, sizeBudgetBytes: 300 });
    // Byte cap binds hard: far more batches than ceil(20/8) = 3.
    expect(batches.length).toBeGreaterThan(5);
    for (const b of batches) expect(b.estimatedBytes).toBeLessThanOrEqual(300);
    const sent = batches.flatMap((b) => b.items.map((i) => i.destination.toBase58()));
    expect(new Set(sent).size).toBe(20);
  });
});

describe("executeBatchTransfer (6.3, 6.5)", () => {
  const items30 = Array.from({ length: 30 }, () => solItem());

  it("sends batches strictly serially, fresh blockhash each, aggregates results", async () => {
    const { conn, fake } = fakeConn();
    const batches = await executeBatchTransfer(conn, payer, items30, {
      maxInstructionsPerTx: 5,
    });

    expect(batches.length).toBe(6);
    expect(fake.sendRawTransaction).toHaveBeenCalledTimes(6);
    // 1 per batch: the blockhash (+ its lastValidBlockHeight) fetched for the
    // message is the one confirmation is judged against — never a fresh one.
    expect(fake.getLatestBlockhash).toHaveBeenCalledTimes(6);
    // Per-call signatures prove ordering: batch i got SIG_i+1.
    batches.forEach((b, i) => {
      expect(b.signatures).toEqual([`SIG_${i + 1}`]);
      expect(b.slot).toBe(42);
      expect(b.feeLamports).toBe(5000);
      expect(b.results.every((r) => r.status === "success" && r.signature === `SIG_${i + 1}`)).toBe(true);
    });
    // Result array completeness: 30 recipients, each exactly once.
    const all = batches.flatMap((b) => b.results.map((r) => r.to));
    expect(all.length).toBe(30);
    expect(new Set(all).size).toBe(30);
    const inputSet = new Set(items30.map((i) => i.destination.toBase58()));
    for (const to of all) expect(inputSet.has(to)).toBe(true);
  });

  it("onFailure=stop: batch 2 fails → its items failed, the rest skipped", async () => {
    const { conn, fake } = fakeConn({
      sendRawTransaction: (call) =>
        call === 2
          ? Promise.reject(new Error("Error: insufficient funds for rent"))
          : Promise.resolve(`SIG_${call}`),
    });
    const batches = await executeBatchTransfer(conn, payer, items30, {
      maxInstructionsPerTx: 5,
    });

    expect(fake.sendRawTransaction).toHaveBeenCalledTimes(2); // aborted after the failure
    expect(batches.length).toBe(6);
    expect(batches[0]!.results.every((r) => r.status === "success")).toBe(true);
    expect(batches[1]!.results.every((r) => r.status === "failed")).toBe(true);
    expect(batches[1]!.results[0]!.error?.code).toBe("INSUFFICIENT_FUNDS");
    for (const b of batches.slice(2)) {
      expect(b.results.every((r) => r.status === "skipped")).toBe(true);
      expect(b.signatures).toEqual([]);
    }
    // Every recipient still accounted for exactly once.
    const all = batches.flatMap((b) => b.results.map((r) => r.to));
    expect(all.length).toBe(30);
    expect(new Set(all).size).toBe(30);
  });

  it("onFailure=continue: failed batch reported, later batches still sent", async () => {
    const { conn, fake } = fakeConn({
      sendRawTransaction: (call) =>
        call === 2
          ? Promise.reject(new Error("Error: insufficient funds for rent"))
          : Promise.resolve(`SIG_${call}`),
    });
    const batches = await executeBatchTransfer(conn, payer, items30, {
      maxInstructionsPerTx: 5,
      onFailure: "continue",
    });

    expect(fake.sendRawTransaction).toHaveBeenCalledTimes(6);
    expect(batches[1]!.results.every((r) => r.status === "failed")).toBe(true);
    for (const [i, b] of batches.entries()) {
      if (i === 1) continue;
      expect(b.results.every((r) => r.status === "success")).toBe(true);
      expect(b.signatures).toEqual([`SIG_${i + 1}`]);
    }
    expect(batches.every((b) => b.results.length === 5)).toBe(true);
  });

  it("dryRun: simulates every batch, never sends", async () => {
    const { conn, fake } = fakeConn();
    const batches = await executeBatchTransfer(conn, payer, items30, {
      maxInstructionsPerTx: 5,
      dryRun: true,
    });
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
    expect(fake.simulateTransaction).toHaveBeenCalledTimes(6);
    expect(batches.length).toBe(6);
    for (const b of batches) {
      expect(b.signatures).toEqual([]);
      expect(b.slot).toBeUndefined();
      expect(b.logs?.length).toBeGreaterThan(0);
      expect(b.results.every((r) => r.status === "success")).toBe(true);
    }
  });

  it("dryRun failure: items failed with parsed error, stop marks the rest skipped", async () => {
    const { conn, fake } = fakeConn();
    fake.simulateTransaction.mockResolvedValue({
      value: { err: { InstructionError: [0, { Custom: 1 }] }, logs: ["Program log: boom"] },
    });
    const batches = await executeBatchTransfer(conn, payer, items30, {
      maxInstructionsPerTx: 5,
      dryRun: true,
    });
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
    expect(batches[0]!.results.every((r) => r.status === "failed")).toBe(true);
    expect(batches[0]!.results[0]!.error?.code).toBe("SIMULATION_FAILED");
    for (const b of batches.slice(1)) {
      expect(b.results.every((r) => r.status === "skipped")).toBe(true);
    }
  });
});
