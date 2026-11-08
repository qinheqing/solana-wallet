/**
 * Transaction/RPC error translation: maps raw web3.js errors and on-chain
 * program failures into {code, message, suggestion} so AI clients (and
 * humans) can self-correct without knowing Solana internals.
 */
import { PublicKey, SolanaJSONRPCError } from "@solana/web3.js";

import { SolwalletError, TransactionSendError } from "../connection/errors.js";
import { decodeInstructionError, isTokenProgramId, programIdFromLogs } from "../inspect/errors.js";

export interface ParsedProgramError {
  /** Stable machine code, e.g. INSUFFICIENT_FUNDS, BLOCKHASH_EXPIRED. */
  code: number | string;
  message: string;
  /** Recommended remediation — the whole point of this module. */
  suggestion: string;
  /**
   * Decoded on-chain custom error. `name` (and a `TOKEN_<Name>` code) is
   * only set when the failing program is known to be SPL Token / Token-2022;
   * `programId: null` means the program could not be attributed.
   */
  custom?: { code: number; name?: string; instructionIndex?: number; programId: string | null };
}

export interface ParseTransactionErrorOptions {
  /**
   * Program the caller expects to have produced a custom error (e.g. the
   * token program of a transfer). Used only when the error itself does not
   * say which program failed (simulation logs name it explicitly).
   */
  programId?: string | PublicKey;
}

interface Rule {
  test: RegExp;
  code: string;
  suggestion: string;
}

/** Known failure signatures from Solana validator + program logs. */
const RULES: Rule[] = [
  {
    test: /insufficient funds|InsufficientFunds|custom program error: 0x1\b/i,
    code: "INSUFFICIENT_FUNDS",
    suggestion:
      "The payer lacks SOL for rent+fees, or the token account lacks token balance. Check getWalletBalance; on devnet/testnet request an airdrop.",
  },
  {
    test: /Attempt to debit an account but found no record of a prior credit/i,
    code: "ACCOUNT_NOT_FUNDED",
    suggestion:
      "The destination account has never been funded. Transfer SOL first or enable automatic ATA creation.",
  },
  {
    test: /blockhash.*expired|block height exceeded|BlockhashNotFound/i,
    code: "BLOCKHASH_EXPIRED",
    suggestion:
      "Rebuild the transaction with a fresh blockhash and resend — do not retry the raw transaction as-is.",
  },
  {
    test: /AccountNotFound|Account does not exist/i,
    code: "ACCOUNT_NOT_FOUND",
    suggestion:
      "A referenced account (mint/ATA/owner) does not exist on this cluster. Verify the cluster and that the mint was created.",
  },
  {
    test: /owner.*not match|Invalid account owner|OwnerMismatch/i,
    code: "ACCOUNT_OWNER_MISMATCH",
    suggestion:
      "A token account belongs to a different owner. Verify the destination address is a wallet address (not an ATA) for token transfers.",
  },
  {
    test: /Transaction simulation failed/i,
    code: "SIMULATION_FAILED",
    suggestion:
      "The validator's simulation rejected the transaction: read `logs` (the `Program <id> failed` line names the failing program) and `error.custom` (decoded code / Token enum name), then fix the inputs. If this was a forced send over a preflight block, the block finding already explains the cause — drop `force` once fixed. Without logs, call dryRun() to capture them.",
  },
  {
    test: /too many requests|rate limit/i,
    code: "RATE_LIMITED",
    suggestion:
      "Public RPC is throttling. Slow down, batch less, or configure a paid RPC endpoint.",
  },
  {
    test: /faucet is closed|faucet.*unavailable/i,
    code: "FAUCET_UNAVAILABLE",
    suggestion:
      "The built-in RPC faucet is closed. request_airdrop falls back to the web faucet API (faucet.solana.com) automatically; if that also fails, request SOL manually at https://faucet.solana.com (rate-limited per IP).",
  },
];

/** Never throws — unparseable errors come back as {code: "UNKNOWN"}. */
export function parseTransactionError(
  error: unknown,
  options: ParseTransactionErrorOptions = {},
): ParsedProgramError {
  // Wrapper errors (e.g. SEND_FAILED after retries) carry the root cause —
  // the specific reason (insufficient funds, expiry…) is what's actionable.
  if (error instanceof TransactionSendError) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined) {
      const inner = parseTransactionError(cause, options);
      if (inner.code !== "UNKNOWN") return inner;
    }
    return { code: error.code, message: error.message, suggestion: error.hint ?? "" };
  }
  // Other structured errors already carry code + hint — pass them through.
  if (error instanceof SolwalletError) {
    return { code: error.code, message: error.message, suggestion: error.hint ?? "" };
  }
  if (error instanceof SolanaJSONRPCError) {
    const code: number | string =
      typeof error.code === "number" || typeof error.code === "string"
        ? error.code
        : "RPC_ERROR";
    if (code === 429 || code === -32005) {
      return {
        code: "RATE_LIMITED",
        message: error.message,
        suggestion:
          "Public RPC is throttling. Slow down, batch less, or configure a paid RPC endpoint.",
      };
    }
    return {
      code,
      message: error.message,
      suggestion: `RPC call failed with code ${code}. Check RPC endpoint health with getHealth().`,
    };
  }

  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message: unknown }).message === "string"
        ? (error as { message: string }).message
        : String(error);

  const text = [
    rawMessage,
    // SendTransactionError carries program logs on the instance.
    (error as { logs?: string[] } | null)?.logs?.join("\n") ?? "",
    (error as Error & { transactionError?: { message?: string } })?.transactionError?.message ?? "",
  ].join("\n");

  const custom = customErrorOf(error, text, options.programId);

  // Regex rules keep their stable codes; a decoded custom error rides along
  // so callers still see the exact code/name instead of being shadowed.
  for (const rule of RULES) {
    if (rule.test.test(text)) {
      // Simulation failures: surface the log line that names the failing
      // program / custom code so the message is self-explanatory.
      const detail = rule.code === "SIMULATION_FAILED" ? failingLogLine(text) : undefined;
      const head = firstLine(text);
      const message = detail && !head.includes(detail) ? `${head} — ${detail}` : head;
      return { code: rule.code, message, suggestion: rule.suggestion, ...(custom ? { custom } : {}) };
    }
  }

  if (custom?.name) {
    return {
      code: `TOKEN_${custom.name}`,
      message: firstLine(text),
      suggestion: TOKEN_ERROR_SUGGESTIONS[custom.name] ?? `On-chain token program error ${custom.name} (code ${custom.code}).`,
      custom,
    };
  }
  if (custom) {
    const where = custom.programId ? `program ${custom.programId}` : "an unidentified program";
    return {
      code: "PROGRAM_ERROR",
      message: firstLine(text),
      suggestion: `Instruction ${custom.instructionIndex ?? "?"} (${where}) returned custom error ${custom.code}. Decode it against that program's error enum; simulate with dryRun to get logs naming the failing program.`,
      custom,
    };
  }

  return {
    code: "UNKNOWN",
    message: firstLine(text) || "Unknown transaction error.",
    suggestion:
      "Inspect the transaction on an explorer (by signature) and check RPC health via getHealth().",
  };
}

/**
 * Pull `custom` out of an error object / message text. The program is taken
 * from the logs when they name it (`Program <id> failed: custom program
 * error`), else from the caller's hint; a token error name is only attached
 * when that program is SPL Token / Token-2022.
 */
function customErrorOf(
  error: unknown,
  text: string,
  hint: string | PublicKey | undefined,
): ParsedProgramError["custom"] | undefined {
  const errObj =
    error && typeof error === "object"
      ? ((error as { err?: unknown; transactionError?: unknown }).err ??
        (error as { transactionError?: unknown }).transactionError)
      : undefined;
  const fromLogs = programIdFromLogs(text);
  const programId =
    fromLogs ?? (hint === undefined ? undefined : typeof hint === "string" ? hint : hint.toBase58());
  const opts = programId ? { programId } : {};
  const decoded = decodeInstructionError(errObj, opts) ?? decodeInstructionError(text, opts);
  if (!decoded || decoded.customCode === null) return undefined;
  return {
    code: decoded.customCode,
    ...(decoded.name && isTokenProgramId(decoded.programId) ? { name: decoded.name } : {}),
    ...(decoded.instructionIndex !== null ? { instructionIndex: decoded.instructionIndex } : {}),
    programId: decoded.programId,
  };
}

const TOKEN_ERROR_SUGGESTIONS: Record<string, string> = {
  InsufficientFunds: "The token account lacks balance for this transfer (or the payer lacks SOL). Check getWalletBalance / inspectTokenAccount.",
  MintMismatch: "A token account belongs to a different mint than the one passed. Derive the ATA for this exact mint with deriveTokenAddresses.",
  OwnerMismatch: "The signing authority is not the owner/delegate of the source token account.",
  AccountFrozen: "The token account is frozen; the freeze authority must thaw it first.",
  MintDecimalsMismatch: "transferChecked decimals do not match the mint. Read decimals with inspectMint.",
  NoMemo: "The destination enabled MemoTransfer: prepend a Memo instruction to the transfer.",
  NonTransferable: "The mint is NonTransferable; tokens cannot move (only burn).",
  FeeMismatch: "transferCheckedWithFee declared a fee that does not match the mint's current TransferFeeConfig. Recompute from inspectMint.",
  CpiGuardTransferBlocked: "The source account has CpiGuard; transfers via CPI are blocked unless signed by the owner at the top level.",
  TransferFeeExceedsMaximum: "Transfer fee basis points exceed the 10000 cap.",
  MintPaused: "The mint is paused by its pause authority; wait for it to resume.",
};

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
}

/** The log line naming the failing program, else the first custom-code / error log line. */
function failingLogLine(text: string): string | undefined {
  const lines = text.split("\n").map((l) => l.trim());
  return (
    lines.find((l) => /^Program [1-9A-HJ-NP-Za-km-z]{32,44} failed:/i.test(l)) ??
    lines.find((l) => /^Program log: Error:/i.test(l)) ??
    lines.find((l) => /custom program error: 0x/i.test(l))
  );
}
