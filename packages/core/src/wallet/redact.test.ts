import { describe, expect, it } from "vitest";
import { generateWallet } from "./keyfile.js";
import {
  assertNoSecrets,
  shortAddress,
  toSafeWalletView,
} from "./redact.js";

describe("redact / sanitizers (3.5)", () => {
  it("SafeWalletView exposes no secret fields", () => {
    const w = generateWallet();
    const view = toSafeWalletView({
      address: w.address.toBase58(),
      solLamports: 1_000_000_000,
      solUi: 1,
      tokens: [
        { mint: "MINT", tokenAccount: "ATA", amount: "1", decimals: 0, uiAmount: 1, program: "spl-token" },
      ],
    });
    expect(Object.keys(view).sort()).toEqual(["address", "solUi", "tokenCount", "tokens"]);
    expect(JSON.stringify(view)).not.toContain("secretKey");
  });

  it("shortAddress truncates long addresses, keeps short ones", () => {
    expect(shortAddress("EPdcT7VfA9GpkvM3YAx9TntdMHPnfhsJ7hPM7paVhxN9")).toMatch(
      /^EPdc…hxN9$/,
    );
    expect(shortAddress("short")).toBe("short");
  });

  it("assertNoSecrets detects base58/hex/byte-array leaks", () => {
    const w = generateWallet();
    const secret = w.secretKey;
    const leaks: Array<[string, () => void]> = [
      ["json-bytes", () => assertNoSecrets(JSON.stringify(Array.from(secret)), [secret])],
      [
        "hex",
        () =>
          assertNoSecrets(
            Array.from(secret)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(""),
            [secret],
          ),
      ],
      ["base64", () => assertNoSecrets(Buffer.from(secret).toString("base64"), [secret])],
    ];
    for (const [name, leak] of leaks) {
      expect(leak, `should detect ${name} leak`).toThrowError(/SECRET LEAK/);
    }
    // Clean text passes silently.
    expect(() => assertNoSecrets("all public, nothing to see", [secret])).not.toThrow();
  });

  it("error messages from wallet module carry no secret material", async () => {
    const { importFromMnemonic } = await import("./mnemonic.js");
    const secretWords = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon wrong";
    const err = await importFromMnemonic(secretWords).catch((e) => e as Error);
    const full = `${err.name}: ${err.message} ${(err as { hint?: string }).hint ?? ""}`;
    expect(full).not.toContain("abandon");
  });
});
