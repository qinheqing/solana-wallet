/**
 * Output sanitization pipeline (defense-in-depth). Tools are written to
 * never return secrets; this layer additionally masks sensitive-looking
 * fields and scrubs any known secret string from final output.
 */
import type { WalletStore } from "./state.js";

const SENSITIVE_KEY = /secret|mnemonic|seed[-_ ]?phrase|private[-_ ]?key|password|passphrase/i;

/** Recursively mask values under sensitive-looking keys. */
function maskSensitiveKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSensitiveKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : maskSensitiveKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * Build the sanitizer for one server instance: masks sensitive keys and
 * replaces every registered secret string wherever it appears.
 */
export function makeSanitizer(store: WalletStore) {
  const secrets = store.allSecrets();

  return function sanitize(value: unknown): string {
    const masked = maskSensitiveKeys(value);
    let text = JSON.stringify(masked, null, 2);
    for (const secret of secrets) {
      if (secret.length > 0) text = text.split(secret).join('"[REDACTED]"');
    }
    return text;
  };
}
