/**
 * Output sanitizers. MCP tools and logs must never carry secret material:
 * every wallet-shaped result gets flattened to a safe public view before it
 * crosses a process boundary.
 */
import type { PublicKey } from "@solana/web3.js";

import type { WalletBalance } from "./balance.js";

/** Only public, display-safe fields — no secretKey, no mnemonic. */
export interface SafeWalletView {
  address: string;
  solUi: number;
  tokenCount: number;
  tokens: Array<{ mint: string; uiAmount: number | null; program: string }>;
}

export function toSafeWalletView(balance: WalletBalance): SafeWalletView {
  return {
    address: balance.address,
    solUi: balance.solUi,
    tokenCount: balance.tokens.length,
    tokens: balance.tokens.map((t) => ({
      mint: t.mint,
      uiAmount: t.uiAmount,
      program: t.program,
    })),
  };
}

/** "EPdc…9xQe" style shortening for logs and tables. */
export function shortAddress(address: string | PublicKey, lead = 4, trail = 4): string {
  const s = typeof address === "string" ? address : address.toBase58();
  if (s.length <= lead + trail + 1) return s;
  return `${s.slice(0, lead)}…${s.slice(-trail)}`;
}

/**
 * Security test helper: assert that `text` contains none of the secret
 * materials in any common encoding (base58 secret, hex, JSON byte array).
 * Throws with the offending encoding name when a leak is detected.
 */
export function assertNoSecrets(
  text: string,
  secrets: Array<Uint8Array | string>,
): void {
  for (const secret of secrets) {
    const encodings: Array<[string, string]> = [];
    if (typeof secret === "string") {
      encodings.push(["raw", secret]);
    } else {
      encodings.push([
        "json-bytes",
        JSON.stringify(Array.from(secret)),
      ]);
      encodings.push([
        "hex",
        Array.from(secret)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      ]);
      encodings.push([
        "base64",
        Buffer.from(secret).toString("base64"),
      ]);
    }
    for (const [name, form] of encodings) {
      if (form.length > 0 && text.includes(form)) {
        throw new Error(`SECRET LEAK detected (${name} encoding)`);
      }
    }
  }
}
