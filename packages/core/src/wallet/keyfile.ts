/**
 * Wallet generation and solana-keygen compatible JSON keyfile handling.
 *
 * File I/O is intentionally NOT in core — consumers (CLI / UI / MCP) own
 * persistence so the same code runs in browsers (PRD F7.4).
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { SolwalletError } from "../connection/errors.js";

/** solana-keygen keyfile content: a JSON array of 64 secret-key bytes. */
export type KeypairJsonBytes = number[];

export interface GeneratedWallet {
  keypair: Keypair;
  /** 64-byte secret key (seed32 || publicKey32), keyfile-ready. */
  secretKey: Uint8Array;
  address: PublicKey;
}

/** Generate a fresh Ed25519 wallet. */
export function generateWallet(): GeneratedWallet {
  const keypair = Keypair.generate();
  return {
    keypair,
    secretKey: keypair.secretKey,
    address: keypair.publicKey,
  };
}

/** Serialize a keypair to the solana-keygen JSON byte-array format. */
export function serializeKeypairJson(keypair: Keypair): string {
  return JSON.stringify(Array.from(keypair.secretKey));
}

/**
 * Parse a solana-keygen keyfile (JSON byte array) into a keypair.
 * Accepts a JSON string or an already-parsed number array.
 */
export function parseKeypairJson(
  input: string | KeypairJsonBytes,
): Keypair {
  let bytes: unknown;
  try {
    bytes = typeof input === "string" ? JSON.parse(input) : input;
  } catch (cause) {
    throw new SolwalletError("Keyfile is not valid JSON.", {
      code: "KEYFILE_INVALID_JSON",
      hint: "A solana-keygen keyfile is a JSON array of 64 numbers, e.g. [17,168,...].",
      cause,
    });
  }

  if (
    !Array.isArray(bytes) ||
    !bytes.every((b) => typeof b === "number" && Number.isInteger(b) && b >= 0 && b <= 255)
  ) {
    throw new SolwalletError("Keyfile must be an array of 64 bytes (0-255).", {
      code: "KEYFILE_INVALID_FORMAT",
      hint: "Regenerate the file with `solana-keygen new --outfile` or export from this tool.",
    });
  }

  const arr = bytes as KeypairJsonBytes;
  if (arr.length !== 64) {
    throw new SolwalletError(`Keyfile must contain exactly 64 bytes, got ${arr.length}.`, {
      code: "KEYFILE_INVALID_FORMAT",
      hint: "The 64 bytes are: 32-byte seed + 32-byte public key (solana-keygen format).",
    });
  }

  const secret = Uint8Array.from(arr);
  try {
    // web3.js already validates seed↔public-key consistency and throws on
    // mismatched tails — wrap it into our structured error.
    return Keypair.fromSecretKey(secret);
  } catch (cause) {
    throw new SolwalletError("Keyfile is inconsistent: public key bytes do not match the seed.", {
      code: "KEYFILE_CORRUPT",
      hint: "The file may be truncated or hand-edited. Import just the first 32 bytes as a seed if you trust the source.",
      cause,
    });
  }
}
