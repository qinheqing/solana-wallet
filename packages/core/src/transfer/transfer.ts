/**
 * transfer() — the single-transfer orchestration (F4.1/F4.5/F4.6):
 * identify program → build instructions (+ATA) → optional dry-run →
 * sign & send (mainnet-guarded) → assemble TransferResult.
 *
 * Errors are returned (not thrown) as parsed {code, suggestion} objects so
 * MCP/AI callers can react programmatically to failures.
 */
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";

import type { ClusterConnection } from "../connection/connection.js";
import type { ConfirmPolicy } from "../connection/connection.js";
import { SolwalletError, TransactionSendError } from "../connection/errors.js";
import { parseTransactionError, type ParsedProgramError } from "../utils/parse-error.js";
import { dryRun } from "./dryrun.js";
import {
  buildTransferInstructions,
  type AtaMode,
  type ComputeBudgetOptions,
  type TransferInstructionKind,
} from "./build.js";
import { planFromInstructions, type TransactionPlan } from "./plan.js";
import { fetchLookupTables } from "../lookup-table/lookup-table.js";
import { describeBlockers, preflightTransferWithAccounts, type PreflightResult } from "./preflight.js";
import type { TokenProgramKind } from "./program.js";

export interface TransferRequest {
  /** Fee payer & source-of-funds owner. */
  from: Keypair;
  /**
   * SOL recipient, or the owner receiving tokens at their ATA. Optional only
   * for token transfers that pass `destinationTokenAccount`.
   */
  destination?: string | PublicKey;
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

  // --- construction knobs (PRD T-B); defaults keep today's behavior ------
  /** Prepend setComputeUnitLimit / setComputeUnitPrice. */
  computeBudget?: ComputeBudgetOptions;
  /** Destination ATA strategy. Default "auto". */
  ataMode?: AtaMode;
  /** Token instruction variant. Default "transferChecked". */
  instruction?: TransferInstructionKind;
  /** Required with instruction "transferCheckedWithFee". */
  fee?: bigint;
  /** Transfer authority when it is not `from` (delegate / permanent delegate). */
  authority?: string | PublicKey;
  /** Owner of the source ATA when it is not `from`. */
  sourceOwner?: string | PublicKey;
  /** Explicit source token account (ATA or not); excludes sourceOwner. */
  sourceTokenAccount?: string | PublicKey;
  /** Explicit destination token account (ATA or not); never created. */
  destinationTokenAccount?: string | PublicKey;
  /** Address lookup tables to compile the v0 message against. */
  lookupTables?: Array<string | PublicKey>;
  /** Memo-program instruction placed right before the transfer. */
  memo?: string;
  /** Additional signers, e.g. the `authority` keypair when it differs from `from`. */
  extraSigners?: Keypair[];

  // --- preflight (PRD T-C) -----------------------------------------------
  /**
   * Bypass block-level preflight findings and let the validator's own
   * preflight decide. Findings are still attached to the result. For
   * testing error handling.
   */
  force?: boolean;
  /** Skip the preflight entirely (no extra RPC reads, no findings). */
  skipPreflight?: boolean;
}

export interface TransferResult {
  /** Empty for simulated transfers. */
  signature: string;
  slot: number;
  /** Fee in lamports (0 for simulations). */
  feeLamports: number;
  program: "system" | TokenProgramKind;
  /** The destination ATA is created by this transaction (absent before, creation instruction included). */
  destinationAtaCreated: boolean;
  /** Whether the destination ATA already existed; null when not looked up (ataMode "none") or for SOL. */
  destinationAtaExisted: boolean | null;
  /** Populated by dryRun: full simulation logs. */
  logs?: string[];
  unitsConsumed?: number;
  simulatedOnly: boolean;
  /** Parsed failure — set instead of throwing, for AI-friendly flows. */
  error?: ParsedProgramError;
  /**
   * What was compiled: instructions, message hex, signers, blockhash.
   * Omitted only when preflight blocked and building the plan also failed.
   */
  plan?: TransactionPlan;
  /** Preflight findings — present whenever the preflight ran (PRD T-C). */
  preflight?: PreflightResult;
}

function toPubkey(v: string | PublicKey): PublicKey {
  return typeof v === "string" ? new PublicKey(v) : v;
}

/**
 * Send one transfer. Ingress-side scenarios (PRD T-H) — all run through the
 * same preflight → build → sign → send path:
 *
 * @example Delegate transfer (after `approveDelegate` by the owner):
 * ```ts
 * await transfer(conn, {
 *   from: delegateKeypair,            // fee payer AND the only signer
 *   sourceOwner: ownerPubkey,         // whose ATA the funds leave
 *   authority: delegateKeypair.publicKey,
 *   destination, mint, amount, decimals,
 * });
 * // plan.signers === [delegate]; preflight: DELEGATE_TRANSFER (info) or
 * // INSUFFICIENT_DELEGATED_AMOUNT / AUTHORITY_NOT_DELEGATE (block).
 * ```
 *
 * @example PermanentDelegate forced transfer (Token-2022, no owner consent):
 * ```ts
 * await transfer(conn, {
 *   from: permanentDelegateKeypair, sourceOwner: victim,
 *   authority: permanentDelegateKeypair.publicKey, destination, mint, amount, decimals,
 * });
 * // preflight: PERMANENT_DELEGATE_TRANSFER (info).
 * ```
 *
 * @example transferCheckedWithFee (Token-2022 TransferFee mints):
 * ```ts
 * await transfer(conn, { ...base, instruction: "transferCheckedWithFee", fee: 25n });
 * // instruction data = [26, 1, amount u64, decimals u8, fee u64]; FEE_MISMATCH blocks
 * // when `fee` differs from the mint's current tier (chain: FeeMismatch, custom 32).
 * ```
 *
 * @example Plain (unchecked) transfer: `{ ...base, instruction: "transfer" }` → data `[3, amount u64]`.
 *
 * @example Memo attached: `{ ...base, memo: "invoice 42" }` → a Memo-program
 * instruction (signed by the authority) immediately precedes the transfer;
 * clears MEMO_REQUIRED for MemoTransfer-enabled recipients.
 */
export async function transfer(
  conn: ClusterConnection,
  req: TransferRequest,
): Promise<TransferResult> {
  const destination = req.destination ? toPubkey(req.destination) : undefined;
  const mint = req.mint ? toPubkey(req.mint) : undefined;
  const buildOpts = {
    payer: req.from.publicKey,
    destination,
    mint,
    amount: req.amount,
    decimals: req.decimals,
    allowAtaCreation: req.allowAtaCreation,
    computeBudget: req.computeBudget,
    ataMode: req.ataMode,
    instruction: req.instruction,
    fee: req.fee,
    authority: req.authority ? toPubkey(req.authority) : undefined,
    sourceOwner: req.sourceOwner ? toPubkey(req.sourceOwner) : undefined,
    sourceTokenAccount: req.sourceTokenAccount ? toPubkey(req.sourceTokenAccount) : undefined,
    destinationTokenAccount: req.destinationTokenAccount ? toPubkey(req.destinationTokenAccount) : undefined,
    memo: req.memo,
  };
  // Resolved up front so an unusable table fails before anything is built.
  const tables = req.lookupTables?.length ? await fetchLookupTables(conn, req.lookupTables) : [];

  // Preflight (T-C): block-level findings stop here unless `force`. The plan
  // is still built best-effort so callers can inspect what would have gone
  // out; the validator's preflight remains the backstop when forced. The
  // accounts the preflight read are handed to the builder — no second read.
  const pre = req.skipPreflight ? undefined : await preflightTransferWithAccounts(conn, buildOpts);
  const preflight = pre?.result;
  const preloaded = pre?.accounts?.preloaded;
  if (preflight && !preflight.ok && req.force !== true) {
    let plan: TransactionPlan | undefined;
    let program: TransferResult["program"] = "system";
    let destinationAtaCreated = false;
    let destinationAtaExisted: boolean | null = null;
    try {
      const built = await buildTransferInstructions(conn, buildOpts, preloaded);
      const { blockhash } = await conn.connection.getLatestBlockhash("confirmed");
      plan = planFromInstructions(req.from.publicKey, blockhash, built.instructions, built.labels, tables).plan;
      program = built.program?.kind ?? "system";
      destinationAtaCreated = built.destinationAtaCreated;
      destinationAtaExisted = built.destinationAtaExisted;
    } catch {
      // Building is informational here; the preflight verdict stands.
    }
    return {
      signature: "",
      slot: 0,
      feeLamports: 0,
      program,
      destinationAtaCreated,
      destinationAtaExisted,
      simulatedOnly: req.dryRun === true,
      error: {
        code: "PREFLIGHT_BLOCKED",
        message: `Preflight blocked the transfer: ${describeBlockers(preflight)}`,
        suggestion:
          "Fix the blocking findings (see `preflight.findings`), or pass force: true to send anyway and let the validator's preflight decide.",
      },
      preflight,
      ...(plan ? { plan } : {}),
    };
  }

  const built = await buildTransferInstructions(conn, buildOpts, preloaded);

  const { blockhash, lastValidBlockHeight } = await conn.connection.getLatestBlockhash("confirmed");
  const { message, plan } = planFromInstructions(
    req.from.publicKey,
    blockhash,
    built.instructions,
    built.labels,
    tables,
  );

  // Every required signer must be supplied up front: a missing one would
  // only surface as an opaque signature-verification failure at send time.
  const signers = [req.from, ...(req.extraSigners ?? [])];
  const have = new Set(signers.map((k) => k.publicKey.toBase58()));
  const missing = plan.signers.filter((s) => !have.has(s));
  if (missing.length > 0) {
    throw new SolwalletError(
      `Transaction requires signature(s) from ${missing.join(", ")} but no matching keypair was supplied.`,
      {
        code: "SIGNER_MISSING",
        hint: "Pass the authority keypair in extraSigners (core) / authorityWallet (MCP), or set authority to the sending wallet.",
      },
    );
  }
  const tx = new VersionedTransaction(message);
  tx.sign(signers.filter((k) => plan.signers.includes(k.publicKey.toBase58())));

  const base: TransferResult = {
    signature: "",
    slot: 0,
    feeLamports: 0,
    program: built.program?.kind ?? "system",
    destinationAtaCreated: built.destinationAtaCreated,
    destinationAtaExisted: built.destinationAtaExisted,
    simulatedOnly: req.dryRun === true,
    plan,
    ...(preflight ? { preflight } : {}),
  };
  // The token program is the only program here that returns custom errors
  // we can name; the ATA / Memo / ComputeBudget programs are attributed by
  // the simulation logs when present.
  const parseOpts = built.program ? { programId: built.program.programId } : {};

  if (req.dryRun) {
    const sim = await dryRun(conn, tx);
    const simulated: TransferResult = { ...base, logs: sim.logs, unitsConsumed: sim.unitsConsumed };
    if (!sim.ok) {
      const simErr = {
        message: `Transaction simulation failed: ${JSON.stringify(sim.err)}`,
        logs: sim.logs,
      };
      return { ...simulated, error: parseTransactionError(simErr, parseOpts) };
    }
    return simulated;
  }

  try {
    const sent = await conn.sendWithRetry(tx, {
      allowMainnet: req.allowMainnet,
      policy: req.policy,
      lastValidBlockHeight,
    });
    return { ...base, signature: sent.signature, slot: sent.slot, feeLamports: sent.feeLamports };
  } catch (error) {
    return {
      ...base,
      signature: error instanceof TransactionSendError ? (error.signature ?? "") : "",
      error: parseTransactionError(error, parseOpts),
    };
  }
}
