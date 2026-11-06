/**
 * Transaction dry-run: simulate without spending (F4.5).
 */
import type { VersionedTransaction } from "@solana/web3.js";

import type { ClusterConnection } from "../connection/connection.js";

export interface DryRunResult {
  ok: boolean;
  /** Full program logs — the primary debugging artifact. */
  logs: string[];
  /** Compute units the transaction consumed, when reported. */
  unitsConsumed?: number;
  /** Raw on-chain error (null when ok). */
  err: unknown;
}

/** Simulate a fully-signed transaction against current cluster state. */
export async function dryRun(
  conn: ClusterConnection,
  tx: VersionedTransaction,
): Promise<DryRunResult> {
  const result = await conn.connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  return {
    ok: result.value.err === null,
    logs: result.value.logs ?? [],
    unitsConsumed: result.value.unitsConsumed ?? undefined,
    err: result.value.err,
  };
}
