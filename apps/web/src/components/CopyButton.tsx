import { useState, type ReactNode } from "react";
import { copyText } from "../lib/clipboard";
import { useT } from "../lib/i18n";
import { Button } from "./ui";

/** Small "Copy" button with transient feedback. `label` overrides the idle text (e.g. "⧉"). */
export function CopyButton({ text, label, className = "" }: { text: string; label?: string; className?: string }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <Button
      type="button"
      variant="ghost"
      className={`px-2 py-0.5 text-xs ${className}`}
      onClick={async () => {
        const ok = await copyText(text);
        setState(ok ? "ok" : "fail");
        setTimeout(() => setState("idle"), 1500);
      }}
    >
      {state === "ok" ? t("common.copied") : state === "fail" ? t("common.copyFailed") : label ?? t("common.copy")}
    </Button>
  );
}

/** Shorten a base58 key for tables: `abcd…wxyz`. */
export function shortKey(key: string | null | undefined, n = 4): string {
  if (!key) return "—";
  return key.length <= n * 2 + 1 ? key : `${key.slice(0, n)}…${key.slice(-n)}`;
}

/** Inline copy icon that doesn't change line height (for use inside text rows). */
export function CopyIcon({ text }: { text: string }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <button
      type="button"
      title={t("common.copy")}
      aria-label={t("common.copy")}
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await copyText(text);
        setState(ok ? "ok" : "fail");
        setTimeout(() => setState("idle"), 1500);
      }}
      className={`ml-1.5 inline align-baseline text-xs leading-none hover:text-zinc-100 ${
        state === "ok" ? "text-emerald-400" : state === "fail" ? "text-red-400" : "text-zinc-500"
      }`}
    >
      {state === "ok" ? "✓" : state === "fail" ? "✕" : "⧉"}
    </button>
  );
}

/** Full base58 address in monospace (wraps when narrow) + inline copy icon. */
export function Address({
  value,
  copy = true,
  short = false,
  className = "",
  empty,
}: {
  value: string | null | undefined;
  copy?: boolean;
  /** Render `abcde…vwxyz` (full key on hover, copy still copies the full key). */
  short?: boolean;
  className?: string;
  /** Rendered when value is null/empty. */
  empty?: ReactNode;
}) {
  if (!value) return <span className="text-zinc-500">{empty ?? "—"}</span>;
  if (short) {
    return (
      <span className={`whitespace-nowrap font-mono ${className}`} title={value}>
        {shortKey(value, 5)}
        {copy && <CopyIcon text={value} />}
      </span>
    );
  }
  return (
    <span className={`break-all font-mono ${className}`}>
      {value}
      {copy && <CopyIcon text={value} />}
    </span>
  );
}
