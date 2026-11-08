import { useState } from "react";
import { copyText } from "../lib/clipboard";
import { Button } from "./ui";

/** Small "复制" button with transient feedback. */
export function CopyButton({ text, label = "复制", className = "" }: { text: string; label?: string; className?: string }) {
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
      {state === "ok" ? "已复制" : state === "fail" ? "复制失败" : label}
    </Button>
  );
}

/** Shorten a base58 key for tables: `abcd…wxyz`. */
export function shortKey(key: string | null | undefined, n = 4): string {
  if (!key) return "—";
  return key.length <= n * 2 + 1 ? key : `${key.slice(0, n)}…${key.slice(-n)}`;
}
