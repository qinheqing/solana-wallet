/** Trigger a browser download of `content` as a file named `filename`. */
export function downloadText(filename: string, content: string, mime = "application/json"): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick so the click has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** JSON.stringify that tolerates bigint values (serialised as strings). */
export function stringifyJson(value: unknown, indent = 2): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), indent);
}
