import { SolanaJSONRPCError } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { parseTransactionError } from "./parse-error.js";

describe("parseTransactionError (4.2)", () => {
  it("maps insufficient funds from message text", () => {
    const e = new Error("Error: insufficient funds for rent");
    const p = parseTransactionError(e);
    expect(p.code).toBe("INSUFFICIENT_FUNDS");
    expect(p.suggestion).toMatch(/airdrop/);
  });

  it("maps token custom program error 0x1", () => {
    const e = new Error("failed to send transaction: custom program error: 0x1");
    expect(parseTransactionError(e).code).toBe("INSUFFICIENT_FUNDS");
  });

  it("maps unfunded-destination errors", () => {
    const e = new Error("Attempt to debit an account but found no record of a prior credit.");
    const p = parseTransactionError(e);
    expect(p.code).toBe("ACCOUNT_NOT_FUNDED");
    expect(p.suggestion).toMatch(/ATA creation/);
  });

  it("maps blockhash expiry", () => {
    const e = new Error("Blockhash has expired, block height exceeded.");
    expect(parseTransactionError(e).code).toBe("BLOCKHASH_EXPIRED");
  });

  it("reads SendTransactionError logs (simulated failure detail)", () => {
    const e = Object.assign(new Error("Transaction simulation failed"), {
      logs: ["Program log: AccountNotFound"],
    });
    expect(parseTransactionError(e).code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("maps RPC 429 to RATE_LIMITED", () => {
    const e = new SolanaJSONRPCError({ code: 429, message: "Too many requests" });
    const p = parseTransactionError(e);
    expect(p.code).toBe("RATE_LIMITED");
    expect(p.suggestion).toMatch(/paid RPC/);
  });

  it("never throws on unparseable shapes", () => {
    expect(parseTransactionError(undefined).code).toBe("UNKNOWN");
    expect(parseTransactionError(42).code).toBe("UNKNOWN");
    expect(parseTransactionError(new Error("weird")).code).toBe("UNKNOWN");
  });

  it("every rule produces an actionable suggestion", () => {
    const samples = [
      new Error("insufficient funds"),
      new Error("BlockhashNotFound"),
      new Error("Account does not exist"),
      new Error("owner does not match"),
      new Error("Transaction simulation failed: some log"),
    ];
    for (const s of samples) {
      expect(parseTransactionError(s).suggestion.length).toBeGreaterThan(20);
    }
  });
});
