/**
 * Exact base-units <-> display conversions using bigint + string math only.
 * Floating point never touches amounts (0.1+0.2 problems are fund-loss bugs).
 */
import { SolwalletError } from "../connection/errors.js";

/**
 * Format a raw base-unit amount for display.
 * "123456789" @6 decimals → "123.456789"; trailing zeros are trimmed.
 */
export function formatAmount(rawAmount: bigint, decimals: number): string {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new SolwalletError(`Invalid decimals: ${decimals}`, {
      code: "DECIMALS_INVALID",
    });
  }
  const negative = rawAmount < 0n;
  const abs = negative ? -rawAmount : rawAmount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;

  let out: string;
  if (decimals === 0 || frac === 0n) {
    out = whole.toString();
  } else {
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    out = `${whole}.${fracStr}`;
  }
  return (negative ? "-" : "") + out;
}

/**
 * Parse a display amount into exact base units.
 * Rejects negatives, junk, scientific notation, and fractions more precise
 * than `decimals` (silently rounding amounts is how funds get lost).
 */
export function parseAmount(displayAmount: string, decimals: number): bigint {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new SolwalletError(`Invalid decimals: ${decimals}`, {
      code: "DECIMALS_INVALID",
    });
  }
  const s = displayAmount.trim();
  const m = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(s);
  if (!m) {
    throw new SolwalletError(`Invalid amount: "${displayAmount}".`, {
      code: "AMOUNT_INVALID",
      hint: "Use plain decimal notation like 1.5 — no signs, scientific notation, or separators.",
    });
  }
  const whole = m[1] ?? "0";
  const frac = m[2] ?? m[3] ?? "";
  if (frac.length > decimals) {
    throw new SolwalletError(
      `Amount "${displayAmount}" has ${frac.length} decimals; this mint supports at most ${decimals}.`,
      {
        code: "AMOUNT_TOO_PRECISE",
        hint: `Use at most ${decimals} decimal places to avoid silently rounding away funds.`,
      },
    );
  }
  const paddedFrac = frac.padEnd(decimals, "0");
  return BigInt(whole + paddedFrac);
}

/** Lamports → SOL display string (9 decimals). */
export function lamportsToSol(lamports: bigint | number): string {
  return formatAmount(BigInt(lamports), 9);
}

/** SOL display string → lamports. */
export function solToLamports(sol: string): bigint {
  return parseAmount(sol, 9);
}
