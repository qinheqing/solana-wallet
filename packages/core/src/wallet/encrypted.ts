/**
 * Password-encrypted keystore using WebCrypto AES-256-GCM + PBKDF2.
 *
 * WebCrypto (globalThis.crypto.subtle) is used instead of node:crypto so the
 * identical code path runs in Node ≥20 and browsers (PRD F7.4). PBKDF2 is
 * chosen over scrypt because scrypt is not part of the WebCrypto standard.
 */
import { SolwalletError } from "../connection/errors.js";

const KDF = "PBKDF2-SHA256";
/** OWASP 2023 guidance for PBKDF2-SHA256 (FIPS-140 constraint makes scrypt unavailable here). */
const DEFAULT_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncryptedKeystoreV1 {
  version: 1;
  kdf: typeof KDF;
  iterations: number;
  /** base64 */
  salt: string;
  /** base64, 12-byte AES-GCM nonce */
  iv: string;
  /** base64, ciphertext || 16-byte GCM auth tag */
  ciphertext: string;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt any JSON-serializable payload with a password. */
export async function encryptJson(
  data: unknown,
  password: string,
): Promise<EncryptedKeystoreV1> {
  if (password.length < 8) {
    throw new SolwalletError("Password must be at least 8 characters.", {
      code: "PASSWORD_TOO_SHORT",
      hint: "This file protects a secret key — short passwords defeat the encryption.",
    });
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt, DEFAULT_ITERATIONS);

  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext,
  );

  return {
    version: 1,
    kdf: KDF,
    iterations: DEFAULT_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

/** Decrypt a keystore produced by encryptJson. */
export async function decryptJson<T = unknown>(
  store: EncryptedKeystoreV1,
  password: string,
): Promise<T> {
  if (store.version !== 1) {
    throw new SolwalletError(`Unsupported keystore version: ${store.version}.`, {
      code: "KEYSTORE_VERSION_UNSUPPORTED",
    });
  }
  const key = await deriveKey(password, fromBase64(store.salt), store.iterations);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(store.iv) as BufferSource },
      key,
      fromBase64(store.ciphertext) as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    // GCM auth failure means wrong password or tampered data — one message
    // for both, so attackers can't distinguish (and users get clear guidance).
    throw new SolwalletError("Decryption failed: wrong password or corrupted keystore.", {
      code: "KEYSTORE_DECRYPT_FAILED",
      hint: "Passwords are never stored or recoverable — re-enter carefully or restore from backup.",
    });
  }
}
