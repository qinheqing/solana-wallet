/**
 * BIP39 mnemonic import with SLIP-0010 ed25519 derivation — compatible with
 * Phantom, solana-keygen and most Solana wallets.
 */
import { Keypair } from "@solana/web3.js";
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { derivePath } from "ed25519-hd-key";

import { SolwalletError } from "../connection/errors.js";
import type { GeneratedWallet } from "./keyfile.js";

/** Well-known Solana derivation paths. */
export const DERIVATION_PRESETS = {
  /** solana-keygen default and Phantom default — the ecosystem standard. */
  solana: "m/44'/501'/0'/0'",
  /** Alias of solana. */
  phantom: "m/44'/501'/0'/0'",
  /** Second account of the standard path. */
  solanaSecond: "m/44'/501'/1'/0'",
} as const;

export type DerivationPreset = keyof typeof DERIVATION_PRESETS;

export interface MnemonicImportOptions {
  /** Preset name or any explicit SLIP-0010 path. Default: solana preset. */
  path?: DerivationPreset | (string & {});
  /** Optional BIP39 passphrase (the "25th word"). */
  passphrase?: string;
}

export async function importFromMnemonic(
  mnemonic: string,
  options: MnemonicImportOptions = {},
): Promise<GeneratedWallet & { path: string }> {
  const normalized = mnemonic.trim().toLowerCase().split(/\s+/).join(" ");

  let valid: boolean;
  try {
    valid = validateMnemonic(normalized, wordlist);
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new SolwalletError("Invalid BIP39 mnemonic.", {
      code: "MNEMONIC_INVALID",
      hint: "Expected 12 or 24 English words with a valid checksum. Words are case-insensitive; extra whitespace is ignored.",
    });
  }

  const path = options.path
    ? resolvePath(options.path)
    : DERIVATION_PRESETS.solana;

  const seed = await mnemonicToSeed(normalized, options.passphrase);
  const seedHex = Buffer.from(seed).toString("hex");

  let derived: { key: Uint8Array };
  try {
    derived = derivePath(path, seedHex);
  } catch (cause) {
    throw new SolwalletError(`Derivation failed for path "${path}".`, {
      code: "DERIVATION_FAILED",
      hint: "Use a SLIP-0010 ed25519 path with hardened segments, e.g. m/44'/501'/0'/0'.",
      cause,
    });
  }

  const keypair = Keypair.fromSeed(derived.key);
  return { keypair, secretKey: keypair.secretKey, address: keypair.publicKey, path };
}

/** Generate a fresh mnemonic. 128 bits = 12 words, 256 bits = 24 words. */
export function newMnemonic(strength: 128 | 256 = 128): string {
  return generateMnemonic(wordlist, strength);
}

function resolvePath(path: DerivationPreset | string): string {
  if (path in DERIVATION_PRESETS) {
    return DERIVATION_PRESETS[path as DerivationPreset];
  }
  if (!/^m(\/\d+'?)+$/.test(path)) {
    throw new SolwalletError(`Invalid derivation path: "${path}".`, {
      code: "DERIVATION_PATH_INVALID",
      hint: `Expected a preset (${Object.keys(DERIVATION_PRESETS).join(", ")}) or a path like m/44'/501'/0'/0'.`,
    });
  }
  return path;
}
