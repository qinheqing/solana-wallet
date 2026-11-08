/**
 * Associated token address derivation for BOTH token programs at once.
 *
 * A wallet's ATA for a given mint differs between SPL Token and Token-2022
 * (the program id is part of the PDA seeds), and a mint only lives under
 * one of them — this helper gives callers both candidates so they can match
 * the right one against `inspectMint().programId`.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import { SolwalletError } from "../connection/errors.js";
import type { TokenProgramKind } from "../transfer/program.js";

export interface DeriveTokenAddressesInput {
  owner: string | PublicKey;
  mint: string | PublicKey;
  /**
   * Permit an off-curve owner (a PDA). Off by default: an ATA owned by a
   * PDA is legitimate but usually a sign the caller passed the wrong key.
   */
  allowOwnerOffCurve?: boolean;
}

export interface DerivedTokenAddress {
  /** Base58 associated token address. */
  address: string;
  /** Token program that would own the account (seed of the PDA). */
  programId: string;
  /** ATAs are PDAs, so this is always true — exposed for assertion/debug. */
  isOffCurve: boolean;
}

export interface DerivedTokenAddresses {
  owner: string;
  mint: string;
  ownerIsOffCurve: boolean;
  legacy: DerivedTokenAddress;
  token2022: DerivedTokenAddress;
}

function toKey(value: string | PublicKey, label: string): PublicKey {
  try {
    return typeof value === "string" ? new PublicKey(value) : value;
  } catch (cause) {
    throw new SolwalletError(`${label} is not a valid base58 public key.`, {
      code: "INVALID_ADDRESS",
      hint: `Pass a 32-byte base58 address for ${label}.`,
      cause,
    });
  }
}

function deriveFor(owner: PublicKey, mint: PublicKey, programId: PublicKey): DerivedTokenAddress {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), programId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return {
    address: address.toBase58(),
    programId: programId.toBase58(),
    isOffCurve: !PublicKey.isOnCurve(address.toBytes()),
  };
}

/** Pure: derive the legacy and Token-2022 ATAs for an owner/mint pair. */
export function deriveTokenAddresses(input: DeriveTokenAddressesInput): DerivedTokenAddresses {
  const owner = toKey(input.owner, "owner");
  const mint = toKey(input.mint, "mint");
  const ownerIsOffCurve = !PublicKey.isOnCurve(owner.toBytes());
  if (ownerIsOffCurve && !input.allowOwnerOffCurve) {
    throw new SolwalletError(
      `Owner ${owner.toBase58()} is off-curve (a PDA, not a wallet key).`,
      {
        code: "OWNER_OFF_CURVE",
        hint: "Wallet owners are ed25519 keys (on-curve). If the owner really is a program-derived address, pass allowOwnerOffCurve: true.",
      },
    );
  }
  return {
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    ownerIsOffCurve,
    legacy: deriveFor(owner, mint, TOKEN_PROGRAM_ID),
    token2022: deriveFor(owner, mint, TOKEN_2022_PROGRAM_ID),
  };
}

/** Program kind for a derived address — handy when matching against a mint. */
export function programKindOf(programId: string | PublicKey): TokenProgramKind | null {
  const id = typeof programId === "string" ? programId : programId.toBase58();
  if (id === TOKEN_PROGRAM_ID.toBase58()) return "spl-token";
  if (id === TOKEN_2022_PROGRAM_ID.toBase58()) return "token-2022";
  return null;
}
