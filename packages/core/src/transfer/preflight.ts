/**
 * Transfer preflight (PRD T-C): inspect the mint and both token accounts
 * before building, and report everything that would make the transfer fail
 * on chain (block), silently do something surprising (warn), or is merely
 * worth knowing (info).
 *
 * `evaluatePreflight` is pure (decoded inspections in, findings out) so the
 * rules are testable offline; `preflightTransfer` only fetches + delegates.
 * The check is advisory: an account that exists but cannot be decoded
 * yields a PREFLIGHT_INCOMPLETE warning instead of an exception — the
 * validator's own preflight remains the backstop.
 */
import { PublicKey, type AccountInfo } from "@solana/web3.js";

import type { ClusterConnection } from "../connection/connection.js";
import { SolwalletError } from "../connection/errors.js";
import { decodeTokenAccount, type TokenAccountInspection } from "../inspect/account.js";
import { decodeMintAccount, type MintInspection, type TransferFeeView } from "../inspect/mint.js";
import {
  resolveTransferTokenAccounts,
  type AtaMode,
  type BuildTransferOptions,
  type PreloadedTransferAccounts,
  type TransferInstructionKind,
} from "./build.js";
import { mintProgramFromOwner, type TokenProgramKind } from "./program.js";

export type PreflightSeverity = "block" | "warn" | "info";

export type PreflightCode =
  | "TRANSFER_HOOK_PRESENT"
  | "MEMO_REQUIRED"
  | "ACCOUNT_FROZEN"
  | "NON_TRANSFERABLE"
  | "DEST_ATA_MISSING"
  | "SOURCE_ATA_MISSING"
  | "INSUFFICIENT_TOKEN_BALANCE"
  | "TRANSFER_FEE"
  | "FEE_MISMATCH"
  | "UNCHECKED_TRANSFER_REJECTED"
  | "SCALED_UI_AMOUNT"
  | "NON_STANDARD_CONSTRUCTION"
  | "PERMANENT_DELEGATE_TRANSFER"
  | "DELEGATE_TRANSFER"
  | "INSUFFICIENT_DELEGATED_AMOUNT"
  | "AUTHORITY_NOT_DELEGATE"
  | "DESTINATION_ACCOUNT_MISSING"
  | "TOKEN_ACCOUNT_MINT_MISMATCH"
  | "PREFLIGHT_INCOMPLETE";

export interface PreflightFinding {
  code: PreflightCode;
  severity: PreflightSeverity;
  message: string;
  /** JSON-safe details (raw amounts as strings). */
  data?: Record<string, unknown>;
}

/** Addresses the preflight resolved on the way — handy for callers/MCP. */
export interface PreflightResolved {
  program: TokenProgramKind;
  programId: string;
  mint: string;
  sourceAta: string;
  destinationAta: string;
  /** Epoch used to pick the transfer-fee tier (only fetched when relevant). */
  epoch?: string;
}

export interface PreflightResult {
  /** True when no block-level finding exists. */
  ok: boolean;
  findings: PreflightFinding[];
  resolved?: PreflightResolved;
}

export interface PreflightContext {
  mint: MintInspection;
  /** `null` = account absent; `undefined` = present but undecodable (skip account checks). */
  sourceAccount?: TokenAccountInspection | null;
  destAccount?: TokenAccountInspection | null;
  opts: BuildTransferOptions;
  /** Current epoch — only consulted when the mint carries TransferFeeConfig. */
  epoch?: number | bigint;
}

/**
 * Resolve the source/destination token accounts exactly as
 * buildTransferInstructions does: explicit sourceTokenAccount /
 * destinationTokenAccount win, otherwise the derived ATAs. (Field names keep
 * "Ata" for compatibility; they hold whichever account is used.)
 */
export function resolveTransferAtas(
  opts: BuildTransferOptions & { mint: PublicKey },
  programId: PublicKey,
): { sourceAta: PublicKey; destinationAta: PublicKey } {
  const r = resolveTransferTokenAccounts(opts, programId);
  return { sourceAta: r.source, destinationAta: r.destination };
}

/** Token-2022 fee rule: ceil(amount * bps / 10_000), capped at maximumFee. */
export function computeTransferFee(amount: bigint, tier: TransferFeeView): bigint {
  const bps = BigInt(tier.transferFeeBasisPoints);
  if (bps === 0n || amount <= 0n) return 0n;
  const raw = (amount * bps + 9_999n) / 10_000n;
  const max = BigInt(tier.maximumFee);
  return raw > max ? max : raw;
}

/** The newer tier applies once the current epoch reaches its epoch. */
export function pickFeeTier(
  ext: { olderTransferFee: TransferFeeView; newerTransferFee: TransferFeeView },
  epoch: number | bigint | undefined,
): { tier: TransferFeeView; which: "older" | "newer" } {
  if (epoch === undefined) return { tier: ext.newerTransferFee, which: "newer" };
  return BigInt(epoch) >= BigInt(ext.newerTransferFee.epoch)
    ? { tier: ext.newerTransferFee, which: "newer" }
    : { tier: ext.olderTransferFee, which: "older" };
}

function findExt<T extends MintInspection["extensions"][number]["type"]>(
  mint: MintInspection,
  type: T,
): Extract<MintInspection["extensions"][number], { type: T }> | undefined {
  return mint.extensions.find((e) => e.type === type) as
    | Extract<MintInspection["extensions"][number], { type: T }>
    | undefined;
}

function memoRequired(account: TokenAccountInspection): boolean {
  return account.extensions.some(
    (e) => e.type === "MemoTransfer" && e.requireIncomingTransferMemos,
  );
}

/** Pure rule evaluation over already-decoded accounts. */
export function evaluatePreflight(ctx: PreflightContext): PreflightResult {
  const { mint, opts, sourceAccount, destAccount } = ctx;
  const findings: PreflightFinding[] = [];
  const ataMode: AtaMode = opts.ataMode ?? "auto";
  const kind: TransferInstructionKind = opts.instruction ?? "transferChecked";
  const amount = opts.amount;

  if (!opts.mint) {
    return { ok: true, findings: [] };
  }
  const programId = new PublicKey(mint.programId);
  const { sourceAta, destinationAta } = resolveTransferAtas(
    { ...opts, mint: opts.mint },
    programId,
  );
  const resolved: PreflightResolved = {
    program: mint.program,
    programId: mint.programId,
    mint: mint.address,
    sourceAta: sourceAta.toBase58(),
    destinationAta: destinationAta.toBase58(),
    ...(ctx.epoch !== undefined ? { epoch: ctx.epoch.toString() } : {}),
  };

  // --- mint-level blockers --------------------------------------------------
  const hook = findExt(mint, "TransferHook");
  if (hook && hook.programId) {
    findings.push({
      code: "TRANSFER_HOOK_PRESENT",
      severity: "block",
      message: `Mint has a TransferHook (program ${hook.programId}); plain transferChecked omits the hook's extra accounts and will fail on chain.`,
      data: { programId: hook.programId, authority: hook.authority },
    });
  }
  if (findExt(mint, "NonTransferable")) {
    findings.push({
      code: "NON_TRANSFERABLE",
      severity: "block",
      message: "Mint is NonTransferable: tokens can only be minted and burned, never transferred.",
    });
  }

  // --- account states --------------------------------------------------------
  if (sourceAccount?.state === "frozen") {
    findings.push({
      code: "ACCOUNT_FROZEN",
      severity: "block",
      message: `Source token account ${sourceAta.toBase58()} is frozen; the freeze authority must thaw it first.`,
      data: { account: sourceAta.toBase58(), role: "source" },
    });
  }
  if (destAccount?.state === "frozen") {
    findings.push({
      code: "ACCOUNT_FROZEN",
      severity: "block",
      message: `Destination token account ${destinationAta.toBase58()} is frozen; the freeze authority must thaw it first.`,
      data: { account: destinationAta.toBase58(), role: "destination" },
    });
  }
  const willCreateDest = destAccount === null && ataMode !== "none" && !opts.destinationTokenAccount;
  const defaultState = findExt(mint, "DefaultAccountState");
  if (willCreateDest && defaultState?.state === "frozen") {
    findings.push({
      code: "ACCOUNT_FROZEN",
      severity: "block",
      message: `Mint's DefaultAccountState is frozen: the destination ATA ${destinationAta.toBase58()} would be created frozen and the transfer rejected. Create it and have the freeze authority thaw it first.`,
      data: { account: destinationAta.toBase58(), role: "destination", reason: "DefaultAccountState" },
    });
  }

  // --- memo -------------------------------------------------------------------
  if (destAccount && memoRequired(destAccount) && opts.memo === undefined) {
    findings.push({
      code: "MEMO_REQUIRED",
      severity: "block",
      message: `Destination token account ${destinationAta.toBase58()} requires incoming transfers to carry a memo (MemoTransfer); pass \`memo\`.`,
      data: { destAta: destinationAta.toBase58() },
    });
  }

  // --- destination presence --------------------------------------------------
  if (destAccount === null && opts.destinationTokenAccount) {
    findings.push({
      code: "DESTINATION_ACCOUNT_MISSING",
      severity: ataMode === "none" ? "warn" : "block",
      message: `Destination token account ${destinationAta.toBase58()} does not exist; an explicit destination account is never created by the transfer.`,
      data: { account: destinationAta.toBase58(), ataMode },
    });
  } else if (destAccount === null) {
    const allowAtaCreation = opts.allowAtaCreation ?? true;
    const note =
      ataMode === "none"
        ? 'ataMode "none": no creation instruction will be added, so the transfer fails on chain.'
        : ataMode === "auto" && !allowAtaCreation
          ? "allowAtaCreation is false: building will throw ATA_MISSING."
          : "A creation instruction will be included; the payer covers rent (~0.002 SOL).";
    findings.push({
      code: "DEST_ATA_MISSING",
      severity: "info",
      message: `Destination token account ${destinationAta.toBase58()} does not exist. ${note}`,
      data: { destAta: destinationAta.toBase58(), ataMode, allowAtaCreation, rentNote: "~0.002 SOL paid by payer" },
    });
  }

  // --- transfer fee -------------------------------------------------------------
  const feeCfg = findExt(mint, "TransferFeeConfig");
  if (feeCfg) {
    const { tier, which } = pickFeeTier(feeCfg, ctx.epoch);
    const expectedFee = computeTransferFee(amount, tier);
    const net = amount - expectedFee;
    const data = {
      tier: which,
      epoch: ctx.epoch?.toString() ?? null,
      transferFeeBasisPoints: tier.transferFeeBasisPoints,
      maximumFee: tier.maximumFee,
      expectedFee: expectedFee.toString(),
      net: net.toString(),
      amount: amount.toString(),
    };
    if (kind === "transferCheckedWithFee" && opts.fee !== undefined && opts.fee !== expectedFee) {
      // Token-2022 compares the declared fee with its own calculation and
      // fails with FeeMismatch (custom 32) on any difference — deterministic.
      findings.push({
        code: "FEE_MISMATCH",
        severity: "block",
        message: `fee ${opts.fee.toString()} differs from the expected ${expectedFee.toString()} (${tier.transferFeeBasisPoints} bps, max ${tier.maximumFee}); the chain rejects this with FeeMismatch (custom error 32). Pass fee ${expectedFee.toString()}, or force to reproduce the error.`,
        data: { ...data, providedFee: opts.fee.toString() },
      });
    } else {
      findings.push({
        code: "TRANSFER_FEE",
        severity: "info",
        message: `Mint charges a transfer fee: ${tier.transferFeeBasisPoints} bps (max ${tier.maximumFee}); expected fee ${expectedFee.toString()}, recipient receives ${net.toString()}.`,
        data,
      });
    }
  }

  // --- unchecked Transfer on a mint that needs the mint account ------------------
  // Token-2022's legacy `Transfer` carries no mint account; when the mint has
  // TransferFeeConfig or TransferHook the program cannot compute the fee /
  // call the hook and rejects with MintRequiredForTransfer (custom 31).
  if (kind === "transfer" && mint.program === "token-2022") {
    const requiresMint = (["TransferFeeConfig", "TransferHook"] as const).filter((t) => findExt(mint, t));
    if (requiresMint.length > 0) {
      findings.push({
        code: "UNCHECKED_TRANSFER_REJECTED",
        severity: "block",
        message: `instruction "transfer" (unchecked) omits the mint account, but this Token-2022 mint has ${requiresMint.join(" + ")}; the chain rejects it with MintRequiredForTransfer (custom error 31). Use instruction "transferChecked"${requiresMint.includes("TransferFeeConfig") ? ' (or "transferCheckedWithFee")' : ""}, or force to reproduce the error.`,
        data: { instruction: kind, extension: requiresMint[0], extensions: requiresMint },
      });
    }
  }

  // --- scaled UI amount ---------------------------------------------------------
  const scaled = findExt(mint, "ScaledUiAmount");
  if (scaled) {
    findings.push({
      code: "SCALED_UI_AMOUNT",
      severity: "warn",
      message: `Mint uses ScaledUiAmount (multiplier ${scaled.multiplier}); \`amount\` is the RAW base-unit amount and is NOT scaled — wallets display raw × multiplier.`,
      data: {
        multiplier: scaled.multiplier,
        newMultiplier: scaled.newMultiplier,
        newMultiplierEffectiveTimestamp: scaled.newMultiplierEffectiveTimestamp,
        amount: amount.toString(),
      },
    });
  }

  // --- source balance -------------------------------------------------------------
  if (sourceAccount === null) {
    findings.push({
      code: "SOURCE_ATA_MISSING",
      severity: "block",
      message: opts.sourceTokenAccount
        ? `Source token account ${sourceAta.toBase58()} does not exist.`
        : `Source token account ${sourceAta.toBase58()} does not exist — the owner never received this token.`,
      data: { sourceAta: sourceAta.toBase58(), sourceOwner: (opts.sourceOwner ?? opts.payer).toBase58() },
    });
  } else if (sourceAccount && BigInt(sourceAccount.amount) < amount) {
    findings.push({
      code: "INSUFFICIENT_TOKEN_BALANCE",
      severity: "block",
      message: `Source holds ${sourceAccount.amount} base units but ${amount.toString()} are needed.`,
      data: { sourceAta: sourceAta.toBase58(), balance: sourceAccount.amount, amount: amount.toString() },
    });
  }

  // --- explicit accounts must belong to this mint ----------------------------------
  for (const [role, acct, explicit] of [
    ["source", sourceAccount, opts.sourceTokenAccount],
    ["destination", destAccount, opts.destinationTokenAccount],
  ] as const) {
    if (explicit && acct && acct.mint !== mint.address) {
      findings.push({
        code: "TOKEN_ACCOUNT_MINT_MISMATCH",
        severity: "block",
        message: `${role === "source" ? "Source" : "Destination"} token account ${acct.address} holds mint ${acct.mint}, not ${mint.address}.`,
        data: { account: acct.address, role, accountMint: acct.mint, mint: mint.address },
      });
    }
  }

  // --- authority ≠ source owner: delegate / permanent delegate (T-H) --------------
  // With an explicit source account the owner is whatever the chain says.
  const effectiveOwner = opts.sourceTokenAccount
    ? sourceAccount
      ? new PublicKey(sourceAccount.owner)
      : opts.payer
    : (opts.sourceOwner ?? opts.payer);
  const authority = opts.authority ?? opts.payer;
  if (!authority.equals(effectiveOwner)) {
    const permanent = findExt(mint, "PermanentDelegate")?.delegate ?? null;
    const isPermanent = permanent !== null && permanent === authority.toBase58();
    const accountDelegate = sourceAccount ? sourceAccount.delegate : undefined;
    const isAccountDelegate = accountDelegate !== undefined && accountDelegate === authority.toBase58();
    const common = { authority: authority.toBase58(), sourceOwner: effectiveOwner.toBase58(), sourceAta: sourceAta.toBase58() };
    if (isPermanent) {
      findings.push({
        code: "PERMANENT_DELEGATE_TRANSFER",
        severity: "info",
        message: `Authority ${authority.toBase58()} is the mint's PermanentDelegate: this transfer moves funds out of ${effectiveOwner.toBase58()}'s account without the owner's signature or allowance.`,
        data: { ...common, permanentDelegate: permanent },
      });
    } else if (isAccountDelegate && sourceAccount) {
      const delegated = BigInt(sourceAccount.delegatedAmount);
      if (delegated < amount) {
        findings.push({
          code: "INSUFFICIENT_DELEGATED_AMOUNT",
          severity: "block",
          message: `Delegate ${authority.toBase58()} may move ${delegated.toString()} base units but ${amount.toString()} are requested; the owner must approve a larger allowance.`,
          data: { ...common, delegatedAmount: delegated.toString(), amount: amount.toString() },
        });
      } else {
        findings.push({
          code: "DELEGATE_TRANSFER",
          severity: "info",
          message: `Authority ${authority.toBase58()} is the approved delegate of ${sourceAta.toBase58()} (allowance ${delegated.toString()} base units).`,
          data: { ...common, delegatedAmount: delegated.toString(), amount: amount.toString() },
        });
      }
    } else if (sourceAccount) {
      // Source decoded, authority is neither its delegate nor the permanent delegate.
      findings.push({
        code: "AUTHORITY_NOT_DELEGATE",
        severity: "block",
        message: `Authority ${authority.toBase58()} is neither the owner, the approved delegate (${accountDelegate ?? "none"}) nor the mint's PermanentDelegate (${permanent ?? "none"}) of ${sourceAta.toBase58()}; the chain will reject with OwnerMismatch.`,
        data: { ...common, accountDelegate: accountDelegate ?? null, permanentDelegate: permanent },
      });
    }
    // Source absent/undecodable: SOURCE_ATA_MISSING / PREFLIGHT_INCOMPLETE already cover it.
  }

  // --- construction knobs -----------------------------------------------------------
  const deviations: Record<string, unknown> = {};
  if (kind !== "transferChecked") deviations.instruction = kind;
  if (ataMode !== "auto") deviations.ataMode = ataMode;
  if (opts.authority && !opts.authority.equals(opts.payer)) deviations.authority = opts.authority.toBase58();
  if (opts.sourceOwner && !opts.sourceOwner.equals(opts.payer)) deviations.sourceOwner = opts.sourceOwner.toBase58();
  if (opts.sourceTokenAccount) deviations.sourceTokenAccount = opts.sourceTokenAccount.toBase58();
  if (opts.destinationTokenAccount) deviations.destinationTokenAccount = opts.destinationTokenAccount.toBase58();
  if (Object.keys(deviations).length > 0) {
    findings.push({
      code: "NON_STANDARD_CONSTRUCTION",
      severity: "info",
      message: `Non-default construction knobs in use (${Object.keys(deviations).join(", ")}); the transaction is intentionally non-standard.`,
      data: deviations,
    });
  }

  return { ok: !findings.some((f) => f.severity === "block"), findings, resolved };
}

function tryDecodeAccount(
  address: PublicKey,
  info: AccountInfo<Buffer> | null,
  role: "source" | "destination",
  findings: PreflightFinding[],
): TokenAccountInspection | null | undefined {
  if (!info) return null;
  try {
    return decodeTokenAccount(address, info);
  } catch (error) {
    findings.push({
      code: "PREFLIGHT_INCOMPLETE",
      severity: "warn",
      message: `${role === "source" ? "Source" : "Destination"} token account ${address.toBase58()} exists but could not be decoded; account-level checks skipped.`,
      data: { account: address.toBase58(), role, reason: error instanceof Error ? error.message : String(error) },
    });
    return undefined;
  }
}

/** What `preflightTransferWithAccounts` read on the way, for reuse by the builder. */
export interface PreflightAccounts {
  /** Pass as the third argument of buildTransferInstructions / buildTransferPlan. */
  preloaded: PreloadedTransferAccounts;
  /** Decoded mint (absent when the mint could not be decoded). */
  mint?: MintInspection;
  /** `null` = absent; `undefined` = present but undecodable / not fetched. */
  sourceAccount?: TokenAccountInspection | null;
  destAccount?: TokenAccountInspection | null;
}

/**
 * Fetch mint + both ATAs, decode, and evaluate. SOL transfers (no mint) are
 * trivially ok. Throws MINT_NOT_FOUND when the mint is absent (building
 * would throw the same); any other decode problem degrades to a warning.
 */
export async function preflightTransfer(
  conn: ClusterConnection,
  opts: BuildTransferOptions,
): Promise<PreflightResult> {
  return (await preflightTransferWithAccounts(conn, opts)).result;
}

/**
 * `preflightTransfer` plus the accounts it fetched, so a caller that goes on
 * to build the transfer can hand them to `buildTransferInstructions` and
 * avoid reading the mint and both ATAs a second time. `accounts` is absent
 * for SOL transfers (nothing was read).
 */
export async function preflightTransferWithAccounts(
  conn: ClusterConnection,
  opts: BuildTransferOptions,
): Promise<{ result: PreflightResult; accounts?: PreflightAccounts }> {
  if (!opts.mint) return { result: { ok: true, findings: [] } };

  const mintInfo = await conn.connection.getAccountInfo(opts.mint);
  if (!mintInfo) {
    throw new SolwalletError(`Mint ${opts.mint.toBase58()} not found on cluster "${conn.cluster}".`, {
      code: "MINT_NOT_FOUND",
      hint: "Verify the mint address and the connected cluster; a mint that exists on devnet does not exist on mainnet-beta.",
    });
  }
  // Owner classification is what the builder needs; it is independent of
  // whether the mint data decodes. NOT_A_MINT is left for the builder to raise.
  let mintProgram: PreloadedTransferAccounts["mintProgram"];
  try {
    mintProgram = mintProgramFromOwner(opts.mint, mintInfo.owner);
  } catch {
    mintProgram = undefined;
  }
  let mint: MintInspection;
  try {
    mint = decodeMintAccount(opts.mint, mintInfo);
  } catch (error) {
    return {
      result: {
        ok: true,
        findings: [
          {
            code: "PREFLIGHT_INCOMPLETE",
            severity: "warn",
            message: `Mint ${opts.mint.toBase58()} could not be decoded; extension and balance checks skipped.`,
            data: { mint: opts.mint.toBase58(), reason: error instanceof Error ? error.message : String(error) },
          },
        ],
      },
      accounts: { preloaded: { mintProgram } },
    };
  }

  const programId = new PublicKey(mint.programId);
  const { sourceAta, destinationAta } = resolveTransferAtas({ ...opts, mint: opts.mint }, programId);
  const [sourceInfo, destInfo] = await Promise.all([
    conn.connection.getAccountInfo(sourceAta),
    conn.connection.getAccountInfo(destinationAta),
  ]);
  const pre: PreflightFinding[] = [];
  const sourceAccount = tryDecodeAccount(sourceAta, sourceInfo, "source", pre);
  const destAccount = tryDecodeAccount(destinationAta, destInfo, "destination", pre);

  let epoch: number | undefined;
  if (mint.extensions.some((e) => e.type === "TransferFeeConfig")) {
    epoch = (await conn.connection.getEpochInfo()).epoch;
  }

  const result = evaluatePreflight({ mint, sourceAccount, destAccount, opts, epoch });
  return {
    result: { ...result, findings: [...pre, ...result.findings] },
    accounts: {
      preloaded: {
        mintProgram,
        sourceExists: sourceInfo !== null,
        destinationExists: destInfo !== null,
      },
      mint,
      sourceAccount,
      destAccount,
    },
  };
}

/** Human summary of the block-level findings, for error messages. */
export function describeBlockers(result: PreflightResult): string {
  return result.findings
    .filter((f) => f.severity === "block")
    .map((f) => `${f.code}: ${f.message}`)
    .join(" | ");
}
