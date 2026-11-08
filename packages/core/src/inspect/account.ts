/**
 * Token account inspection: base fields + account-level Token-2022
 * extensions, as plain JSON (raw amounts as strings).
 */
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getCpiGuard,
  getMemoTransfer,
  getTransferFeeAmount,
  getTransferHookAccount,
  unpackAccount,
  type Account,
} from "@solana/spl-token";
import { PublicKey, type AccountInfo } from "@solana/web3.js";

import type { ClusterConnection } from "../connection/connection.js";
import { SolwalletError } from "../connection/errors.js";
import type { TokenProgramKind } from "../transfer/program.js";

export type TokenAccountExtension =
  | { type: "MemoTransfer"; requireIncomingTransferMemos: boolean }
  | { type: "ImmutableOwner" }
  | { type: "CpiGuard"; lockCpi: boolean }
  | { type: "TransferFeeAmount"; withheldAmount: string }
  | { type: "NonTransferableAccount" }
  | { type: "TransferHookAccount"; transferring: boolean }
  | { type: "ConfidentialTransferAccount" }
  | { type: "ConfidentialTransferFeeAmount" }
  | { type: "PausableAccount" }
  | { type: "unknown"; rawType: number; length: number };

export interface TokenAccountInspection {
  address: string;
  program: TokenProgramKind;
  programId: string;
  mint: string;
  owner: string;
  /** Raw base units. */
  amount: string;
  delegate: string | null;
  /** Raw base units. */
  delegatedAmount: string;
  state: "initialized" | "frozen" | "uninitialized";
  closeAuthority: string | null;
  isNative: boolean;
  /** Rent-exempt reserve for wrapped-SOL accounts, lamports. */
  rentExemptReserve: string | null;
  extensions: TokenAccountExtension[];
  dataLength: number;
}

const EXTRA_ACCOUNT_EXTENSION_IDS: Record<number, TokenAccountExtension["type"]> = {
  17: "ConfidentialTransferFeeAmount",
};

function decodeExtension(account: Account, type: ExtensionType, raw: Buffer): TokenAccountExtension {
  switch (type) {
    case ExtensionType.MemoTransfer:
      return {
        type: "MemoTransfer",
        requireIncomingTransferMemos: getMemoTransfer(account)!.requireIncomingTransferMemos,
      };
    case ExtensionType.ImmutableOwner:
      return { type: "ImmutableOwner" };
    case ExtensionType.CpiGuard:
      return { type: "CpiGuard", lockCpi: getCpiGuard(account)!.lockCpi };
    case ExtensionType.TransferFeeAmount:
      return {
        type: "TransferFeeAmount",
        withheldAmount: getTransferFeeAmount(account)!.withheldAmount.toString(),
      };
    case ExtensionType.NonTransferableAccount:
      return { type: "NonTransferableAccount" };
    case ExtensionType.TransferHookAccount:
      return { type: "TransferHookAccount", transferring: getTransferHookAccount(account)!.transferring };
    case ExtensionType.ConfidentialTransferAccount:
      return { type: "ConfidentialTransferAccount" };
    case ExtensionType.PausableAccount:
      return { type: "PausableAccount" };
    default: {
      const named = EXTRA_ACCOUNT_EXTENSION_IDS[type as number];
      if (named) return { type: named } as TokenAccountExtension;
      return { type: "unknown", rawType: type as number, length: raw.length };
    }
  }
}

function tlvEntries(tlv: Buffer): Array<{ type: number; data: Buffer }> {
  const out: Array<{ type: number; data: Buffer }> = [];
  let i = 0;
  while (i + 4 <= tlv.length) {
    const type = tlv.readUInt16LE(i);
    const len = tlv.readUInt16LE(i + 2);
    if (type === ExtensionType.Uninitialized) break;
    out.push({ type, data: tlv.subarray(i + 4, i + 4 + len) });
    i += 4 + len;
  }
  return out;
}

/** Pure decoder for a raw token account. */
export function decodeTokenAccount(
  address: PublicKey,
  info: AccountInfo<Buffer>,
): TokenAccountInspection {
  const owner = info.owner.toBase58();
  let program: TokenProgramKind;
  let programId: PublicKey;
  if (owner === TOKEN_PROGRAM_ID.toBase58()) {
    program = "spl-token";
    programId = TOKEN_PROGRAM_ID;
  } else if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) {
    program = "token-2022";
    programId = TOKEN_2022_PROGRAM_ID;
  } else {
    throw new SolwalletError(
      `Account ${address.toBase58()} is not a token account (owned by ${owner}).`,
      {
        code: "NOT_A_TOKEN_ACCOUNT",
        hint: "Pass a token account (ATA) address, not a wallet or mint. Use deriveTokenAddresses to find the ATA.",
      },
    );
  }

  let account: Account;
  try {
    account = unpackAccount(address, info, programId);
  } catch (cause) {
    throw new SolwalletError(`Account ${address.toBase58()} does not decode as a token account.`, {
      code: "NOT_A_TOKEN_ACCOUNT",
      hint: "The account is owned by a token program but is not account-shaped (maybe a mint or multisig).",
      cause,
    });
  }

  const extensions: TokenAccountExtension[] = [];
  if (program === "token-2022") {
    for (const { type, data } of tlvEntries(account.tlvData)) {
      extensions.push(decodeExtension(account, type as ExtensionType, data));
    }
  }

  const state: TokenAccountInspection["state"] = account.isFrozen
    ? "frozen"
    : account.isInitialized
      ? "initialized"
      : "uninitialized";

  return {
    address: address.toBase58(),
    program,
    programId: programId.toBase58(),
    mint: account.mint.toBase58(),
    owner: account.owner.toBase58(),
    amount: account.amount.toString(),
    delegate: account.delegate?.toBase58() ?? null,
    delegatedAmount: account.delegatedAmount.toString(),
    state,
    closeAuthority: account.closeAuthority?.toBase58() ?? null,
    isNative: account.isNative,
    rentExemptReserve: account.rentExemptReserve?.toString() ?? null,
    extensions,
    dataLength: info.data.length,
  };
}

/** Fetch + decode a token account. Throws ACCOUNT_NOT_FOUND / NOT_A_TOKEN_ACCOUNT. */
export async function inspectTokenAccount(
  conn: ClusterConnection,
  address: string | PublicKey,
): Promise<TokenAccountInspection> {
  const key = typeof address === "string" ? new PublicKey(address) : address;
  const info = await conn.connection.getAccountInfo(key);
  if (!info) {
    throw new SolwalletError(`Token account ${key.toBase58()} not found on cluster "${conn.cluster}".`, {
      code: "ACCOUNT_NOT_FOUND",
      hint: "The ATA may not exist yet (it is created on first receipt). Verify the cluster and derive the address with deriveTokenAddresses.",
    });
  }
  return decodeTokenAccount(key, info);
}

export { AccountState };
