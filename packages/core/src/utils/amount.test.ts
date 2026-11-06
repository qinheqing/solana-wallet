import { describe, expect, it } from "vitest";
import {
  formatAmount,
  lamportsToSol,
  parseAmount,
  solToLamports,
} from "./amount.js";

describe("formatAmount (4.1)", () => {
  it("formats with exact precision", () => {
    expect(formatAmount(123456789n, 6)).toBe("123.456789");
    expect(formatAmount(1n, 9)).toBe("0.000000001");
    expect(formatAmount(1_000_000_000n, 9)).toBe("1");
    expect(formatAmount(0n, 0)).toBe("0");
    expect(formatAmount(123n, 0)).toBe("123");
  });

  it("trims trailing zeros", () => {
    expect(formatAmount(1_500_000_000n, 9)).toBe("1.5");
    expect(formatAmount(1_234_500_000n, 9)).toBe("1.2345");
  });

  it("handles huge values without float loss", () => {
    // 2^80 / 10^6 — far beyond Number.MAX_SAFE_INTEGER, exact via bigint.
    expect(formatAmount(2n ** 80n, 6)).toBe("1208925819614629174.706176");
    expect(formatAmount(10n ** 18n + 1n, 6)).toBe("1000000000000.000001");
  });

  it("supports negatives", () => {
    expect(formatAmount(-1_500_000_000n, 9)).toBe("-1.5");
  });
});

describe("parseAmount (4.1)", () => {
  it("parses exact base units", () => {
    expect(parseAmount("123.456789", 6)).toBe(123456789n);
    expect(parseAmount("1", 9)).toBe(1_000_000_000n);
    expect(parseAmount("0.000000001", 9)).toBe(1n);
    expect(parseAmount("0", 0)).toBe(0n);
  });

  it("accepts '.5' style fractions", () => {
    expect(parseAmount(".5", 6)).toBe(500000n);
  });

  it("rejects silent precision loss", () => {
    expect(() => parseAmount("1.0000001", 6)).toThrowError(/at most 6/);
  });

  it("rejects junk, signs, and scientific notation", () => {
    for (const bad of ["", ".", "1.2.3", "abc", "-1", "+1", "1e9", "1_000", "1,5"]) {
      expect(() => parseAmount(bad, 9), bad).toThrowError(/Invalid amount/);
    }
  });

  it("roundtrips formatAmount ↔ parseAmount", () => {
    for (const raw of [0n, 1n, 999n, 10n ** 12n + 123n, 5n * 10n ** 8n]) {
      expect(parseAmount(formatAmount(raw, 6), 6)).toBe(raw);
    }
  });
});

describe("SOL helpers", () => {
  it("lamportsToSol", () => {
    expect(lamportsToSol(2_500_000_000)).toBe("2.5");
    expect(lamportsToSol(1n)).toBe("0.000000001");
  });
  it("solToLamports", () => {
    expect(solToLamports("2.5")).toBe(2_500_000_000n);
  });
});
