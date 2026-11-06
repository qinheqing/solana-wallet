/**
 * Mixed transfer (F4.3): SOL + SPL + Token-2022 legs merged into ONE
 * versioned transaction — one signature, one fee. Each leg reuses
 * buildTransferInstructions (program dispatch, idempotent ATA creation);
 * instructions keep input order. A merged transaction that would exceed the
 * 1232-byte wire limit is rejected with a structured error pointing at
 * executeBatchTransfer instead.
 */
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import type { ClusterConnection, ConfirmPolicy } from "../connection/connection.js";
import { SolwalletError } from "../connection/errors.js";
import { parseTransactionError, type ParsedProgramError } from "../utils/parse-error.js";
import { estimateTransactionSize, MAX_TX_BYTES } from "./batch.js";
import { buildTransferInstructions } from "./build.js";
import { dryRun as simulateTx } from "./dryrun.js";
import type { TokenProgramKind } from "./program.js";

/** One leg of a mixed transfer. SOL legs omit mint; token legs require it. */
export interface MixedLeg {
  kind: "sol" | "token";
  /** SOL recipient, or the owner receiving tokens at their ATA. */
  to: string | PublicKey;
  /** Base units — lamports for SOL, token base units otherwise. */
  amount: bigint;
  /** Required for token legs; omit for native SOL. */
  mint?: string | PublicKey;
  /** Required for token legs (transferChecked validates on chain). */
  decimals?: number;
  /** Auto-create the destination ATA when missing. Default: true. */
  allowAtaCreation?: boolean;
}

export interface MixedTransferOptions {
  /** Simulate only — nothing is sent on chain. */
  dryRun?: boolean;
  /** Explicit mainnet confirmation, forwarded to sendWithRetry. */
  allowMainnet?: boolean;
  /** Confirm/retry policy override forwarded to sendWithRetry. */
  policy?: Partial<ConfirmPolicy>;
  /** Byte budget for the merged tx. Default MAX_TX_BYTES (1232). */
  sizeBudgetBytes?: number;
}

/** Per-leg echo of what was merged into the transaction. */
export interface MixedLegSummary {
  /** On-chain program executing this leg ("system" for SOL legs). */
  kind: "system" | TokenProgramKind;
  /** Recipient (base58). */
  to: string;
  /** Base units actually encoded in the instruction. */
  amountBaseUnits: string;
  /** Program that executes this leg ("system" for SOL). */
  program: "system" | TokenProgramKind;
  destinationAtaCreated: boolean;
  /** Derived destination ATA when the leg was a token transfer. */
  destinationAta?: string;
}

export interface MixedTransferResult {
  /** Empty for simulated transfers. */
  signature: string;
  slot: number;
  /** Fee in lamports (0 for simulations). */
  feeLamports: number;
  simulatedOnly: boolean;
  /** Populated by dryRun: full simulation logs. */
  logs?: string[];
  unitsConsumed?: number;
  legs: MixedLegSummary[];
  /** Parsed failure — set instead of throwing, for AI-friendly flows. */
  error?: ParsedProgramError;
}

/**
 * Merge all legs into a single transaction and send it. SOL amounts above
 * MAX_SAFE_INTEGER lamports are rejected by buildTransferInstructions with
 * a structured AMOUNT_OVERFLOW error; oversized merged transactions with
 * TX_TOO_LARGE (hint: switch to executeBatchTransfer).
 */
export async function executeMixedTransfer(
  conn: ClusterConnection,
  from: Keypair,
  legs: readonly MixedLeg[],
  opts: MixedTransferOptions = {},
): Promise<MixedTransferResult> {
  if (legs.length === 0) {
    throw new SolwalletError("Mixed transfer requires at least one leg.", {
      code: "LEGS_EMPTY",
      hint: "Provide at least one {kind: 'sol'|'token'} leg; use plain transfer() for a single SOL/token send.",
    });
  }

  const instructions: TransactionInstruction[] = [];
  const summaries: MixedLegSummary[] = [];

  for (const leg of legs) {
    const to = typeof leg.to === "string" ? new PublicKey(leg.to) : leg.to;
    const mint = leg.mint
      ? typeof leg.mint === "string"
        ? new PublicKey(leg.mint)
        : leg.mint
      : undefined;

    if (leg.kind === "sol" && mint) {
      throw new SolwalletError("A sol leg must not carry a mint.", {
        code: "MIXED_LEG_INVALID",
        hint: `Leg to ${to.toBase58()}: set kind: "token" for token transfers, or drop the mint to send native SOL.`,
      });
    }
    if (leg.kind === "token" && !mint) {
      throw new SolwalletError("A token leg requires a mint.", {
        code: "MIXED_LEG_INVALID",
        hint: `Leg to ${to.toBase58()}: pass the mint address, or set kind: "sol" for a native SOL transfer.`,
      });
    }

    const built = await buildTransferInstructions(conn, {
      payer: from.publicKey,
      destination: to,
      mint,
      amount: leg.amount,
      decimals: leg.decimals,
      allowAtaCreation: leg.allowAtaCreation,
    });
    instructions.push(...built.instructions);
    summaries.push({
      kind: built.program?.kind ?? "system",
      to: to.toBase58(),
      amountBaseUnits: leg.amount.toString(),
      program: built.program?.kind ?? "system",
      destinationAtaCreated: built.destinationAtaCreated,
      destinationAta: built.destinationAta?.toBase58(),
    });
  }

  const budget = opts.sizeBudgetBytes ?? MAX_TX_BYTES;
  const estimatedBytes = estimateTransactionSize(from.publicKey, instructions);
  if (estimatedBytes > budget) {
    throw new SolwalletError(
      `Mixed transfer needs ~${estimatedBytes} bytes for ${legs.length} leg(s); the wire limit is ${budget}.`,
      {
        code: "TX_TOO_LARGE",
        hint: "Split the legs across multiple transactions with executeBatchTransfer (batch_transfer), or reduce the leg count.",
      },
    );
  }

  const { blockhash } = await conn.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: from.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([from]);

  if (opts.dryRun) {
    const sim = await simulateTx(conn, tx);
    const base: MixedTransferResult = {
      signature: "",
      slot: 0,
      feeLamports: 0,
      simulatedOnly: true,
      legs: summaries,
      logs: sim.logs,
      unitsConsumed: sim.unitsConsumed,
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
      allowMainnet: opts.allowMainnet,
      policy: opts.policy,
    });
    return {
      signature: sent.signature,
      slot: sent.slot,
      feeLamports: sent.feeLamports,
      simulatedOnly: false,
      legs: summaries,
    };
  } catch (error) {
    return {
      signature: "",
      slot: 0,
      feeLamports: 0,
      simulatedOnly: false,
      legs: summaries,
      error: parseTransactionError(error),
    };
  }
}
