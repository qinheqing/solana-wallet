/**
 * Transfer instruction builders — SOL (System), SPL Token and Token-2022
 * (transferChecked with decimals validation), with optional idempotent ATA
 * creation for the destination.
 *
 * PRD T-B construction knobs (all optional, defaults = historical behavior;
 * non-default values deliberately produce non-standard transactions for
 * testing third-party integrations):
 *   computeBudget · ataMode · instruction (+fee) · authority/sourceOwner · memo
 */
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  createTransferCheckedWithFeeInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

import type { ClusterConnection } from "../connection/connection.js";
import { SolwalletError } from "../connection/errors.js";
import type { InstructionLabel, TransactionPlan } from "./plan.js";
import { planFromInstructions } from "./plan.js";
import { getMintProgram, type MintProgram } from "./program.js";
import { fetchLookupTables } from "../lookup-table/lookup-table.js";

/** SPL Memo program (v2). */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/**
 * Destination-ATA strategy.
 * - `auto` (default): fetch the ATA; prepend an idempotent create only when
 *   it is missing (throws ATA_MISSING when missing and !allowAtaCreation).
 * - `always-idempotent`: always prepend `CreateIdempotent` (no RPC lookup).
 * - `create`: always prepend non-idempotent `Create` (fails on chain if the
 *   ATA already exists — useful to provoke that error).
 * - `none`: never add a creation instruction and never throw ATA_MISSING.
 */
export type AtaMode = "auto" | "always-idempotent" | "create" | "none";

/** Which token instruction carries the transfer. Default `transferChecked`. */
export type TransferInstructionKind = "transferChecked" | "transfer" | "transferCheckedWithFee";

export interface ComputeBudgetOptions {
  /** setComputeUnitLimit(units) — prepended first when given. */
  unitLimit?: number;
  /** setComputeUnitPrice(microLamports) — prepended after unitLimit when given. */
  unitPrice?: number;
}

export interface BuildTransferOptions {
  /** Wallet paying fees (and, unless sourceOwner/authority say otherwise, owning the source funds). */
  payer: PublicKey;
  /**
   * SOL recipient (no mint) or token-receiving owner (with mint; its ATA is
   * derived). Optional only for token transfers that pass
   * `destinationTokenAccount`.
   */
  destination?: PublicKey;
  /** Omit for native SOL transfer. */
  mint?: PublicKey;
  /** Base units — lamports for SOL, token base units otherwise. */
  amount: bigint;
  /** Required for token transfers (transferChecked validates it on chain). */
  decimals?: number;
  /** Auto-create the destination ATA when missing. Default: true. */
  allowAtaCreation?: boolean;

  // --- construction knobs (PRD T-B) — defaults keep today's behavior ----
  /** Prepend ComputeBudget instructions. Default: none. */
  computeBudget?: ComputeBudgetOptions;
  /** Destination ATA strategy. Default: "auto". Token transfers only. */
  ataMode?: AtaMode;
  /** Token instruction variant. Default: "transferChecked". Token transfers only. */
  instruction?: TransferInstructionKind;
  /** Expected fee in base units; required with instruction "transferCheckedWithFee". */
  fee?: bigint;
  /**
   * Signer of the token transfer (owner or delegate / permanent delegate).
   * Default: payer. When it differs from payer the caller must add that
   * signer at sign time (see TransactionPlan.signers).
   */
  authority?: PublicKey;
  /** Owner whose ATA is the source. Default: payer. Token transfers only. */
  sourceOwner?: PublicKey;
  /**
   * Explicit source token account (any address, ATA or not) instead of the
   * derived ATA. Excludes `sourceOwner`. Token transfers only.
   */
  sourceTokenAccount?: PublicKey;
  /**
   * Explicit destination token account (any address, ATA or not) instead of
   * the ATA of `destination`. No ATA-creation instruction is emitted.
   * Token transfers only.
   */
  destinationTokenAccount?: PublicKey;
  /** UTF-8 memo; emits a Memo-program instruction right before the transfer. */
  memo?: string;
}

export interface BuiltTransfer {
  program: MintProgram | null; // null = native SOL
  instructions: TransactionInstruction[];
  /** Label per instruction, parallel to `instructions`. */
  labels: InstructionLabel[];
  /**
   * The destination ATA will actually be created by this transaction: a
   * creation instruction is included AND the account does not exist yet.
   * (An idempotent create on an existing ATA is a no-op → false.)
   */
  destinationAtaCreated: boolean;
  /**
   * Whether the destination ATA already existed when building. `null` when
   * it was not looked up (ataMode "none" without preloaded accounts) or for
   * native SOL.
   */
  destinationAtaExisted: boolean | null;
  destinationAta: PublicKey | null;
}

/**
 * Accounts a caller already fetched (typically `preflightTransfer`), so the
 * builder does not read them again. Any field left undefined is fetched.
 */
export interface PreloadedTransferAccounts {
  /** Program owning the mint (what getMintProgram returns). */
  mintProgram?: MintProgram;
  /** Whether the source ATA (derived exactly as the builder does) exists. */
  sourceExists?: boolean;
  /** Whether the destination ATA exists. */
  destinationExists?: boolean;
}

/** Memo-program instruction (data = UTF-8 text, signers listed as keys). */
export function createMemoInstruction(memo: string, signers: PublicKey[] = []): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: signers.map((pubkey) => ({ pubkey, isSigner: true, isWritable: false })),
    data: Buffer.from(memo, "utf8"),
  });
}

function computeBudgetInstructions(
  cb: ComputeBudgetOptions | undefined,
): Array<{ ix: TransactionInstruction; label: InstructionLabel }> {
  const out: Array<{ ix: TransactionInstruction; label: InstructionLabel }> = [];
  if (!cb) return out;
  if (cb.unitLimit !== undefined) {
    out.push({
      ix: ComputeBudgetProgram.setComputeUnitLimit({ units: cb.unitLimit }),
      label: "setComputeUnitLimit",
    });
  }
  if (cb.unitPrice !== undefined) {
    out.push({
      ix: ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cb.unitPrice }),
      label: "setComputeUnitPrice",
    });
  }
  return out;
}

const TOKEN_ONLY_KNOBS = [
  "ataMode",
  "instruction",
  "fee",
  "authority",
  "sourceOwner",
  "sourceTokenAccount",
  "destinationTokenAccount",
] as const;

/**
 * Resolve the source / destination token accounts exactly as the builder
 * uses them: explicit accounts win, otherwise the ATAs of sourceOwner
 * (default payer) and destination. Also validates the option combination.
 */
export function resolveTransferTokenAccounts(
  opts: BuildTransferOptions & { mint: PublicKey },
  programId: PublicKey,
): { source: PublicKey; destination: PublicKey; sourceExplicit: boolean; destinationExplicit: boolean } {
  if (opts.sourceTokenAccount && opts.sourceOwner) {
    throw new SolwalletError("sourceTokenAccount and sourceOwner are mutually exclusive.", {
      code: "OPTION_CONFLICT",
      hint: "sourceTokenAccount names the account directly; sourceOwner derives its ATA. Pass one.",
    });
  }
  if (!opts.destinationTokenAccount && !opts.destination) {
    throw new SolwalletError("A token transfer needs a destination owner or a destinationTokenAccount.", {
      code: "DESTINATION_REQUIRED",
    });
  }
  const sourceOwner = opts.sourceOwner ?? opts.payer;
  return {
    source: opts.sourceTokenAccount ?? getAssociatedTokenAddressSync(opts.mint, sourceOwner, true, programId),
    destination:
      opts.destinationTokenAccount ?? getAssociatedTokenAddressSync(opts.mint, opts.destination!, true, programId),
    sourceExplicit: opts.sourceTokenAccount !== undefined,
    destinationExplicit: opts.destinationTokenAccount !== undefined,
  };
}

/**
 * Build the full instruction list for one transfer. `preloaded` lets a
 * caller that already read the mint / ATAs (preflight) skip those RPC reads.
 */
export async function buildTransferInstructions(
  conn: ClusterConnection,
  opts: BuildTransferOptions,
  preloaded: PreloadedTransferAccounts = {},
): Promise<BuiltTransfer> {
  const allowAtaCreation = opts.allowAtaCreation ?? true;
  const ataMode: AtaMode = opts.ataMode ?? "auto";
  const kind: TransferInstructionKind = opts.instruction ?? "transferChecked";

  // A zero/negative transfer is never a legitimate intent — it either wastes
  // the network fee for no effect or indicates an upstream bug (e.g. a
  // mis-parsed amount). Reject before touching the network.
  if (opts.amount <= 0n) {
    throw new SolwalletError(
      `Transfer amount must be positive, got ${opts.amount.toString()}.`,
      {
        code: "AMOUNT_ZERO_OR_NEGATIVE",
        hint: "Pass an amount greater than zero. A zero-amount transfer has no effect and only wastes the network fee.",
      },
    );
  }

  const prefix = computeBudgetInstructions(opts.computeBudget);

  // Native SOL — no mint, plain System transfer.
  if (!opts.mint) {
    if (opts.decimals !== undefined) {
      throw new SolwalletError("decimals is only valid for token transfers.", {
        code: "DECIMALS_UNEXPECTED",
      });
    }
    const misused = TOKEN_ONLY_KNOBS.filter((k) => opts[k] !== undefined);
    if (misused.length > 0) {
      throw new SolwalletError(
        `${misused.join(", ")} is only valid for token transfers.`,
        {
          code: "OPTION_TOKEN_ONLY",
          hint: "ataMode, instruction, fee, authority, sourceOwner, sourceTokenAccount and destinationTokenAccount apply to SPL / Token-2022 transfers; pass a mint or drop them.",
        },
      );
    }
    if (!opts.destination) {
      throw new SolwalletError("A SOL transfer needs a destination.", { code: "DESTINATION_REQUIRED" });
    }
    if (opts.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new SolwalletError("SOL amount exceeds safe integer lamports.", {
        code: "AMOUNT_OVERFLOW",
      });
    }
    const instructions = prefix.map((p) => p.ix);
    const labels = prefix.map((p) => p.label);
    if (opts.memo !== undefined) {
      instructions.push(createMemoInstruction(opts.memo, [opts.payer]));
      labels.push("memo");
    }
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: opts.payer,
        toPubkey: opts.destination,
        lamports: Number(opts.amount),
      }),
    );
    labels.push("systemTransfer");
    return {
      program: null,
      destinationAtaCreated: false,
      destinationAtaExisted: null,
      destinationAta: null,
      instructions,
      labels,
    };
  }

  // Token transfer (SPL or Token-2022) via the mint's owning program.
  const program = preloaded.mintProgram ?? (await getMintProgram(conn, opts.mint));
  if (opts.decimals === undefined) {
    throw new SolwalletError("Token transfers require `decimals` (transferChecked).", {
      code: "DECIMALS_REQUIRED",
      hint: "Fetch decimals once with getMintDecimals() and cache per mint.",
    });
  }
  if (kind === "transferCheckedWithFee" && opts.fee === undefined) {
    throw new SolwalletError(
      'instruction "transferCheckedWithFee" requires `fee` (expected fee in base units).',
      {
        code: "FEE_REQUIRED",
        hint: "Compute the fee from the mint's TransferFeeConfig (bps, maxFee) or pass 0n to provoke a FeeMismatch on chain.",
      },
    );
  }
  if (kind !== "transferCheckedWithFee" && opts.fee !== undefined) {
    throw new SolwalletError('`fee` is only valid with instruction "transferCheckedWithFee".', {
      code: "FEE_UNEXPECTED",
    });
  }
  if (opts.allowAtaCreation === false && (ataMode === "always-idempotent" || ataMode === "create")) {
    throw new SolwalletError(
      `allowAtaCreation: false conflicts with ataMode "${ataMode}".`,
      {
        code: "ATA_MODE_CONFLICT",
        hint: 'Drop allowAtaCreation or use ataMode "auto" / "none".',
      },
    );
  }

  const authority = opts.authority ?? opts.payer;
  const sourceOwner = opts.sourceOwner ?? opts.payer;
  const resolved = resolveTransferTokenAccounts({ ...opts, mint: opts.mint }, program.programId);
  if (resolved.destinationExplicit && (ataMode === "always-idempotent" || ataMode === "create")) {
    throw new SolwalletError(
      `destinationTokenAccount conflicts with ataMode "${ataMode}" — an explicit account is never created as an ATA.`,
      {
        code: "ATA_MODE_CONFLICT",
        hint: 'Drop ataMode (or use "auto" / "none"), or pass a destination owner instead of destinationTokenAccount.',
      },
    );
  }
  const sourceAta = resolved.source;
  const sourceExists =
    preloaded.sourceExists ?? (await conn.connection.getAccountInfo(sourceAta)) !== null;
  if (!sourceExists) {
    throw new SolwalletError(
      resolved.sourceExplicit
        ? `Source token account ${sourceAta.toBase58()} does not exist.`
        : `${sourceOwner.equals(opts.payer) ? "Payer" : `Source owner ${sourceOwner.toBase58()}`} holds no token account for mint ${opts.mint.toBase58()}.`,
      {
        code: "SOURCE_ATA_MISSING",
        hint: resolved.sourceExplicit
          ? "Check the address and cluster; create it with createTokenAccount first."
          : "The wallet never received this token. Mint or receive it first, then transfer.",
      },
    );
  }

  // Destination per ataMode. Existence is looked up (once) for every mode
  // that may create it, so `destinationAtaCreated` reports what the
  // transaction will really do; "none" never looks it up. An explicit
  // destination account is never created: it must already exist (checked
  // unless ataMode is "none").
  const destAta = resolved.destination;
  let destExists: boolean | null = preloaded.destinationExists ?? null;
  if (resolved.destinationExplicit) {
    // ataMode "none" skips the lookup (lets callers provoke the on-chain error).
    if (ataMode !== "none") destExists ??= (await conn.connection.getAccountInfo(destAta)) !== null;
    if (destExists === false) {
      throw new SolwalletError(`Destination token account ${destAta.toBase58()} does not exist.`, {
        code: "DESTINATION_ACCOUNT_MISSING",
        hint: "Create it first (createTokenAccount / create_token_account), or pass a destination owner to use its ATA.",
      });
    }
  } else if (destExists === null && ataMode !== "none") {
    destExists = (await conn.connection.getAccountInfo(destAta)) !== null;
  }
  let createIx: { ix: TransactionInstruction; label: InstructionLabel } | undefined;
  const ataProgramId =
    program.programId.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const idempotentCreate = (): typeof createIx => ({
    ix: createAssociatedTokenAccountIdempotentInstruction(
      opts.payer,
      destAta,
      opts.destination!,
      opts.mint!,
      ataProgramId,
    ),
    label: "createAssociatedTokenAccountIdempotent",
  });
  if (resolved.destinationExplicit) {
    // Explicit account: nothing to create.
  } else if (ataMode === "auto") {
    if (destExists === false) {
      if (!allowAtaCreation) {
        throw new SolwalletError(
          `Destination token account ${destAta.toBase58()} does not exist.`,
          {
            code: "ATA_MISSING",
            hint: "Pass allowAtaCreation: true to create it automatically (the payer covers ~0.002 SOL rent), or send to an address that already holds this token.",
          },
        );
      }
      // Idempotent: a no-op should the account appear meanwhile (race-safe).
      createIx = idempotentCreate();
    }
  } else if (ataMode === "always-idempotent") {
    createIx = idempotentCreate();
  } else if (ataMode === "create") {
    createIx = {
      ix: createAssociatedTokenAccountInstruction(
        opts.payer,
        destAta,
        opts.destination!,
        opts.mint,
        ataProgramId,
      ),
      label: "createAssociatedTokenAccount",
    };
  }
  // "none": nothing.

  let transferIx: TransactionInstruction;
  switch (kind) {
    case "transfer":
      transferIx = createTransferInstruction(
        sourceAta,
        destAta,
        authority,
        opts.amount,
        [],
        program.programId,
      );
      break;
    case "transferCheckedWithFee":
      transferIx = createTransferCheckedWithFeeInstruction(
        sourceAta,
        opts.mint,
        destAta,
        authority,
        opts.amount,
        opts.decimals,
        opts.fee!,
        [],
        program.programId,
      );
      break;
    case "transferChecked":
    default:
      transferIx = createTransferCheckedInstruction(
        sourceAta,
        opts.mint,
        destAta,
        authority,
        opts.amount,
        opts.decimals,
        [],
        program.programId,
      );
  }

  const instructions = prefix.map((p) => p.ix);
  const labels = prefix.map((p) => p.label);
  if (createIx) {
    instructions.push(createIx.ix);
    labels.push(createIx.label);
  }
  if (opts.memo !== undefined) {
    instructions.push(createMemoInstruction(opts.memo, [authority]));
    labels.push("memo");
  }
  instructions.push(transferIx);
  labels.push(kind);

  return {
    program,
    instructions,
    labels,
    // A creation instruction only creates something when the ATA is absent.
    destinationAtaCreated: createIx !== undefined && destExists === false,
    destinationAtaExisted: destExists,
    destinationAta: destAta,
  };
}

export interface BuildTransferPlanOptions extends BuildTransferOptions {
  /** Reuse a blockhash instead of fetching one (deterministic plans in tests). */
  blockhash?: string;
  /**
   * Address lookup tables to compile the v0 message against. Fetched from
   * the cluster (ALT_NOT_FOUND / ALT_DEACTIVATED when unusable).
   */
  lookupTables?: PublicKey[];
}

/**
 * Build + compile (v0, payer as fee payer) without signing. Fetches a
 * blockhash unless `blockhash` is supplied. Never sends.
 */
export async function buildTransferPlan(
  conn: ClusterConnection,
  opts: BuildTransferPlanOptions,
  preloaded: PreloadedTransferAccounts = {},
): Promise<{ built: BuiltTransfer; plan: TransactionPlan }> {
  const built = await buildTransferInstructions(conn, opts, preloaded);
  const blockhash =
    opts.blockhash ?? (await conn.connection.getLatestBlockhash("confirmed")).blockhash;
  const tables = opts.lookupTables?.length ? await fetchLookupTables(conn, opts.lookupTables) : [];
  const { plan } = planFromInstructions(opts.payer, blockhash, built.instructions, built.labels, tables);
  return { built, plan };
}

export const TOKEN_PROGRAM_IDS = {
  spl: TOKEN_PROGRAM_ID,
  token2022: TOKEN_2022_PROGRAM_ID,
} as const;
