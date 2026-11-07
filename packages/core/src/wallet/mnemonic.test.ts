import { describe, expect, it } from "vitest";
import {
  DERIVATION_PRESETS,
  importFromMnemonic,
  newMnemonic,
} from "./mnemonic.js";

// Classic BIP39 test vector (valid checksum, 12 words).
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("importFromMnemonic (3.2)", () => {
  it("derives the known solana-keygen/Phantom address (golden value)", async () => {
    const w = await importFromMnemonic(TEST_MNEMONIC);
    expect(w.path).toBe("m/44'/501'/0'/0'");
    // Frozen golden value — computed via ed25519-hd-key SLIP-0010 derivation.
    expect(w.address.toBase58()).toBe("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
  });

  it("is deterministic and whitespace/case tolerant", async () => {
    const messy = `  ${TEST_MNEMONIC.toUpperCase()}  `;
    const w1 = await importFromMnemonic(TEST_MNEMONIC);
    const w2 = await importFromMnemonic(messy);
    expect(w2.address.toBase58()).toBe(w1.address.toBase58());
  });

  it("supports additional accounts via custom path", async () => {
    const w = await importFromMnemonic(TEST_MNEMONIC, { path: "m/44'/501'/1'/0'" });
    expect(w.address.toBase58()).toBe("Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb");
  });

  it("supports presets and rejects malformed custom paths", async () => {
    const viaPreset = await importFromMnemonic(TEST_MNEMONIC, { path: "phantom" });
    expect(viaPreset.path).toBe(DERIVATION_PRESETS.phantom);
    await expect(
      importFromMnemonic(TEST_MNEMONIC, { path: "m/garbage" }),
    ).rejects.toThrowError(/Invalid derivation path/);
  });

  it("honors the BIP39 passphrase (25th word)", async () => {
    const w = await importFromMnemonic(TEST_MNEMONIC, { passphrase: "test" });
    expect(w.address.toBase58()).toBe("HtgtGZdAUL8aaXCkgahXSxLPneAKzU1F6HGMNny4r1Ge");
  });

  it("rejects invalid mnemonics without leaking fragments", async () => {
    const bad = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon wrong";
    await expect(importFromMnemonic(bad)).rejects.toThrowError(/Invalid BIP39 mnemonic/);
    await expect(importFromMnemonic("single")).rejects.toThrowError(/Invalid BIP39 mnemonic/);
  });

  it("rejects a wrong word count (14.1 boundary: neither 12 nor 24 words)", async () => {
    // 15 otherwise-valid-looking words — BIP39 only accepts 12/15/18/21/24,
    // and this phrase's checksum is wrong for 15 anyway (common off-by-N bug).
    const fifteen = Array.from({ length: 15 }, () => "abandon").join(" ");
    await expect(importFromMnemonic(fifteen)).rejects.toThrowError(/Invalid BIP39 mnemonic/);
  });

  it("rejects a mnemonic containing a word outside the BIP39 wordlist", async () => {
    const withJunkWord =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon xyzzy";
    await expect(importFromMnemonic(withJunkWord)).rejects.toThrowError(/Invalid BIP39 mnemonic/);
  });

  it("rejects an empty string distinctly from a short phrase", async () => {
    await expect(importFromMnemonic("")).rejects.toThrowError(/Invalid BIP39 mnemonic/);
    await expect(importFromMnemonic("   ")).rejects.toThrowError(/Invalid BIP39 mnemonic/);
  });

  it("newMnemonic generates valid 12/24-word phrases", async () => {
    const m12 = newMnemonic(128);
    const m24 = newMnemonic(256);
    expect(m12.split(" ")).toHaveLength(12);
    expect(m24.split(" ")).toHaveLength(24);
    const w = await importFromMnemonic(m24);
    expect(w.address.toBase58()).toHaveLength(44);
  });
});
