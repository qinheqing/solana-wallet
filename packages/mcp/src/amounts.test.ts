import { describe, expect, it } from "vitest";

import { baseUnitParam, display, parseBaseUnits, solDisplay, withDisplay } from "./amounts.js";

describe("withDisplay / display helpers", () => {
  it("pairs raw base units with an exact display string", () => {
    expect(withDisplay("1500000000", 9, "SOL")).toEqual({ amount: "1500000000", display: "1.5 SOL" });
    expect(withDisplay(1_500_000n, 6)).toEqual({ amount: "1500000", display: "1.5 (6 dp)" });
    expect(withDisplay(1, 6)).toEqual({ amount: "1", display: "0.000001 (6 dp)" });
    expect(withDisplay("0", 0)).toEqual({ amount: "0", display: "0 (0 dp)" });
    expect(withDisplay(5000, 9, "SOL").display).toBe("0.000005 SOL");
  });

  it("keeps the raw value exact for large and negative amounts", () => {
    const big = "123456789012345678901234567890";
    expect(withDisplay(big, 18).amount).toBe(big);
    expect(withDisplay(big, 18).display).toBe("123456789012.34567890123456789 (18 dp)");
    expect(display("-990000", 6)).toBe("-0.99 (6 dp)");
  });

  it("display() and solDisplay() are null-safe", () => {
    expect(display(null, 6)).toBeNull();
    expect(display("1", null)).toBeNull();
    expect(display(undefined, undefined)).toBeNull();
    expect(solDisplay(null)).toBeNull();
    expect(solDisplay(5000)).toBe("0.000005 SOL");
    expect(solDisplay("1000000000")).toBe("1 SOL");
  });
});

describe("parseBaseUnits", () => {
  it("accepts integer strings and rejects everything human-readable", () => {
    expect(parseBaseUnits("1000000000", "amount", { kind: "SOL" })).toBe(1_000_000_000n);
    expect(parseBaseUnits(" 42 ", "amount")).toBe(42n);
    for (const bad of ["1.5", "-5", "1e9", "", "abc", "1,000"]) {
      expect(() => parseBaseUnits(bad, "amount", { kind: "SOL" })).toThrow(/base units/);
    }
  });

  it("explains the unit convention in the error", () => {
    expect(() => parseBaseUnits("1.5", "amount", { kind: "SOL" })).toThrow(/1 SOL = 1000000000/);
    expect(() => parseBaseUnits("1.5", "legs[0].amount", { kind: "token", decimals: 6 })).toThrow(/"1500000"/);
    expect(() => parseBaseUnits("1.5", "amount")).toThrow(/NOT human-readable/);
  });

  it("refuses zero unless allowZero", () => {
    expect(() => parseBaseUnits("0", "amount")).toThrow(/greater than 0/);
    expect(parseBaseUnits("0", "amount", { allowZero: true })).toBe(0n);
  });
});

describe("baseUnitParam", () => {
  it("builds a zod string schema with the base-unit regex and an explanatory description", async () => {
    const { z } = await import("zod");
    const schema = baseUnitParam(z, "Amount");
    expect(schema.safeParse("123").success).toBe(true);
    expect(schema.safeParse("1.5").success).toBe(false);
    expect(schema.safeParse(123).success).toBe(false);
    expect(schema.description).toMatch(/BASE UNITS/);
    expect(schema.description).toMatch(/1 SOL = "1000000000"/);
  });
});
