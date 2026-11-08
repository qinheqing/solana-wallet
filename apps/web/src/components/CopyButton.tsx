import { useState } from "react";
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
