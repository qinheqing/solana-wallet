/**
 * Output sanitization pipeline (defense-in-depth). Tools are written to
 * never return secrets; this layer additionally masks sensitive-looking
 * fields and scrubs any known secret string from final output.
 */
import type { WalletStore } from "./state.js";

const SENSITIVE_KEY = /secret|mnemonic|seed[-_ ]?phrase|private[-_ ]?key|password|passphrase/i;

const REDACTED = "[REDACTED]";

/**
 * Recursively walk a value: mask values under sensitive-looking keys and
 * replace any string that CONTAINS a known secret (substring match) with
 * "[REDACTED]". Working on the object graph before JSON.stringify keeps the
 * output valid JSON — a textual replacement inside a quoted string would not.
 */
function scrub(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    for (const secret of secrets) {
      if (value.includes(secret)) return REDACTED;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : scrub(v, secrets);
    }
    return out;
  }
  return value;
}

/**
 * Build the sanitizer for one server instance. Secrets are read from the
 * store on EVERY call (not snapshotted at construction) so wallets imported
 * after server start are covered too.
 */
export function makeSanitizer(store: WalletStore) {
  return function sanitize(value: unknown): string {
    const secrets = store.allSecrets().filter((s) => s.length > 0);
    return JSON.stringify(scrub(value, secrets), null, 2);
  };
}
