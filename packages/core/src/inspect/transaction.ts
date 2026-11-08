/**
 * Transaction inspection: turn a `getTransaction` (jsonParsed) response into
 * token movements, per-account balance changes and warnings.
 *
 * `inspectParsedTransaction` is a pure function on the RPC JSON — the raw
 * JSON is the fixture. `inspectTransaction` either fetches by signature
 * (maxSupportedTransactionVersion: 0) or delegates for a supplied JSON.
 */
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import type { Cluster } from "../connection/cluster.js";
import type { ClusterConnection } from "../connection/connection.js";
import { SolwalletError } from "../connection/errors.js";
import type { TokenProgramKind } from "../transfer/program.js";
import { decodeInstructionError, type DecodedInstructionError } from "./errors.js";

export type MovementInstructionType =
  | "transfer"
  | "transferChecked"
  | "transferCheckedWithFee"
  | "mintTo"
  | "burn"
  | "withdrawWithheldTokensFromAccounts"
  | "withdrawWithheldTokensFromMint"
  | "harvestWithheldTokensToMint"
  | "other";

export interface MovementFee {
  /** Raw base units. */
  amount: string;
  /** `instruction`: declared by transferCheckedWithFee; `balance-delta`: declared amount − destination delta. */
  source: "instruction" | "balance-delta";
}

export interface TokenMovement {
  program: TokenProgramKind;
  programId: string;
  /** Top-level instruction index (for inner instructions: the parent's index). */
  instructionIndex: number;
  /** Position inside the parent's inner list; null for top-level. */
  innerIndex: number | null;
  isInner: boolean;
  instructionType: MovementInstructionType;
  /** Raw parsed type when instructionType is "other". */
  rawType: string | null;
  sourceAccount: string | null;
  sourceOwner: string | null;
  /** Several sources (withdrawWithheld… / harvest…). */
  sourceAccounts?: string[];
  destAccount: string | null;
  destOwner: string | null;
  authority: string | null;
  mint: string | null;
  /** Declared raw amount; null when the instruction declares none (withdraw/harvest). */
  amount: string | null;
  decimals: number | null;
  fee: MovementFee | null;
  /** Destination account post − pre (raw) across the WHOLE transaction; null when unknown. */
  balanceDelta: string | null;
}

export interface TokenBalanceChange {
  account: string;
  mint: string;
  owner: string | null;
  programId: string;
  decimals: number;
  pre: string;
  post: string;
  delta: string;
}

export interface TransactionInspection {
  signature: string;
  slot: number;
  blockTime: number | null;
  /** Lamports. */
  fee: number;
  err: unknown;
  decodedError: DecodedInstructionError | null;
  explorerUrl: string | null;
  movements: TokenMovement[];
  balanceChanges: TokenBalanceChange[];
  warnings: string[];
}

export type InspectTransactionInput =
  | { conn: ClusterConnection; signature: string }
  | { json: unknown; cluster?: Cluster; rpcUrl?: string };

export interface ExplorerTarget {
  cluster?: Cluster;
  rpcUrl?: string;
}

// --- loose shapes of the jsonParsed RPC response ---------------------------

interface ParsedIx {
  program?: string;
  programId: string;
  parsed?: { type?: string; info?: Record<string, unknown> } | string;
  accounts?: string[];
  data?: string;
}

interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

interface ParsedTxJson {
  slot?: number;
  blockTime?: number | null;
  version?: unknown;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: Array<{ pubkey: string } | string>;
      instructions: ParsedIx[];
    };
  };
  meta: {
    err: unknown;
    fee: number;
    innerInstructions?: Array<{ index: number; instructions: ParsedIx[] }> | null;
    preTokenBalances?: TokenBalanceEntry[] | null;
    postTokenBalances?: TokenBalanceEntry[] | null;
  } | null;
}

const T22 = TOKEN_2022_PROGRAM_ID.toBase58();
const SPL = TOKEN_PROGRAM_ID.toBase58();

export function explorerUrl(signature: string, target: ExplorerTarget): string | null {
  const base = `https://explorer.solana.com/tx/${signature}`;
  switch (target.cluster) {
    case "mainnet-beta":
      return base;
    case "devnet":
    case "testnet":
      return `${base}?cluster=${target.cluster}`;
    case "custom":
      return target.rpcUrl
        ? `${base}?cluster=custom&customUrl=${encodeURIComponent(target.rpcUrl)}`
        : `${base}?cluster=custom`;
    default:
      return null;
  }
}

function keyString(k: { pubkey: string } | string): string {
  return typeof k === "string" ? k : k.pubkey;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function amountOf(info: Record<string, unknown>): { amount: string | null; decimals: number | null } {
  const ta = info.tokenAmount as { amount?: string; decimals?: number } | undefined;
  if (ta && typeof ta.amount === "string") {
    return { amount: ta.amount, decimals: typeof ta.decimals === "number" ? ta.decimals : null };
  }
  return { amount: str(info.amount), decimals: null };
}

function programKind(programId: string): TokenProgramKind | null {
  if (programId === T22) return "token-2022";
  if (programId === SPL) return "spl-token";
  return null;
}

/**
 * Normalise a web3.js `ParsedTransactionWithMeta` (PublicKey objects) or a
 * raw RPC response into plain JSON. PublicKey.toJSON() yields base58.
 */
function normalise(json: unknown): ParsedTxJson {
  const tx = JSON.parse(JSON.stringify(json)) as Partial<ParsedTxJson> | null;
  if (!tx || typeof tx !== "object" || !tx.transaction?.message?.instructions || !tx.meta) {
    throw new SolwalletError("Transaction JSON is not a getTransaction(jsonParsed) response.", {
      code: "INVALID_TRANSACTION_JSON",
      hint: 'Pass the full RPC result from getTransaction(signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }), including `transaction` and `meta`.',
    });
  }
  return tx as ParsedTxJson;
}

/** Pure: inspect an already-fetched jsonParsed transaction. */
export function inspectParsedTransaction(
  json: unknown,
  target: ExplorerTarget = {},
): TransactionInspection {
  const tx = normalise(json);
  const meta = tx.meta!;
  const keys = tx.transaction.message.accountKeys.map(keyString);
  const signature = tx.transaction.signatures?.[0] ?? "";
  const warnings: string[] = [];

  // --- balance changes ------------------------------------------------------
  const pre = new Map<number, TokenBalanceEntry>();
  const post = new Map<number, TokenBalanceEntry>();
  for (const b of meta.preTokenBalances ?? []) pre.set(b.accountIndex, b);
  for (const b of meta.postTokenBalances ?? []) post.set(b.accountIndex, b);
  const indices = [...new Set([...pre.keys(), ...post.keys()])].sort((a, b) => a - b);
  const balanceChanges: TokenBalanceChange[] = [];
  const byAccount = new Map<string, TokenBalanceChange>();
  for (const i of indices) {
    const p = pre.get(i);
    const q = post.get(i);
    const any = (q ?? p)!;
    const preAmt = p?.uiTokenAmount.amount ?? "0";
    const postAmt = q?.uiTokenAmount.amount ?? "0";
    const change: TokenBalanceChange = {
      account: keys[i] ?? `#${i}`,
      mint: any.mint,
      owner: q?.owner ?? p?.owner ?? null,
      programId: any.programId ?? "",
      decimals: any.uiTokenAmount.decimals,
      pre: preAmt,
      post: postAmt,
      delta: (BigInt(postAmt) - BigInt(preAmt)).toString(),
    };
    balanceChanges.push(change);
    byAccount.set(change.account, change);
  }

  // --- owner / mint hints from account-creation instructions ----------------
  const ownerHints = new Map<string, string>();
  const mintHints = new Map<string, string>();
  const allIxs: Array<{ ix: ParsedIx; index: number; innerIndex: number | null }> = [];
  tx.transaction.message.instructions.forEach((ix, index) =>
    allIxs.push({ ix, index, innerIndex: null }),
  );
  for (const group of meta.innerInstructions ?? []) {
    group.instructions.forEach((ix, innerIndex) =>
      allIxs.push({ ix, index: group.index, innerIndex }),
    );
  }
  for (const { ix } of allIxs) {
    const parsed = typeof ix.parsed === "object" ? ix.parsed : undefined;
    const info = parsed?.info ?? {};
    const account = str(info.account);
    if (!account) continue;
    const t = parsed?.type ?? "";
    if (ix.program === "spl-associated-token-account" && str(info.wallet)) {
      ownerHints.set(account, str(info.wallet)!);
      if (str(info.mint)) mintHints.set(account, str(info.mint)!);
    } else if (/^initializeAccount/.test(t) && str(info.owner)) {
      ownerHints.set(account, str(info.owner)!);
      if (str(info.mint)) mintHints.set(account, str(info.mint)!);
    }
  }
  const ownerOf = (account: string | null): string | null =>
    account ? (byAccount.get(account)?.owner ?? ownerHints.get(account) ?? null) : null;
  const mintOf = (account: string | null): string | null =>
    account ? (byAccount.get(account)?.mint ?? mintHints.get(account) ?? null) : null;

  // --- movements -------------------------------------------------------------
  const movements: TokenMovement[] = [];
  for (const { ix, index, innerIndex } of allIxs) {
    const kind = programKind(ix.programId);
    if (!kind) continue;
    const parsed = typeof ix.parsed === "object" ? ix.parsed : undefined;
    const where = innerIndex === null ? `instruction ${index}` : `inner instruction ${index}.${innerIndex}`;
    if (!parsed || !parsed.type) {
      warnings.push(`Unparsable ${kind} ${where}: RPC returned no jsonParsed decoding.`);
      continue;
    }
    const type = parsed.type;
    const info = parsed.info ?? {};
    if (/^confidentialTransfer/i.test(type)) {
      warnings.push(`ConfidentialTransfer instruction (${type}) at ${where}: amounts are encrypted and not reflected in movements.`);
      continue;
    }
    const base = {
      program: kind,
      programId: ix.programId,
      instructionIndex: index,
      innerIndex,
      isInner: innerIndex !== null,
      rawType: null as string | null,
      fee: null as MovementFee | null,
      balanceDelta: null as string | null,
    };
    const authority = str(info.authority) ?? str(info.multisigAuthority) ?? str(info.mintAuthority) ?? str(info.withdrawWithheldAuthority) ?? str(info.multisigWithdrawWithheldAuthority);
    let m: TokenMovement;
    switch (type) {
      case "transfer":
      case "transferChecked":
      case "transferCheckedWithFee": {
        const source = str(info.source);
        const dest = str(info.destination);
        const { amount, decimals } = amountOf(info);
        m = {
          ...base,
          instructionType: type,
          sourceAccount: source,
          sourceOwner: ownerOf(source),
          destAccount: dest,
          destOwner: ownerOf(dest),
          authority,
          mint: str(info.mint) ?? mintOf(source) ?? mintOf(dest),
          amount,
          decimals,
        };
        if (type === "transferCheckedWithFee") {
          const fee = info.feeAmount as { amount?: string } | undefined;
          if (fee && typeof fee.amount === "string") m.fee = { amount: fee.amount, source: "instruction" };
        }
        break;
      }
      case "mintTo":
      case "mintToChecked": {
        const dest = str(info.account);
        const { amount, decimals } = amountOf(info);
        m = {
          ...base,
          instructionType: "mintTo",
          rawType: type === "mintTo" ? null : type,
          sourceAccount: null,
          sourceOwner: null,
          destAccount: dest,
          destOwner: ownerOf(dest),
          authority,
          mint: str(info.mint) ?? mintOf(dest),
          amount,
          decimals,
        };
        break;
      }
      case "burn":
      case "burnChecked": {
        const source = str(info.account);
        const { amount, decimals } = amountOf(info);
        m = {
          ...base,
          instructionType: "burn",
          rawType: type === "burn" ? null : type,
          sourceAccount: source,
          sourceOwner: ownerOf(source),
          destAccount: null,
          destOwner: null,
          authority,
          mint: str(info.mint) ?? mintOf(source),
          amount,
          decimals,
        };
        break;
      }
      case "withdrawWithheldTokensFromAccounts":
      case "withdrawWithheldTokensFromMint":
      case "harvestWithheldTokensToMint": {
        const sources = Array.isArray(info.sourceAccounts)
          ? (info.sourceAccounts as unknown[]).filter((s): s is string => typeof s === "string")
          : [];
        const dest = type === "harvestWithheldTokensToMint" ? str(info.mint) : str(info.feeRecipient);
        m = {
          ...base,
          instructionType: type,
          sourceAccount: type === "withdrawWithheldTokensFromMint" ? str(info.mint) : null,
          sourceOwner: null,
          sourceAccounts: sources.length ? sources : undefined,
          destAccount: dest,
          destOwner: type === "harvestWithheldTokensToMint" ? null : ownerOf(dest),
          authority,
          mint: str(info.mint),
          amount: null,
          decimals: null,
        };
        break;
      }
      default:
        continue; // approve/close/initialize… are not token movements
    }
    movements.push(m);
  }

  // Balance deltas are whole-transaction figures: only attribute one to a
  // movement when its destination is touched by no other movement.
  const touches = new Map<string, number>();
  for (const m of movements) {
    for (const a of [m.sourceAccount, m.destAccount, ...(m.sourceAccounts ?? [])]) {
      if (a) touches.set(a, (touches.get(a) ?? 0) + 1);
    }
  }
  for (const m of movements) {
    if (!m.destAccount) continue;
    const change = byAccount.get(m.destAccount);
    if (!change) continue;
    m.balanceDelta = change.delta;
    const unique = touches.get(m.destAccount) === 1;
    if (
      unique &&
      m.fee === null &&
      m.amount !== null &&
      m.program === "token-2022" &&
      (m.instructionType === "transfer" || m.instructionType === "transferChecked")
    ) {
      const diff = BigInt(m.amount) - BigInt(change.delta);
      if (diff > 0n) m.fee = { amount: diff.toString(), source: "balance-delta" };
    }
  }

  // --- errors ----------------------------------------------------------------
  let decodedError: DecodedInstructionError | null = null;
  if (meta.err) {
    decodedError = decodeInstructionError(meta.err, {
      message: { instructions: tx.transaction.message.instructions },
    });
    const label = decodedError
      ? decodedError.customCode !== null
        ? `custom error ${decodedError.customCode}${decodedError.name ? ` (${decodedError.name})` : ""} in instruction ${decodedError.instructionIndex}${decodedError.programId ? ` of program ${decodedError.programId}` : ""}`
        : `${decodedError.kind ?? "error"} in instruction ${decodedError.instructionIndex}`
      : JSON.stringify(meta.err);
    warnings.push(`Transaction failed: ${label}. No token movement took effect.`);
  }

  return {
    signature,
    slot: tx.slot ?? 0,
    blockTime: tx.blockTime ?? null,
    fee: meta.fee,
    err: meta.err ?? null,
    decodedError,
    explorerUrl: signature ? explorerUrl(signature, target) : null,
    movements,
    balanceChanges,
    warnings,
  };
}

/** Fetch by signature (or take JSON) and inspect. */
export async function inspectTransaction(input: InspectTransactionInput): Promise<TransactionInspection> {
  if ("json" in input) {
    return inspectParsedTransaction(input.json, { cluster: input.cluster, rpcUrl: input.rpcUrl });
  }
  const { conn, signature } = input;
  const tx = await conn.connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) {
    throw new SolwalletError(`Transaction ${signature} not found on cluster "${conn.cluster}".`, {
      code: "TRANSACTION_NOT_FOUND",
      hint: "Check the signature and cluster; RPC nodes keep only recent history unless they serve archival data.",
    });
  }
  return inspectParsedTransaction(tx, { cluster: conn.cluster, rpcUrl: conn.rpcUrl });
}
