/**
 * Password-encrypted keystore using AES-256-GCM + PBKDF2-SHA256.
 *
 * WebCrypto (globalThis.crypto.subtle) is used instead of node:crypto so the
 * identical code path runs in Node ≥20 and browsers (PRD F7.4). PBKDF2 is
 * chosen over scrypt because scrypt is not part of the WebCrypto standard.
 *
 * Browsers only expose `crypto.subtle` in secure contexts (https / localhost).
 * When the Web UI is opened over plain http on a LAN address, `crypto.subtle`
 * is undefined, so a pure-JS fallback (@noble/hashes PBKDF2 + @noble/ciphers
 * AES-GCM) is used. Both paths produce the same EncryptedKeystoreV1 format
 * (ciphertext || 16-byte GCM tag) and are mutually decryptable.
 * `crypto.getRandomValues` is available in all contexts and is always used.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
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

/** True when WebCrypto `crypto.subtle` is available (secure context / Node). */
export function hasWebCrypto(): boolean {
  return typeof globalThis.crypto?.subtle?.importKey === "function";
}

function decryptFailed(): SolwalletError {
  // GCM auth failure means wrong password or tampered data — one message
  // for both, so attackers can't distinguish (and users get clear guidance).
  return new SolwalletError("Decryption failed: wrong password or corrupted keystore.", {
    code: "KEYSTORE_DECRYPT_FAILED",
    hint: "Passwords are never stored or recoverable — re-enter carefully or restore from backup.",
  });
}

// ---------------------------------------------------------------------------
// WebCrypto path
// ---------------------------------------------------------------------------

async function deriveKeyWebCrypto(
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

async function encryptWebCrypto(
  password: string,
  salt: Uint8Array,
  iv: Uint8Array,
  iterations: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const key = await deriveKeyWebCrypto(password, salt, iterations);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return new Uint8Array(ciphertext);
}

async function decryptWebCrypto(
  password: string,
  salt: Uint8Array,
  iv: Uint8Array,
  iterations: number,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const key = await deriveKeyWebCrypto(password, salt, iterations);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    throw decryptFailed();
  }
}

// ---------------------------------------------------------------------------
// Pure-JS fallback path (non-secure browser contexts)
// ---------------------------------------------------------------------------

async function deriveKeyNoble(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  // pbkdf2Async yields to the event loop periodically so the UI stays responsive.
  return pbkdf2Async(sha256, new TextEncoder().encode(password), salt, {
    c: iterations,
    dkLen: 32,
  });
}

async function encryptNoble(
  password: string,
  salt: Uint8Array,
  iv: Uint8Array,
  iterations: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const key = await deriveKeyNoble(password, salt, iterations);
  try {
    // noble's gcm output is ciphertext || 16-byte tag — identical to WebCrypto.
    return gcm(key, iv).encrypt(plaintext);
  } finally {
    key.fill(0);
  }
}

async function decryptNoble(
  password: string,
  salt: Uint8Array,
  iv: Uint8Array,
  iterations: number,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const key = await deriveKeyNoble(password, salt, iterations);
  try {
    return gcm(key, iv).decrypt(ciphertext);
  } catch {
    throw decryptFailed();
  } finally {
    key.fill(0);
  }
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
  const plaintext = new TextEncoder().encode(JSON.stringify(data));

  const ciphertext = hasWebCrypto()
    ? await encryptWebCrypto(password, salt, iv, DEFAULT_ITERATIONS, plaintext)
    : await encryptNoble(password, salt, iv, DEFAULT_ITERATIONS, plaintext);

  return {
    version: 1,
    kdf: KDF,
    iterations: DEFAULT_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
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
  const salt = fromBase64(store.salt);
  const iv = fromBase64(store.iv);
  const ciphertext = fromBase64(store.ciphertext);

  const plaintext = hasWebCrypto()
    ? await decryptWebCrypto(password, salt, iv, store.iterations, ciphertext)
    : await decryptNoble(password, salt, iv, store.iterations, ciphertext);

  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    throw decryptFailed();
  }
}
