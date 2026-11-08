import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { deriveTokenAddresses, programKindOf } from "./derive.js";

// Known vectors — computed once with @solana/spl-token getAssociatedTokenAddressSync.
const OWNER = "EPdcT7VfA9GpkvM3YAx9TntdMHPnfhsJ7hPM7paVhxN9";
const MINT = "CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo";
const LEGACY_ATA = "CfhmYTg6VQBUL4WrUkzKQx7Qhuxsrt5fpph6sMMu9wRX";
const T22_ATA = "5eciE3c7dzsZxU82GYcyurhDgtCLe9AghEeJBTsbkSDP";
// findProgramAddress(["vault"], ATA program) — an off-curve owner.
const PDA_OWNER = "BDzjzqA9nScKiTuw7K9FiyVgAimskXf7stYvQ9M9438Q";
const PDA_LEGACY_ATA = "CReqo8oqdsuEZBvhduu731R6JMapsQ2rKdPdoV7Mut4f";

describe("deriveTokenAddresses (T-A)", () => {
  it("matches known vectors for both programs; both PDAs are off-curve and differ", () => {
    const r = deriveTokenAddresses({ owner: OWNER, mint: MINT });
    expect(r.legacy).toEqual({
      address: LEGACY_ATA,
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      isOffCurve: true,
    });
    expect(r.token2022).toEqual({
      address: T22_ATA,
      programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      isOffCurve: true,
    });
    expect(r.legacy.address).not.toBe(r.token2022.address);
    expect(r.ownerIsOffCurve).toBe(false);
  });

  it("accepts PublicKey inputs", () => {
    const r = deriveTokenAddresses({ owner: new PublicKey(OWNER), mint: new PublicKey(MINT) });
    expect(r.legacy.address).toBe(LEGACY_ATA);
  });

  it("rejects an off-curve owner unless allowOwnerOffCurve", () => {
    expect(() => deriveTokenAddresses({ owner: PDA_OWNER, mint: MINT })).toThrowError(
      expect.objectContaining({ code: "OWNER_OFF_CURVE" }),
    );
    const r = deriveTokenAddresses({ owner: PDA_OWNER, mint: MINT, allowOwnerOffCurve: true });
    expect(r.ownerIsOffCurve).toBe(true);
    expect(r.legacy.address).toBe(PDA_LEGACY_ATA);
  });

  it("rejects invalid base58 and wrong-length keys", () => {
    expect(() => deriveTokenAddresses({ owner: "not-base58-0OIl", mint: MINT })).toThrowError(
      expect.objectContaining({ code: "INVALID_ADDRESS" }),
    );
    const thirtyThree = new PublicKey(Buffer.alloc(32, 7)).toBase58() + "1";
    expect(() => deriveTokenAddresses({ owner: OWNER, mint: thirtyThree })).toThrowError(
      expect.objectContaining({ code: "INVALID_ADDRESS" }),
    );
  });

  it("programKindOf maps program ids", () => {
    expect(programKindOf("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")).toBe("spl-token");
    expect(programKindOf("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")).toBe("token-2022");
    expect(programKindOf(OWNER)).toBeNull();
  });
});
