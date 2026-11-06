import { describe, expect, it } from "vitest";
import {
  generateWallet,
  parseKeypairJson,
  serializeKeypairJson,
} from "./keyfile.js";

describe("generateWallet (3.1)", () => {
  it("creates distinct wallets with 64-byte secret keys", () => {
    const a = generateWallet();
    const b = generateWallet();
    expect(a.secretKey).toHaveLength(64);
    expect(a.address.toBase58()).not.toBe(b.address.toBase58());
    // solana-keygen format: first 32 bytes seed, last 32 bytes public key
    expect(Array.from(a.secretKey.slice(32))).toEqual(
      Array.from(a.address.toBytes()),
    );
  });
});

describe("keyfile roundtrip (solana-keygen compatible)", () => {
  it("serialize → parse restores the same address", () => {
    const w = generateWallet();
    const json = serializeKeypairJson(w.keypair);
    const restored = parseKeypairJson(json);
    expect(restored.publicKey.toBase58()).toBe(w.address.toBase58());
  });

  it("accepts an already-parsed byte array", () => {
    const w = generateWallet();
    const bytes = Array.from(w.keypair.secretKey);
    expect(parseKeypairJson(bytes).publicKey.toBase58()).toBe(
      w.address.toBase58(),
    );
  });

  it("rejects non-JSON and wrong shapes with structured errors", () => {
    expect(() => parseKeypairJson("not json")).toThrowError(/not valid JSON/);
    expect(() => parseKeypairJson('{"a":1}')).toThrowError(/array of 64 bytes/);
    expect(() => parseKeypairJson(JSON.stringify(new Array(63).fill(1)))).toThrowError(
      /exactly 64 bytes, got 63/,
    );
    expect(() => parseKeypairJson(JSON.stringify(new Array(64).fill(999)))).toThrowError(
      /0-255/,
    );
  });

  it("detects inconsistent public-key bytes (corruption)", () => {
    const w = generateWallet();
    const bytes = Array.from(w.keypair.secretKey);
    bytes[63] = (bytes[63]! + 1) % 256; // tamper one public-key byte
    expect(() => parseKeypairJson(bytes)).toThrowError(/inconsistent/);
  });
});
