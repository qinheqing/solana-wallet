/**
 * Test-only builders for raw Token / Token-2022 mint and token-account
 * buffers (base struct + account-type byte + TLV extensions), so decoders
 * are exercised offline on byte-faithful data.
 */
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  AccountType,
  CpiGuardLayout,
  DefaultAccountStateLayout,
  ExtensionType,
  InterestBearingMintConfigStateLayout,
  MemoTransferLayout,
  MetadataPointerLayout,
  MintLayout,
  MINT_SIZE,
  PermanentDelegateLayout,
  ScaledUiAmountConfigLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TransferFeeAmountLayout,
  TransferFeeConfigLayout,
  TransferHookAccountLayout,
  TransferHookLayout,
} from "@solana/spl-token";
import { pack as packTokenMetadata } from "@solana/spl-token-metadata";
import { PublicKey, type AccountInfo } from "@solana/web3.js";

export interface TlvEntry {
  type: number;
  data: Buffer;
}

function tlv(entries: TlvEntry[]): Buffer {
  return Buffer.concat(
    entries.map(({ type, data }) => {
      const head = Buffer.alloc(4);
      head.writeUInt16LE(type, 0);
      head.writeUInt16LE(data.length, 2);
      return Buffer.concat([head, data]);
    }),
  );
}

function encode<T>(layout: { span: number; encode(src: T, b: Buffer): number }, value: T): Buffer {
  const b = Buffer.alloc(layout.span);
  layout.encode(value, b);
  return b;
}

export function mintBase(opts: {
  mintAuthority?: PublicKey | null;
  freezeAuthority?: PublicKey | null;
  supply?: bigint;
  decimals?: number;
}): Buffer {
  return encode(MintLayout, {
    mintAuthorityOption: opts.mintAuthority ? 1 : 0,
    mintAuthority: opts.mintAuthority ?? PublicKey.default,
    supply: opts.supply ?? 0n,
    decimals: opts.decimals ?? 6,
    isInitialized: true,
    freezeAuthorityOption: opts.freezeAuthority ? 1 : 0,
    freezeAuthority: opts.freezeAuthority ?? PublicKey.default,
  });
}

export function accountBase(opts: {
  mint: PublicKey;
  owner: PublicKey;
  amount?: bigint;
  delegate?: PublicKey | null;
  delegatedAmount?: bigint;
  state?: AccountState;
  closeAuthority?: PublicKey | null;
}): Buffer {
  return encode(AccountLayout, {
    mint: opts.mint,
    owner: opts.owner,
    amount: opts.amount ?? 0n,
    delegateOption: opts.delegate ? 1 : 0,
    delegate: opts.delegate ?? PublicKey.default,
    state: opts.state ?? AccountState.Initialized,
    isNativeOption: 0,
    isNative: 0n,
    delegatedAmount: opts.delegatedAmount ?? 0n,
    closeAuthorityOption: opts.closeAuthority ? 1 : 0,
    closeAuthority: opts.closeAuthority ?? PublicKey.default,
  });
}

/** Legacy SPL mint: exactly 82 bytes. */
export function legacyMintInfo(base: Buffer): AccountInfo<Buffer> {
  return { owner: TOKEN_PROGRAM_ID, data: base, lamports: 1, executable: false };
}

/** Token-2022 mint: 82-byte base, padded to 165, type byte, then TLV. */
export function token2022MintInfo(base: Buffer, extensions: TlvEntry[]): AccountInfo<Buffer> {
  const padded = Buffer.alloc(ACCOUNT_SIZE);
  base.copy(padded, 0, 0, MINT_SIZE);
  const data = Buffer.concat([padded, Buffer.from([AccountType.Mint]), tlv(extensions)]);
  return { owner: TOKEN_2022_PROGRAM_ID, data, lamports: 1, executable: false };
}

export function legacyAccountInfo(base: Buffer): AccountInfo<Buffer> {
  return { owner: TOKEN_PROGRAM_ID, data: base, lamports: 1, executable: false };
}

export function token2022AccountInfo(base: Buffer, extensions: TlvEntry[]): AccountInfo<Buffer> {
  const data = Buffer.concat([base, Buffer.from([AccountType.Account]), tlv(extensions)]);
  return { owner: TOKEN_2022_PROGRAM_ID, data, lamports: 1, executable: false };
}

// --- extension encoders ------------------------------------------------------

export const ext = {
  transferFeeConfig(o: {
    configAuthority: PublicKey;
    withdrawAuthority: PublicKey;
    withheld: bigint;
    older: { epoch: bigint; bps: number; maxFee: bigint };
    newer: { epoch: bigint; bps: number; maxFee: bigint };
  }): TlvEntry {
    return {
      type: ExtensionType.TransferFeeConfig,
      data: encode(TransferFeeConfigLayout, {
        transferFeeConfigAuthority: o.configAuthority,
        withdrawWithheldAuthority: o.withdrawAuthority,
        withheldAmount: o.withheld,
        olderTransferFee: { epoch: o.older.epoch, maximumFee: o.older.maxFee, transferFeeBasisPoints: o.older.bps },
        newerTransferFee: { epoch: o.newer.epoch, maximumFee: o.newer.maxFee, transferFeeBasisPoints: o.newer.bps },
      }),
    };
  },
  permanentDelegate(delegate: PublicKey): TlvEntry {
    return { type: ExtensionType.PermanentDelegate, data: encode(PermanentDelegateLayout, { delegate }) };
  },
  transferHook(authority: PublicKey, programId: PublicKey): TlvEntry {
    return { type: ExtensionType.TransferHook, data: encode(TransferHookLayout, { authority, programId }) };
  },
  scaledUiAmount(o: { authority: PublicKey; multiplier: number; newMultiplier: number; effectiveAt: bigint }): TlvEntry {
    return {
      type: ExtensionType.ScaledUiAmountConfig,
      data: encode(ScaledUiAmountConfigLayout, {
        authority: o.authority,
        multiplier: o.multiplier,
        newMultiplierEffectiveTimestamp: o.effectiveAt,
        newMultiplier: o.newMultiplier,
      }),
    };
  },
  metadataPointer(authority: PublicKey, metadataAddress: PublicKey): TlvEntry {
    return { type: ExtensionType.MetadataPointer, data: encode(MetadataPointerLayout, { authority, metadataAddress }) };
  },
  tokenMetadata(o: { updateAuthority: PublicKey; mint: PublicKey; name: string; symbol: string; uri: string }): TlvEntry {
    return {
      type: ExtensionType.TokenMetadata,
      data: Buffer.from(packTokenMetadata({ ...o, additionalMetadata: [["tier", "gold"]] })),
    };
  },
  interestBearing(o: { rateAuthority: PublicKey; currentRate: number; avg: number; init: bigint; last: bigint }): TlvEntry {
    return {
      type: ExtensionType.InterestBearingConfig,
      // The layout's ns64 fields encode from numbers but decode to bigint.
      data: encode(InterestBearingMintConfigStateLayout, {
        rateAuthority: o.rateAuthority,
        initializationTimestamp: Number(o.init) as unknown as bigint,
        preUpdateAverageRate: o.avg,
        lastUpdateTimestamp: Number(o.last) as unknown as bigint,
        currentRate: o.currentRate,
      }),
    };
  },
  defaultAccountState(state: AccountState): TlvEntry {
    return { type: ExtensionType.DefaultAccountState, data: encode(DefaultAccountStateLayout, { state }) };
  },
  nonTransferable(): TlvEntry {
    return { type: ExtensionType.NonTransferable, data: Buffer.alloc(0) };
  },
  /** ConfidentialTransferMint is 97 bytes on chain; content is opaque here. */
  confidentialTransferMint(): TlvEntry {
    return { type: ExtensionType.ConfidentialTransferMint, data: Buffer.alloc(97) };
  },
  unknown(type: number, len: number): TlvEntry {
    return { type, data: Buffer.alloc(len, 0xab) };
  },
  // account-side
  memoTransfer(require: boolean): TlvEntry {
    return { type: ExtensionType.MemoTransfer, data: encode(MemoTransferLayout, { requireIncomingTransferMemos: require }) };
  },
  immutableOwner(): TlvEntry {
    return { type: ExtensionType.ImmutableOwner, data: Buffer.alloc(0) };
  },
  cpiGuard(lock: boolean): TlvEntry {
    return { type: ExtensionType.CpiGuard, data: encode(CpiGuardLayout, { lockCpi: lock }) };
  },
  transferFeeAmount(withheld: bigint): TlvEntry {
    return { type: ExtensionType.TransferFeeAmount, data: encode(TransferFeeAmountLayout, { withheldAmount: withheld }) };
  },
  nonTransferableAccount(): TlvEntry {
    return { type: ExtensionType.NonTransferableAccount, data: Buffer.alloc(0) };
  },
  transferHookAccount(transferring: boolean): TlvEntry {
    return { type: ExtensionType.TransferHookAccount, data: encode(TransferHookAccountLayout, { transferring }) };
  },
};
