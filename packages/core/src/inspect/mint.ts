/**
 * Mint inspection: program kind + base fields + every Token-2022 extension
 * decoded into plain JSON (bigint → string, PublicKey → base58).
 *
 * Decoding is split from fetching (`decodeMintAccount`) so tests run on
 * crafted buffers without an RPC.
 */
import {
  ACCOUNT_SIZE,
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccountLen,
  getDefaultAccountState,
  getExtensionData,
  getExtensionTypes,
  getGroupMemberPointerState,
  getGroupPointerState,
  getInterestBearingMintConfigState,
  getMetadataPointerState,
  getMintCloseAuthority,
  getPausableConfig,
  getPermanentDelegate,
  getScaledUiAmountConfig,
  getTransferFeeConfig,
  getTransferHook,
  unpackMint,
  type Mint,
  type TransferFee,
} from "@solana/spl-token";
import { unpack as unpackTokenMetadata } from "@solana/spl-token-metadata";
import { PublicKey, type AccountInfo } from "@solana/web3.js";

import type { ClusterConnection } from "../connection/connection.js";
import { SolwalletError } from "../connection/errors.js";
import type { TokenProgramKind } from "../transfer/program.js";

/** Decoded mint extension — `type` is the discriminant, the rest is JSON. */
export type MintExtension =
  | {
      type: "TransferFeeConfig";
      transferFeeConfigAuthority: string | null;
      withdrawWithheldAuthority: string | null;
      /** Fees already harvested to the mint, raw base units. */
      withheldAmount: string;
      olderTransferFee: TransferFeeView;
      newerTransferFee: TransferFeeView;
    }
  | { type: "PermanentDelegate"; delegate: string | null }
  | { type: "TransferHook"; authority: string | null; programId: string | null }
  | {
      type: "ScaledUiAmount";
      authority: string | null;
      multiplier: number;
      newMultiplier: number;
      /** Unix seconds at which newMultiplier takes effect. */
      newMultiplierEffectiveTimestamp: string;
    }
  | { type: "MetadataPointer"; authority: string | null; metadataAddress: string | null }
  | {
      type: "TokenMetadata";
      updateAuthority: string | null;
      mint: string;
      name: string;
      symbol: string;
      uri: string;
      additionalMetadata: Array<[string, string]>;
    }
  | {
      type: "InterestBearingConfig";
      rateAuthority: string | null;
      /** Current rate in basis points per year (i16). */
      currentRate: number;
      preUpdateAverageRate: number;
      initializationTimestamp: string;
      lastUpdateTimestamp: string;
    }
  | { type: "DefaultAccountState"; state: "initialized" | "frozen" | "uninitialized" }
  | { type: "NonTransferable" }
  | { type: "MintCloseAuthority"; closeAuthority: string | null }
  | { type: "ConfidentialTransferMint" }
  | { type: "ConfidentialTransferFeeConfig" }
  | { type: "GroupPointer"; authority: string | null; groupAddress: string | null }
  | { type: "GroupMemberPointer"; authority: string | null; memberAddress: string | null }
  | { type: "TokenGroup" }
  | { type: "TokenGroupMember" }
  | { type: "Pausable"; authority: string | null; paused: boolean }
  | { type: "PermissionedBurn" }
  | { type: "unknown"; rawType: number; length: number };

export interface TransferFeeView {
  epoch: string;
  transferFeeBasisPoints: number;
  /** Raw base units. */
  maximumFee: string;
}

export interface MintInspection {
  address: string;
  program: TokenProgramKind;
  programId: string;
  decimals: number;
  /** Raw base units. */
  supply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  isInitialized: boolean;
  extensions: MintExtension[];
  /** Expected byte length of an ATA for this mint (getAccountLen). */
  accountLen: number;
  /** Byte length of the mint account itself. */
  dataLength: number;
}

const ZERO_KEY = PublicKey.default.toBase58();

/** Token-2022 encodes "no authority" as the all-zero key. */
function optKey(k: PublicKey | null | undefined): string | null {
  if (!k) return null;
  const s = k.toBase58();
  return s === ZERO_KEY ? null : s;
}

function feeView(f: TransferFee): TransferFeeView {
  return {
    epoch: f.epoch.toString(),
    transferFeeBasisPoints: f.transferFeeBasisPoints,
    maximumFee: f.maximumFee.toString(),
  };
}

function accountStateName(s: AccountState): "initialized" | "frozen" | "uninitialized" {
  if (s === AccountState.Frozen) return "frozen";
  if (s === AccountState.Initialized) return "initialized";
  return "uninitialized";
}

/** Ids that Token-2022 defines but @solana/spl-token's enum doesn't name. */
const EXTRA_MINT_EXTENSION_IDS: Record<number, MintExtension["type"]> = {
  16: "ConfidentialTransferFeeConfig",
};

function decodeExtension(mint: Mint, type: ExtensionType, raw: Buffer): MintExtension {
  switch (type) {
    case ExtensionType.TransferFeeConfig: {
      const c = getTransferFeeConfig(mint)!;
      return {
        type: "TransferFeeConfig",
        transferFeeConfigAuthority: optKey(c.transferFeeConfigAuthority),
        withdrawWithheldAuthority: optKey(c.withdrawWithheldAuthority),
        withheldAmount: c.withheldAmount.toString(),
        olderTransferFee: feeView(c.olderTransferFee),
        newerTransferFee: feeView(c.newerTransferFee),
      };
    }
    case ExtensionType.PermanentDelegate:
      return { type: "PermanentDelegate", delegate: optKey(getPermanentDelegate(mint)?.delegate) };
    case ExtensionType.TransferHook: {
      const h = getTransferHook(mint)!;
      return { type: "TransferHook", authority: optKey(h.authority), programId: optKey(h.programId) };
    }
    case ExtensionType.ScaledUiAmountConfig: {
      const s = getScaledUiAmountConfig(mint)!;
      return {
        type: "ScaledUiAmount",
        authority: optKey(s.authority),
        multiplier: s.multiplier,
        newMultiplier: s.newMultiplier,
        newMultiplierEffectiveTimestamp: s.newMultiplierEffectiveTimestamp.toString(),
      };
    }
    case ExtensionType.MetadataPointer: {
      const p = getMetadataPointerState(mint)!;
      return {
        type: "MetadataPointer",
        authority: optKey(p.authority),
        metadataAddress: optKey(p.metadataAddress),
      };
    }
    case ExtensionType.TokenMetadata: {
      const m = unpackTokenMetadata(raw);
      return {
        type: "TokenMetadata",
        updateAuthority: optKey(m.updateAuthority),
        mint: m.mint.toBase58(),
        name: m.name,
        symbol: m.symbol,
        uri: m.uri,
        additionalMetadata: m.additionalMetadata.map(([k, v]) => [k, v] as [string, string]),
      };
    }
    case ExtensionType.InterestBearingConfig: {
      const i = getInterestBearingMintConfigState(mint)!;
      return {
        type: "InterestBearingConfig",
        rateAuthority: optKey(i.rateAuthority),
        currentRate: i.currentRate,
        preUpdateAverageRate: i.preUpdateAverageRate,
        initializationTimestamp: i.initializationTimestamp.toString(),
        lastUpdateTimestamp: i.lastUpdateTimestamp.toString(),
      };
    }
    case ExtensionType.DefaultAccountState:
      return { type: "DefaultAccountState", state: accountStateName(getDefaultAccountState(mint)!.state) };
    case ExtensionType.NonTransferable:
      return { type: "NonTransferable" };
    case ExtensionType.MintCloseAuthority:
      return { type: "MintCloseAuthority", closeAuthority: optKey(getMintCloseAuthority(mint)?.closeAuthority) };
    case ExtensionType.ConfidentialTransferMint:
      return { type: "ConfidentialTransferMint" };
    case ExtensionType.GroupPointer: {
      const g = getGroupPointerState(mint)!;
      return { type: "GroupPointer", authority: optKey(g.authority), groupAddress: optKey(g.groupAddress) };
    }
    case ExtensionType.GroupMemberPointer: {
      const g = getGroupMemberPointerState(mint)!;
      return { type: "GroupMemberPointer", authority: optKey(g.authority), memberAddress: optKey(g.memberAddress) };
    }
    case ExtensionType.TokenGroup:
      return { type: "TokenGroup" };
    case ExtensionType.TokenGroupMember:
      return { type: "TokenGroupMember" };
    case ExtensionType.PausableConfig: {
      const p = getPausableConfig(mint)!;
      return { type: "Pausable", authority: optKey(p.authority), paused: p.paused };
    }
    case ExtensionType.PermissionedBurn:
      return { type: "PermissionedBurn" };
    default: {
      const named = EXTRA_MINT_EXTENSION_IDS[type as number];
      if (named) return { type: named } as MintExtension;
      return { type: "unknown", rawType: type as number, length: raw.length };
    }
  }
}

/**
 * Account-side extensions implied by the mint's extensions, used to size an
 * ATA. ImmutableOwner is always present on a Token-2022 ATA.
 */
export function impliedAccountExtensions(mintExtensions: ExtensionType[]): ExtensionType[] {
  const out = new Set<ExtensionType>([ExtensionType.ImmutableOwner]);
  for (const e of mintExtensions) {
    switch (e) {
      case ExtensionType.TransferFeeConfig:
        out.add(ExtensionType.TransferFeeAmount);
        break;
      case ExtensionType.NonTransferable:
        out.add(ExtensionType.NonTransferableAccount);
        break;
      case ExtensionType.TransferHook:
        out.add(ExtensionType.TransferHookAccount);
        break;
      case ExtensionType.ConfidentialTransferMint:
        out.add(ExtensionType.ConfidentialTransferAccount);
        break;
      case ExtensionType.PausableConfig:
        out.add(ExtensionType.PausableAccount);
        break;
      default:
        break;
    }
  }
  return [...out];
}

/** Walk the TLV once so unknown types are preserved in on-chain order. */
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

/** Pure decoder for a raw mint account. */
export function decodeMintAccount(
  address: PublicKey,
  info: AccountInfo<Buffer>,
): MintInspection {
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
    throw new SolwalletError(`Account ${address.toBase58()} is not a token mint (owned by ${owner}).`, {
      code: "NOT_A_MINT",
      hint: "Pass the address of an SPL Token or Token-2022 mint.",
    });
  }

  let mint: Mint;
  try {
    mint = unpackMint(address, info, programId);
  } catch (cause) {
    throw new SolwalletError(`Account ${address.toBase58()} does not decode as a mint.`, {
      code: "NOT_A_MINT",
      hint: "The account is owned by a token program but is not mint-shaped (maybe a token account or multisig).",
      cause,
    });
  }

  const extensions: MintExtension[] = [];
  let accountLen = ACCOUNT_SIZE;
  if (program === "token-2022") {
    for (const { type, data } of tlvEntries(mint.tlvData)) {
      extensions.push(decodeExtension(mint, type as ExtensionType, data));
    }
    const known = getExtensionTypes(mint.tlvData);
    accountLen = getAccountLen(impliedAccountExtensions(known));
  }

  return {
    address: address.toBase58(),
    program,
    programId: programId.toBase58(),
    decimals: mint.decimals,
    supply: mint.supply.toString(),
    mintAuthority: mint.mintAuthority?.toBase58() ?? null,
    freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
    isInitialized: mint.isInitialized,
    extensions,
    accountLen,
    dataLength: info.data.length,
  };
}

/** Fetch + decode a mint. Throws MINT_NOT_FOUND / NOT_A_MINT. */
export async function inspectMint(
  conn: ClusterConnection,
  mint: string | PublicKey,
): Promise<MintInspection> {
  const address = typeof mint === "string" ? new PublicKey(mint) : mint;
  const info = await conn.connection.getAccountInfo(address);
  if (!info) {
    throw new SolwalletError(`Mint ${address.toBase58()} not found on cluster "${conn.cluster}".`, {
      code: "MINT_NOT_FOUND",
      hint: "Verify the mint address and the connected cluster; a mint that exists on devnet does not exist on mainnet-beta.",
    });
  }
  return decodeMintAccount(address, info);
}

// Re-exported so callers can size accounts without importing spl-token.
export { getExtensionData, getExtensionTypes };
