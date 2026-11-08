/**
 * Base-unit amount helpers. Owner's convention: every amount the UI accepts
 * or shows is a raw base-unit integer (lamports / token base units), like a
 * block explorer. Human-readable conversions are *hints only*, computed with
 * core `formatAmount` — never `uiAmount`.
 */
import { formatAmount } from "../lib/coreShim";
import { useT, type TFn } from "../lib/i18n";

/** True when `v` is a positive base-unit integer string ("1", "1500000000"). */
export function isBaseUnits(v: string): boolean {
  const s = v.trim();
  return /^\d+$/.test(s) && BigInt(s) > 0n;
}

/** Parse a user-entered base-unit amount; throws a translated error when invalid. */
export function parseBaseUnits(v: string, t: (key: "amount.invalid") => string): bigint {
  if (!isBaseUnits(v)) throw new Error(t("amount.invalid"));
  return BigInt(v.trim());
}

/** Non-negative integer decimals from a form field, or null when unknown/invalid. */
export function parseDecimals(v: string): number | null {
  const s = v.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n <= 36 ? n : null;
}

function safeFormat(raw: string | bigint | number, decimals: number): string | null {
  try {
    return formatAmount(typeof raw === "bigint" ? raw : BigInt(raw), decimals);
  } catch {
    return null;
  }
}

/** Text + tone for a base-unit input hint (shared by AmountHint and list renderers). */
export function amountHintText(
  t: TFn,
  value: string,
  decimals: number | null,
  sol = false,
): { text: string; invalid: boolean } | null {
  const v = value.trim();
  if (v.length === 0) return null;
  if (!isBaseUnits(v)) return { text: t("amount.invalid"), invalid: true };
  if (sol) return { text: t("amount.hintSol", { value: safeFormat(v, 9) ?? v }), invalid: false };
  if (decimals === null) return { text: t("amount.decimalsUnknown"), invalid: false };
  return { text: t("amount.hintToken", { value: safeFormat(v, decimals) ?? v, decimals }), invalid: false };
}

/**
 * Live conversion hint rendered under a base-unit input.
 * `decimals === null` → "decimals unknown"; invalid input → validation hint.
 */
export function AmountHint({
  value,
  decimals,
  sol = false,
  className = "",
}: {
  value: string;
  decimals: number | null;
  /** Render as SOL (decimals forced to 9). */
  sol?: boolean;
  className?: string;
}) {
  const t = useT();
  const hint = amountHintText(t, value, decimals, sol);
  if (!hint) return null;
  return <div className={`mt-1 text-xs ${hint.invalid ? "text-amber-400" : "text-zinc-500"} ${className}`}>{hint.text}</div>;
}

/**
 * Displayed amount: raw base units as the primary value, converted value as a
 * muted secondary hint. `symbol` (e.g. "SOL") replaces the "(dec N)" suffix.
 */
export function AmountValue({
  raw,
  decimals,
  symbol,
  unit,
  className = "",
  stacked = false,
}: {
  raw: string | bigint | number | null | undefined;
  decimals: number | null | undefined;
  symbol?: string;
  /** Unit label rendered right after the raw value (e.g. "lamports"). */
  unit?: string;
  className?: string;
  /** Put the hint on its own line (tables / big numbers). */
  stacked?: boolean;
}) {
  const t = useT();
  if (raw === null || raw === undefined) return <span className="text-zinc-600">—</span>;
  const rawStr = typeof raw === "bigint" ? raw.toString() : String(raw);
  let hint: string;
  if (decimals === null || decimals === undefined) {
    hint = t("amount.approxUnknown");
  } else {
    const formatted = safeFormat(rawStr, decimals);
    if (formatted === null) hint = t("amount.approxUnknown");
    else hint = symbol ? t("amount.approx", { value: formatted, symbol }) : t("amount.approxDec", { value: formatted, decimals });
  }
  const Hint = stacked ? "div" : "span";
  return (
    <span className={`inline${stacked ? "-block" : ""} ${className}`}>
      <span className="font-mono">{rawStr}</span>
      {unit && <span className="ml-1 text-xs text-zinc-500">{unit}</span>}
      <Hint className={`text-xs text-zinc-500 ${stacked ? "" : "ml-1.5"}`}>{hint}</Hint>
    </span>
  );
}
