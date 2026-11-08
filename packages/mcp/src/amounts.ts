/**
 * Amount conventions for the MCP surface.
 *
 * INPUT: every amount is an integer string in BASE UNITS (lamports for SOL,
 * token base units for mints) — exactly what a block explorer shows. No
 * human-readable decimals anywhere; "1.5" is rejected with INVALID_INPUT.
 *
 * OUTPUT: raw base units stay in the primary field (`amount`,
 * `amountBaseUnits`, `feeLamports`, `solLamports`, …) and a sibling
 * `*Display` string ("1.5 SOL", "0.25 (6 dp)") is added as a reading aid.
 * Display strings are derived with core's exact bigint formatter — they are
 * never used as inputs.
 */
import { formatAmount, inspectMint, type ClusterConnection } from "@solwallet/core";
import type { PublicKey } from "@solana/web3.js";

export const SOL_DECIMALS = 9;
export const LAMPORTS_PER_SOL_STR = "1000000000";

const BASE_UNITS_RE = /^\d+$/;

export interface AmountWithDisplay {
  /** Raw base units (integer string). */
  amount: string;
  /** Human-readable hint, e.g. "1.5 SOL" or "0.25 (6 dp)". */
  display: string;
}

/**
 * Pair a raw base-unit amount with its display form. `symbol` is appended
 * when known ("SOL"); otherwise the decimals are noted so the reader knows
 * how the number was scaled.
 */
export function withDisplay(
  amountBaseUnits: string | bigint | number,
  decimals: number,
  symbol?: string,
): AmountWithDisplay {
  const raw = typeof amountBaseUnits === "bigint" ? amountBaseUnits : BigInt(amountBaseUnits);
  const formatted = formatAmount(raw, decimals);
  return {
    amount: raw.toString(),
    display: symbol ? `${formatted} ${symbol}` : `${formatted} (${decimals} dp)`,
  };
}

/** Display string only (null-safe: returns null when the amount is unknown). */
export function display(
  amountBaseUnits: string | bigint | number | null | undefined,
  decimals: number | null | undefined,
  symbol?: string,
): string | null {
  if (amountBaseUnits === null || amountBaseUnits === undefined) return null;
  if (decimals === null || decimals === undefined) return null;
  return withDisplay(amountBaseUnits, decimals, symbol).display;
}

/** "1.5 SOL" for a lamport amount. */
export function solDisplay(lamports: string | bigint | number | null | undefined): string | null {
  return display(lamports, SOL_DECIMALS, "SOL");
}

/**
 * Parse a base-unit input string. Throws an input-shaped error (caught as
 * INVALID_INPUT by the server) that explains the unit convention.
 */
export function parseBaseUnits(
  value: string,
  field: string,
  opts: { allowZero?: boolean; decimals?: number; kind?: "SOL" | "token" } = {},
): bigint {
  if (typeof value !== "string" || !BASE_UNITS_RE.test(value.trim())) {
    const hint =
      opts.kind === "SOL"
        ? `${field} is lamports: 1 SOL = ${LAMPORTS_PER_SOL_STR}, 0.5 SOL = "500000000".`
        : opts.decimals !== undefined
          ? `${field} is token base units: 1.5 tokens at ${opts.decimals} decimals = "${(15n * 10n ** BigInt(Math.max(opts.decimals - 1, 0))).toString()}".`
          : `${field} is base units (lamports / token base units × 10^decimals): e.g. 1 SOL = ${LAMPORTS_PER_SOL_STR}, 1.5 tokens at 6 decimals = "1500000".`;
    throw new Error(
      `Invalid amount: ${field} must be an integer string in base units (got "${value}"). This field is NOT human-readable: ${hint}`,
    );
  }
  const raw = BigInt(value.trim());
  if (raw === 0n && !opts.allowZero) {
    throw new Error(`Invalid amount: ${field} must be greater than 0 (base units).`);
  }
  return raw;
}

/** Zod schema for a base-unit amount parameter with a convention-explaining description. */
export function baseUnitParam(z: typeof import("zod").z, what: string) {
  return z
    .string()
    .regex(BASE_UNITS_RE, "must be an integer string in base units (lamports / token base units)")
    .describe(
      `${what} in BASE UNITS as an integer string (lamports for SOL, token base units = tokens × 10^decimals). NOT human-readable: 1 SOL = "1000000000", 1.5 tokens at 6 decimals = "1500000". Outputs echo the raw value plus a *Display hint.`,
    );
}

/** Description text for optional `decimals` on token tools (auto-resolved from the mint). */
export const DECIMALS_OPTIONAL_DESC =
  "Mint decimals (0–18). Optional: resolved from the mint on chain when omitted; passing it saves one RPC read. Used for transferChecked validation and for the *Display hints — it does NOT scale the amount (amounts are always base units).";

/**
 * Resolve the decimals for a token operation: use the caller's value when
 * given, otherwise read the mint. Returns undefined for SOL (no mint).
 */
export async function resolveDecimals(
  conn: ClusterConnection,
  mint: string | PublicKey | undefined,
  provided: number | undefined,
): Promise<number | undefined> {
  if (!mint) return undefined;
  if (provided !== undefined) return provided;
  return (await inspectMint(conn, mint)).decimals;
}

/** Best-effort decimals lookup for display hints only — never fails the tool. */
export async function tryDecimals(
  conn: ClusterConnection,
  mint: string | PublicKey,
  provided?: number,
): Promise<number | undefined> {
  if (provided !== undefined) return provided;
  try {
    return (await inspectMint(conn, mint)).decimals;
  } catch {
    return undefined;
  }
}
