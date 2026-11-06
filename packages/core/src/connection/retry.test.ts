import {
  SolanaJSONRPCError,
  TransactionExpiredBlockheightExceededError,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIRM_POLICY, shouldRetrySend } from "./connection.js";
import { TransactionSendError } from "./errors.js";

const policy = DEFAULT_CONFIRM_POLICY; // retries: 5

describe("shouldRetrySend (user policy: exponential backoff, 5 retries)", () => {
  it("retries network errors up to the limit", () => {
    const netErr = new TypeError("fetch failed");
    for (let a = 1; a < 5; a++) {
      expect(shouldRetrySend(netErr, a, policy)).toBe(true);
    }
  });

  it("stops at the retry limit", () => {
    const netErr = new TypeError("fetch failed");
    expect(shouldRetrySend(netErr, 5, policy)).toBe(false);
    expect(shouldRetrySend(netErr, 6, policy)).toBe(false);
  });

  it("never retries on-chain program failures", () => {
    const chainErr = new TransactionSendError("insufficient funds", {
      code: "TRANSACTION_FAILED",
      signature: "SIG",
    });
    expect(shouldRetrySend(chainErr, 1, policy)).toBe(false);
  });

  it("never retries blockhash expiry (needs re-signing, not resending)", () => {
    const expiry = new TransactionExpiredBlockheightExceededError("expired");
    expect(shouldRetrySend(expiry, 1, policy)).toBe(false);
  });

  it("never retries deterministic simulation failures (real-world finding)", () => {
    // Discovered in live devnet usage: unfunded-account failures retried 5×.
    const debit = new Error(
      "Simulation failed. Message: Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.",
    );
    expect(shouldRetrySend(debit, 1, policy)).toBe(false);
    expect(
      shouldRetrySend(new Error("custom program error: 0x1"), 1, policy),
    ).toBe(false);
    expect(shouldRetrySend(new Error("AccountNotFound"), 1, policy)).toBe(false);
  });

  it("retries rate limits (429) and server errors (5xx)", () => {
    const rateLimited = new SolanaJSONRPCError({ code: 429, message: "rate limited" });
    const serverDown = new SolanaJSONRPCError({ code: 502, message: "bad gateway" });
    expect(shouldRetrySend(rateLimited, 1, policy)).toBe(true);
    expect(shouldRetrySend(serverDown, 1, policy)).toBe(true);
  });

  it("does not retry deterministic RPC request errors (4xx)", () => {
    const badRequest = new SolanaJSONRPCError({ code: 400, message: "invalid request" });
    expect(shouldRetrySend(badRequest, 1, policy)).toBe(false);
  });

  it("retries unknown error shapes (default permissive)", () => {
    expect(shouldRetrySend(new Error("mystery"), 1, policy)).toBe(true);
    expect(shouldRetrySend("string error", 1, policy)).toBe(true);
  });
});
