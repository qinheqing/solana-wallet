import { describe, expect, it } from "vitest";
import { generateWallet } from "./keyfile.js";
import { decryptJson, encryptJson, type EncryptedKeystoreV1 } from "./encrypted.js";
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
});
