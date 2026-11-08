/**
 * Copy text to the clipboard, working outside secure contexts too.
 *
 * `navigator.clipboard` only exists on https / localhost pages. When the UI
 * is opened over a LAN http URL it is undefined, so fall back to the legacy
 * `document.execCommand("copy")` path via a hidden, selected textarea.
 *
 * @returns true when the text was copied by either path
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or non-user-gesture; try the legacy path below.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  // Keep it in the viewport (iOS refuses to select off-screen nodes) but invisible.
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.width = "1px";
  ta.style.height = "1px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  const previous = document.activeElement as HTMLElement | null;
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  previous?.focus?.();
  return ok;
}
