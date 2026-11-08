import { afterEach, describe, expect, it } from "vitest";
import { generateWallet } from "./keyfile.js";
import {
  decryptJson,
  encryptJson,
  hasWebCrypto,
  type EncryptedKeystoreV1,
} from "./encrypted.js";
import { assertNoSecrets } from "./redact.js";

const PAYLOAD = () => {
  const w = generateWallet();
  return { address: w.address.toBase58(), secret: Array.from(w.secretKey) };
};

describe("encrypted keystore (3.3)", () => {
  it("encrypt → decrypt roundtrips exactly", async () => {
    const payload = PAYLOAD();
    const store = await encryptJson(payload, "correct horse battery");
    expect(store.version).toBe(1);
    expect(store.kdf).toBe("PBKDF2-SHA256");
    expect(store.iterations).toBeGreaterThanOrEqual(600_000);
    const out = await decryptJson<typeof payload>(store, "correct horse battery");
    expect(out).toEqual(payload);
  });

  it("never stores plaintext in the keystore", async () => {
    const payload = PAYLOAD();
    const store = await encryptJson(payload, "correct horse battery");
    assertNoSecrets(JSON.stringify(store), [Uint8Array.from(payload.secret), payload.address]);
  });

  it("rejects wrong passwords with a uniform error", async () => {
    const store = await encryptJson(PAYLOAD(), "correct horse battery");
    await expect(decryptJson(store, "wrong password")).rejects.toThrowError(
      /wrong password or corrupted/,
    );
  });

  it("rejects tampered ciphertext (GCM auth)", async () => {
    const store = (await encryptJson(PAYLOAD(), "correct horse battery")) as EncryptedKeystoreV1;
    const bytes = Buffer.from(store.ciphertext, "base64");
    bytes[0] ^= 0xff;
    store.ciphertext = bytes.toString("base64");
    await expect(decryptJson(store, "correct horse battery")).rejects.toThrowError(
      /Decryption failed/,
    );
  });

  it("enforces minimum password length", async () => {
    await expect(encryptJson(PAYLOAD(), "short")).rejects.toThrowError(/at least 8/);
  });

  it("rejects an empty password (14.1 boundary)", async () => {
    await expect(encryptJson(PAYLOAD(), "")).rejects.toThrowError(/at least 8/);
  });

  it("accepts a very long password and still roundtrips (14.1 boundary)", async () => {
    const payload = PAYLOAD();
    const longPassword = "correct horse battery staple ".repeat(50); // 1500 chars
    const store = await encryptJson(payload, longPassword);
    const out = await decryptJson<typeof payload>(store, longPassword);
    expect(out).toEqual(payload);
    // A near-identical but truncated password must fail, not partially match.
    await expect(
      decryptJson(store, longPassword.slice(0, -1)),
    ).rejects.toThrowError(/wrong password or corrupted/);
  });
});

/**
 * Simulate a non-secure browser context (http://<LAN-IP>): `crypto.subtle` is
 * undefined but `crypto.getRandomValues` still works.
 */
function withoutSubtle(): () => void {
  const realCrypto = globalThis.crypto;
  const fake = {
    getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    randomUUID: realCrypto.randomUUID.bind(realCrypto),
    subtle: undefined,
  };
  Object.defineProperty(globalThis, "crypto", { value: fake, configurable: true, writable: true });
  return () => {
    Object.defineProperty(globalThis, "crypto", {
      value: realCrypto,
      configurable: true,
      writable: true,
    });
  };
}

describe("encrypted keystore — pure-JS fallback (non-secure context)", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
    expect(hasWebCrypto()).toBe(true);
  });

  it("hasWebCrypto reflects crypto.subtle availability", () => {
    expect(hasWebCrypto()).toBe(true);
    restore = withoutSubtle();
    expect(hasWebCrypto()).toBe(false);
  });

  it("encrypt → decrypt roundtrips without crypto.subtle", async () => {
    restore = withoutSubtle();
    const payload = PAYLOAD();
    const store = await encryptJson(payload, "correct horse battery");
    expect(store.version).toBe(1);
    expect(store.kdf).toBe("PBKDF2-SHA256");
    // ciphertext || 16-byte tag, same layout as WebCrypto.
    const len = Buffer.from(store.ciphertext, "base64").length;
    expect(len).toBe(Buffer.byteLength(JSON.stringify(payload)) + 16);
    const out = await decryptJson<typeof payload>(store, "correct horse battery");
    expect(out).toEqual(payload);
  });

  it("rejects wrong passwords with the same KEYSTORE_DECRYPT_FAILED error", async () => {
    restore = withoutSubtle();
    const store = await encryptJson(PAYLOAD(), "correct horse battery");
    await expect(decryptJson(store, "wrong password")).rejects.toMatchObject({
      code: "KEYSTORE_DECRYPT_FAILED",
      message: expect.stringMatching(/wrong password or corrupted/),
    });
  });

  it("rejects tampered ciphertext (GCM auth) in fallback", async () => {
    restore = withoutSubtle();
    const store = (await encryptJson(PAYLOAD(), "correct horse battery")) as EncryptedKeystoreV1;
    const bytes = Buffer.from(store.ciphertext, "base64");
    bytes[0] ^= 0xff;
    store.ciphertext = bytes.toString("base64");
    await expect(decryptJson(store, "correct horse battery")).rejects.toMatchObject({
      code: "KEYSTORE_DECRYPT_FAILED",
    });
  });

  it("WebCrypto encrypt → fallback decrypt", async () => {
    const payload = PAYLOAD();
    const store = await encryptJson(payload, "correct horse battery");
    restore = withoutSubtle();
    const out = await decryptJson<typeof payload>(store, "correct horse battery");
    expect(out).toEqual(payload);
  });

  it("fallback encrypt → WebCrypto decrypt", async () => {
    const payload = PAYLOAD();
    restore = withoutSubtle();
    const store = await encryptJson(payload, "correct horse battery");
    restore();
    restore = undefined;
    expect(hasWebCrypto()).toBe(true);
    const out = await decryptJson<typeof payload>(store, "correct horse battery");
    expect(out).toEqual(payload);
  });
});
