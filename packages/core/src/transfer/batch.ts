/**
 * Batch transfers (F4.2): split many transfers into transaction-sized
 * batches, send them serially, and aggregate per-recipient results.
 *
 * - estimateTransactionSize(): real wire-size estimate via v0 compilation
 *   + serialization (deterministic placeholder blockhash).
 * - splitIntoBatches(): pure double-constrained splitter — instruction
 *   count first, serialized byte budget second. No items lost, none
 *   duplicated, input order preserved.
 * - executeBatchTransfer(): compile per batch (fresh blockhash) →
 *   optional dry-run → sendWithRetry, confirming each batch before the
 *   next one starts. Failures are reported per item, never thrown.
 */
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import type { ClusterConnection, ConfirmPolicy } from "../connection/connection.js";
import { SolwalletError, TransactionSendError } from "../connection/errors.js";
import { parseTransactionError, type ParsedProgramError } from "../utils/parse-error.js";
import { dryRun as simulateTx } from "./dryrun.js";

/** Hard on-chain limit: a serialized transaction must fit in 1232 bytes. */
export const MAX_TX_BYTES = 1232;

/**
 * Headroom subtracted from MAX_TX_BYTES for the byte budget. The estimate
 * already counts signatures + message header, so this margin only guards
 * against small accounting drift (future v0 extensions, per-ix metadata).
 */
export const DEFAULT_HEADROOM_BYTES = 200;

/** Default size budget: 1232 − 200 = 1032 estimated bytes per batch tx. */
export const DEFAULT_SIZE_BUDGET_BYTES = MAX_TX_BYTES - DEFAULT_HEADROOM_BYTES;

/** Default cap on instructions per batch transaction. */
export const DEFAULT_MAX_INSTRUCTIONS_PER_TX = 8;

/**
 * Estimate the serialized wire size of a transaction carrying
 * `instructions`, compiled as a static v0 message.
 *
 * The placeholder blockhash (default: 32 zero bytes — the same 32-byte slot
 * a real blockhash occupies) makes the result deterministic. Signature count
 * follows the compiled message header: payer-only transfer instructions
 * require exactly 1 signature, and extra instruction signers (e.g. multisig
 * PDAs marked as signers) are counted automatically since the serialization
 * includes 64 bytes per required signer. No address-lookup tables are used,
 * so for the batch/mixed use case this equals the real transaction size.
 */
export function estimateTransactionSize(
  payerKey: PublicKey,
  instructions: readonly TransactionInstruction[],
  recentBlockhashPlaceholder: PublicKey = PublicKey.default,
): number {
  try {
    const message = new TransactionMessage({
      payerKey,
      recentBlockhash: recentBlockhashPlaceholder.toBase58(),
      instructions: [...instructions],
    }).compileToV0Message();
    // serialize() = compact-u16 signature count + 64 bytes per required
    // signer (zero-filled) + serialized message — exactly what sendRaw
    // receives once signed.
    return new VersionedTransaction(message).serialize().length;
  } catch {
    // web3.js serialization uses fixed-size internal buffers and crashes on
    // pathologically large instructions. Fall back to an exact hand-rolled
    // byte formula (v0 layout: signatures + header + keys + blockhash + ixs)
    // so oversized items still measure as oversized instead of throwing.
    return manualSizeEstimate(payerKey, instructions);
  }
}

/** Conservative hand-rolled v0 wire size — never throws. */
function manualSizeEstimate(
  payerKey: PublicKey,
  instructions: readonly TransactionInstruction[],
): number {
  // Signature section: compact-u16 count + 64 zero bytes per signer (payer).
  let size = 1 + 64;
  // Message header (3) + account-key count (compact, ≤3 bytes here).
  size += 3 + 3;
  // Deduplicated static account keys.
  const keys = new Set<string>([payerKey.toBase58()]);
  for (const ix of instructions) {
    for (const key of ix.keys) keys.add(key.pubkey.toBase58());
    keys.add(ix.programId.toBase58());
  }
  size += keys.size * 32;
  size += 32; // recent blockhash
  for (const ix of instructions) {
    size += 1; // program id index
    size += compactU16Length(ix.keys.length);
    size += ix.keys.length; // one account index byte each
    size += compactU16Length(ix.data.length);
    size += ix.data.length;
  }
  return size;
}

/** Byte length of the compact-u16 encoding of `value`. */
function compactU16Length(value: number): number {
  if (value < 128) return 1;
  if (value < 16384) return 2;
  return 3;
}

/** One planned transfer: its recipient and its full instruction group. */
export interface BatchItem {
  /** Recipient — echoed back in results (SOL address or token owner). */
  destination: PublicKey;
  /** Instructions for THIS transfer: 1 for SOL, 1–2 for tokens (ATA creation). */
  instructions: TransactionInstruction[];
}

/** A batch of transfers that shares one transaction. */
export interface Batch {
  items: BatchItem[];
  instructions: TransactionInstruction[];
  estimatedBytes: number;
}

export interface BatchSplitOptions {
  /** Fee payer — required because size depends on the compiled message. */
  payerKey: PublicKey;
  /** Cap on instructions per transaction. Default 8. */
  maxInstructionsPerTx?: number;
  /** Cap on estimated serialized bytes per transaction. Default 1032. */
  sizeBudgetBytes?: number;
  /** Deterministic blockhash used for estimation. Default: 32 zero bytes. */
  recentBlockhashPlaceholder?: PublicKey;
}

/**
 * Pure splitter: cut `items` into batches under BOTH constraints —
 * instruction count (`maxInstructionsPerTx`) first, then serialized size
 * (`sizeBudgetBytes`, evaluated by accumulating estimateTransactionSize).
 *
 * Policy for an item that alone violates a cap: it becomes its own
 * (oversized) batch rather than being dropped or silently split — the
 * caller sees it via `estimatedBytes` and the send attempt reports the
 * on-chain rejection. Order is preserved; every item lands in exactly
 * one batch.
 */
export function splitIntoBatches(
  items: readonly BatchItem[],
  opts: BatchSplitOptions,
): Batch[] {
  const maxInstructions = opts.maxInstructionsPerTx ?? DEFAULT_MAX_INSTRUCTIONS_PER_TX;
  const budget = opts.sizeBudgetBytes ?? DEFAULT_SIZE_BUDGET_BYTES;
  if (maxInstructions < 1) {
    throw new SolwalletError(`maxInstructionsPerTx must be ≥ 1, got ${maxInstructions}.`, {
      code: "BATCH_OPTIONS_INVALID",
    });
  }
  if (budget < 1) {
    throw new SolwalletError(`sizeBudgetBytes must be ≥ 1, got ${budget}.`, {
      code: "BATCH_OPTIONS_INVALID",
    });
  }

  const batches: Batch[] = [];
  let pendingItems: BatchItem[] = [];
  let pendingInstructions: TransactionInstruction[] = [];

  const flush = (): void => {
    if (pendingItems.length === 0) return;
    batches.push({
      items: pendingItems,
      instructions: pendingInstructions,
      estimatedBytes: estimateTransactionSize(
        opts.payerKey,
        pendingInstructions,
        opts.recentBlockhashPlaceholder,
      ),
    });
    pendingItems = [];
    pendingInstructions = [];
  };

  for (const item of items) {
    const combinedLength = pendingInstructions.length + item.instructions.length;
    const exceedsCount = pendingItems.length > 0 && combinedLength > maxInstructions;
    const exceedsBytes =
      pendingItems.length > 0 &&
      estimateTransactionSize(opts.payerKey, [...pendingInstructions, ...item.instructions], opts.recentBlockhashPlaceholder) >
        budget;
    if (exceedsCount || exceedsBytes) flush();

    pendingItems.push(item);
    pendingInstructions = [...pendingInstructions, ...item.instructions];

    // A lone item that violates either cap on its own: flush as an
    // oversized standalone batch (see JSDoc policy note).
    if (
      pendingInstructions.length > maxInstructions ||
      estimateTransactionSize(opts.payerKey, pendingInstructions, opts.recentBlockhashPlaceholder) > budget
    ) {
      flush();
    }
  }
  flush();
  return batches;
}

/** Result of one planned transfer inside a batch. */
export interface BatchItemResult {
  /** Recipient (base58) — mirrors BatchItem.destination. */
  to: string;
  status: "success" | "failed" | "skipped";
  /** Set on success (and best-effort on failure when the RPC disclosed it). */
  signature?: string;
  /** Parsed failure ({code, message, suggestion}) — reported, never thrown. */
  error?: ParsedProgramError;
}

/** Result of one sent (or skipped) batch. */
export interface BatchResult {
  /** Zero-based position of this batch in the split sequence. */
  batchIndex: number;
  estimatedBytes: number;
  /** Transaction signatures observed for this batch ([] when skipped/simulated). */
  signatures: string[];
  /** Confirmation slot (absent when skipped or dry-run). */
  slot?: number;
  /** Fee in lamports (absent when skipped or dry-run). */
  feeLamports?: number;
  /** Simulation logs (dryRun batches only). */
  logs?: string[];
  /** Per-recipient results, same order as the batch's items. */
  results: BatchItemResult[];
}

export interface BatchTransferOptions {
  /** Cap on instructions per transaction. Default 8. */
  maxInstructionsPerTx?: number;
  /** Cap on estimated serialized bytes per transaction. Default 1032. */
  sizeBudgetBytes?: number;
  /**
   * "stop" (default): abort after the first failed batch — every remaining
   * batch is reported as skipped. "continue": keep sending later batches.
   */
  onFailure?: "stop" | "continue";
  /** Simulate each batch against cluster state; nothing is sent. */
  dryRun?: boolean;
  /** Explicit mainnet confirmation, forwarded to sendWithRetry. */
  allowMainnet?: boolean;
  /** Confirm/retry policy override forwarded to sendWithRetry. */
  policy?: Partial<ConfirmPolicy>;
  /** Idle between confirmed batches (rate-limit friendly pacing). Default 0. */
  interBatchDelayMs?: number;
}

/**
 * Execute a batch transfer: split → compile per batch (fresh blockhash each
 * time) → sendWithRetry, strictly serial (each batch is confirmed before the
 * next one is sent). Returns one BatchResult per batch; item-level failures
 * are parsed into structured errors instead of throwing.
 */
export async function executeBatchTransfer(
  conn: ClusterConnection,
  from: Keypair,
  items: readonly BatchItem[],
  opts: BatchTransferOptions = {},
): Promise<BatchResult[]> {
  const onFailure = opts.onFailure ?? "stop";
  const batches = splitIntoBatches(items, {
    payerKey: from.publicKey,
    maxInstructionsPerTx: opts.maxInstructionsPerTx,
    sizeBudgetBytes: opts.sizeBudgetBytes,
  });

  const out: BatchResult[] = [];
  let stopped = false;

  for (const [batchIndex, batch] of batches.entries()) {
    if (stopped) {
      out.push({
        batchIndex,
        estimatedBytes: batch.estimatedBytes,
        signatures: [],
        results: batch.items.map((item) => ({
          to: item.destination.toBase58(),
          status: "skipped",
        })),
      });
      continue;
    }

    if (batchIndex > 0 && opts.interBatchDelayMs !== undefined && opts.interBatchDelayMs > 0) {
      await sleep(opts.interBatchDelayMs);
    }

    // Fresh blockhash per batch: earlier confirmations may have consumed
    // most of the previous one's validity window.
    const { blockhash, lastValidBlockHeight } = await conn.connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: from.publicKey,
      recentBlockhash: blockhash,
      instructions: batch.instructions,
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([from]);

    if (opts.dryRun) {
      const sim = await simulateTx(conn, tx);
      const results: BatchItemResult[] = batch.items.map((item) => ({
        to: item.destination.toBase58(),
        status: "success",
      }));
      if (!sim.ok) {
        const parsed = parseTransactionError({
          message: `Transaction simulation failed: ${JSON.stringify(sim.err)}`,
          logs: sim.logs,
        });
        for (const r of results) {
          r.status = "failed";
          r.error = parsed;
        }
        if (onFailure === "stop") stopped = true;
      }
      out.push({
        batchIndex,
        estimatedBytes: batch.estimatedBytes,
        signatures: [],
        logs: sim.logs,
        results,
      });
      continue;
    }

    try {
      const sent = await conn.sendWithRetry(tx, {
        lastValidBlockHeight,
        allowMainnet: opts.allowMainnet,
        policy: opts.policy,
      });
      out.push({
        batchIndex,
        estimatedBytes: batch.estimatedBytes,
        signatures: [sent.signature],
        slot: sent.slot,
        feeLamports: sent.feeLamports,
        results: batch.items.map((item) => ({
          to: item.destination.toBase58(),
          status: "success",
          signature: sent.signature,
        })),
      });
    } catch (error) {
      const parsed = parseTransactionError(error);
      const signature =
        error instanceof TransactionSendError ? error.signature : undefined;
      out.push({
        batchIndex,
        estimatedBytes: batch.estimatedBytes,
        signatures: signature !== undefined ? [signature] : [],
        results: batch.items.map((item) => ({
          to: item.destination.toBase58(),
          status: "failed",
          signature,
          error: parsed,
        })),
      });
      if (onFailure === "stop") stopped = true;
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
