/**
 * Transaction/RPC error translation: maps raw web3.js errors and on-chain
 * program failures into {code, message, suggestion} so AI clients (and
 * humans) can self-correct without knowing Solana internals.
 */
import { SolanaJSONRPCError } from "@solana/web3.js";

import { SolwalletError, TransactionSendError } from "../connection/errors.js";

export interface ParsedProgramError {
  /** Stable machine code, e.g. INSUFFICIENT_FUNDS, BLOCKHASH_EXPIRED. */
  code: number | string;
  message: string;
  /** Recommended remediation — the whole point of this module. */
  suggestion: string;
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
      "Run dryRun() to capture the full simulation logs and identify the failing instruction.",
  },
  {
    test: /too many requests|rate limit/i,
    code: "RATE_LIMITED",
    suggestion:
      "Public RPC is throttling. Slow down, batch less, or configure a paid RPC endpoint.",
  },
];

/** Never throws — unparseable errors come back as {code: "UNKNOWN"}. */
export function parseTransactionError(error: unknown): ParsedProgramError {
  // Wrapper errors (e.g. SEND_FAILED after retries) carry the root cause —
  // the specific reason (insufficient funds, expiry…) is what's actionable.
  if (error instanceof TransactionSendError) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined) {
      const inner = parseTransactionError(cause);
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

  for (const rule of RULES) {
    if (rule.test.test(text)) {
      return { code: rule.code, message: firstLine(text), suggestion: rule.suggestion };
    }
  }

  return {
    code: "UNKNOWN",
    message: firstLine(text) || "Unknown transaction error.",
    suggestion:
      "Inspect the transaction on an explorer (by signature) and check RPC health via getHealth().",
  };
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
}
