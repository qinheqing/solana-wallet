/**
 * transfer() — the single-transfer orchestration (F4.1/F4.5/F4.6):
 * identify program → build instructions (+ATA) → optional dry-run →
 * sign & send (mainnet-guarded) → assemble TransferResult.
 *
 * Errors are returned (not thrown) as parsed {code, suggestion} objects so
 * MCP/AI callers can react programmatically to failures.
 */
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import type { ClusterConnection } from "../connection/connection.js";
import type { ConfirmPolicy } from "../connection/connection.js";
import { TransactionSendError } from "../connection/errors.js";
import { parseTransactionError, type ParsedProgramError } from "../utils/parse-error.js";
import { dryRun } from "./dryrun.js";
import { buildTransferInstructions } from "./build.js";
import type { TokenProgramKind } from "./program.js";

export interface TransferRequest {
  /** Fee payer & source-of-funds owner. */
  from: Keypair;
  /** SOL recipient, or the owner receiving tokens at their ATA. */
  destination: string | PublicKey;
  /** Omit for native SOL. */
  mint?: string | PublicKey;
  /** Base units (lamports / token base units). */
  amount: bigint;
  /** Required when `mint` is set. */
  decimals?: number;
  /** Auto-create destination ATA. Default: true. */
  allowAtaCreation?: boolean;
  /** Simulate only — nothing is sent on chain. */
  dryRun?: boolean;
  /** Explicit mainnet confirmation, forwarded to sendWithRetry. */
  allowMainnet?: boolean;
  /** Confirm/retry policy override forwarded to sendWithRetry. */
  policy?: Partial<ConfirmPolicy>;
}

export interface TransferResult {
  /** Empty for simulated transfers. */
  signature: string;
  slot: number;
  /** Fee in lamports (0 for simulations). */
  feeLamports: number;
  program: "system" | TokenProgramKind;
  /** Destination ATA creation was included in this transaction. */
  destinationAtaCreated: boolean;
  /** Populated by dryRun: full simulation logs. */
  logs?: string[];
  unitsConsumed?: number;
  simulatedOnly: boolean;
  /** Parsed failure — set instead of throwing, for AI-friendly flows. */
  error?: ParsedProgramError;
}

export async function transfer(
  conn: ClusterConnection,
  req: TransferRequest,
): Promise<TransferResult> {
  const destination =
    typeof req.destination === "string"
      ? new PublicKey(req.destination)
      : req.destination;
  const mint = req.mint
    ? typeof req.mint === "string"
      ? new PublicKey(req.mint)
      : req.mint
    : undefined;

  const built = await buildTransferInstructions(conn, {
    payer: req.from.publicKey,
    destination,
    mint,
    amount: req.amount,
    decimals: req.decimals,
    allowAtaCreation: req.allowAtaCreation,
  });

  const { blockhash } = await conn.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: req.from.publicKey,
    recentBlockhash: blockhash,
    instructions: built.instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([req.from]);

  if (req.dryRun) {
    const sim = await dryRun(conn, tx);
    const base: TransferResult = {
      signature: "",
      slot: 0,
      feeLamports: 0,
      program: built.program?.kind ?? "system",
      destinationAtaCreated: built.destinationAtaCreated,
      logs: sim.logs,
      unitsConsumed: sim.unitsConsumed,
      simulatedOnly: true,
    };
    if (!sim.ok) {
      const simErr = {
        message: `Transaction simulation failed: ${JSON.stringify(sim.err)}`,
        logs: sim.logs,
      };
      return { ...base, error: parseTransactionError(simErr) };
    }
    return base;
  }

  try {
    const sent = await conn.sendWithRetry(tx, {
      allowMainnet: req.allowMainnet,
      policy: req.policy,
    });
    return {
      signature: sent.signature,
      slot: sent.slot,
      feeLamports: sent.feeLamports,
      program: built.program?.kind ?? "system",
      destinationAtaCreated: built.destinationAtaCreated,
      simulatedOnly: false,
    };
  } catch (error) {
    return {
      signature:
        error instanceof TransactionSendError ? (error.signature ?? "") : "",
      slot: 0,
      feeLamports: 0,
      program: built.program?.kind ?? "system",
      destinationAtaCreated: built.destinationAtaCreated,
      simulatedOnly: false,
      error: parseTransactionError(error),
    };
  }
}
