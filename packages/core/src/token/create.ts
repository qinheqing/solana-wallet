/**
 * Token mint creation (task #8): classic SPL mints and Token-2022 mints
 * with optional extensions, all in ONE transaction per mint.
 *
 * Extension space is computed via getMintLen(fixed extensions). The
 * variable-length TokenMetadata TLV is NOT part of the allocated space
 * (InitializeMint2 rejects over-sized accounts); instead its bytes are
 * pre-funded in lamports so the metadata program can realloc rent-free.
 */
import {
  AccountState,
  ExtensionType,
  LENGTH_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createInitializeDefaultAccountStateInstruction,
  createInitializeInterestBearingMintInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createInitializeMintInstruction,
  createInitializeMintCloseAuthorityInstruction,
  createInitializeNonTransferableMintInstruction,
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  TYPE_SIZE,
  getMintLen,
} from "@solana/spl-token";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";

import type { ClusterConnection } from "../connection/connection.js";
import { SolwalletError } from "../connection/errors.js";
import {
  signAndSendTokenTx,
  toPublicKey,
  type SendTokenOptions,
  type TokenTxResult,
} from "./internal.js";
import {
  createMetaplexMetadataInstruction,
  validateTokenMetadata,
  type TokenMetadataInput,
} from "./metaplex.js";

const MAX_DECIMALS = 18; // u256-based supply; SPL tooling caps at 18
const MAX_BPS = 10_000; // 100% in basis points
const MIN_I16 = -32_768;
const MAX_I16 = 32_767;

export interface CreateMintOptions extends SendTokenOptions {
  decimals: number;
  /** Defaults to the paying wallet. */
  mintAuthority?: string | Keypair | PublicKey;
  /** Defaults to the paying wallet. Pass null to omit (no freezing). */
  freezeAuthority?: string | Keypair | PublicKey | null;
}

/** Token-2022 extension configuration (each entry enables one extension). */
export interface Token2022ExtensionOptions {
  transferFeeConfig?: {
    /** Fee in basis points, 0–10000. */
    transferFeeBasisPoints: number;
    /** Maximum fee in base units (bigint-safe). */
    maximumFee: bigint | number | string;
  };
  transferHook?: {
    /** Program invoked on every transfer of this mint. */
    programId: string | PublicKey;
  };
  interestBearingConfig?: {
    /** Signed interest rate in basis points, i16 on chain. */
    rate: number;
  };
  nonTransferable?: boolean;
  permanentDelegate?: {
    /** Delegate allowed to transfer/burn ANY account of this mint. */
    delegate: string | PublicKey;
  };
  /** On-chain metadata; implies a MetadataPointer pointing at the mint itself. */
  tokenMetadata?: {
    name: string;
    symbol: string;
    uri: string;
  };
  defaultAccountState?: {
    /** Only 'frozen' is representable (accounts start frozen). */
    accountState: "frozen";
  };
  /**
   * ScaledUiAmount (PRD T-F): wallets/explorers multiply raw amounts by
   * `multiplier` for DISPLAY ONLY. On-chain balances, transfer amounts and
   * every amount this library accepts or returns stay raw base units — the
   * wallet never scales amounts by this multiplier.
   */
  /**
   * Pausable: the pause authority can halt ALL transfers, mints and burns of
   * this mint (pause/resume at runtime).
   */
  pausable?: {
    /** Pause authority. Defaults to the payer. */
    authority?: string | PublicKey;
  };
  /**
   * MintCloseAuthority: lets the close authority close the mint account
   * (reclaiming its rent) once supply is 0.
   */
  mintCloseAuthority?: {
    /** Close authority. Defaults to the payer. */
    closeAuthority?: string | PublicKey;
  };
  scaledUiAmount?: {
    /** Display multiplier (f64 on chain), must be > 0. */
    multiplier: number;
    /** Authority allowed to update the multiplier. Defaults to the payer. */
    authority?: string | PublicKey;
  };
}

export interface CreateTokenResult extends TokenTxResult {
  mint: string;
  /** Enabled extension names, e.g. ["transferFeeConfig", "tokenMetadata"]. */
  extensions: string[];
}

/** Validate shared mint parameters before building anything. */
function validateMintParams(opts: CreateMintOptions): void {
  if (
    !Number.isInteger(opts.decimals) ||
    opts.decimals < 0 ||
    opts.decimals > MAX_DECIMALS
  ) {
    throw new SolwalletError(
      `decimals must be an integer between 0 and ${MAX_DECIMALS}, got ${opts.decimals}.`,
      {
        code: "DECIMALS_INVALID",
        hint: "Common values: 9 (SOL-like), 6 (USDC-like), 0 (NFT-like supply).",
      },
    );
  }
}

function validateExtensions(ext: Token2022ExtensionOptions): void {
  if (ext.tokenMetadata) {
    // Token-2022 metadata has no hard byte caps; only reject empty name/symbol.
    validateTokenMetadata(ext.tokenMetadata, { name: 1024, symbol: 1024, uri: 4096 });
  }
  const fee = ext.transferFeeConfig;
  if (fee) {
    if (
      !Number.isInteger(fee.transferFeeBasisPoints) ||
      fee.transferFeeBasisPoints < 0 ||
      fee.transferFeeBasisPoints > MAX_BPS
    ) {
      throw new SolwalletError(
        `transferFeeBasisPoints must be an integer between 0 and ${MAX_BPS}, got ${fee.transferFeeBasisPoints}.`,
        {
          code: "TRANSFER_FEE_INVALID",
          hint: "Basis points are 1/100th of a percent: 100 = 1%, 10000 = 100%. The maximum fee itself is set with maximumFee in base units.",
        },
      );
    }
    if (BigInt(fee.maximumFee) < 0n) {
      throw new SolwalletError("maximumFee must be a non-negative integer.", {
        code: "TRANSFER_FEE_INVALID",
        hint: "maximumFee is the fee cap in token base units (bigint-compatible value).",
      });
    }
  }
  const interest = ext.interestBearingConfig;
  if (
    interest &&
    (!Number.isInteger(interest.rate) ||
      interest.rate < MIN_I16 ||
      interest.rate > MAX_I16)
  ) {
    throw new SolwalletError(
      `interest rate must be an integer between ${MIN_I16} and ${MAX_I16}, got ${interest.rate}.`,
      {
        code: "INTEREST_RATE_INVALID",
        hint: "The rate is stored as a signed i16 on chain. Use 0 for a non-interest-bearing start.",
      },
    );
  }
  const meta = ext.tokenMetadata;
  if (meta && (meta.name.length === 0 || meta.symbol.length === 0)) {
    throw new SolwalletError("tokenMetadata requires a non-empty name and symbol.", {
      code: "METADATA_INVALID",
      hint: "name and symbol are required fields of Token-2022 on-chain metadata; uri may be an empty string.",
    });
  }
  if (ext.defaultAccountState && ext.defaultAccountState.accountState !== "frozen") {
    throw new SolwalletError(
      `defaultAccountState must be "frozen" (got "${ext.defaultAccountState.accountState}").`,
      {
        code: "ACCOUNT_STATE_INVALID",
        hint: "Only a frozen default is representable on chain: new accounts start frozen until a freeze authority thaws them.",
      },
    );
  }
  const scaled = ext.scaledUiAmount;
  if (scaled && !(Number.isFinite(scaled.multiplier) && scaled.multiplier > 0)) {
    throw new SolwalletError(
      `scaledUiAmount.multiplier must be a finite number > 0, got ${scaled.multiplier}.`,
      {
        code: "SCALED_UI_MULTIPLIER_INVALID",
        hint: "The multiplier only changes how UIs display balances (raw × multiplier); 1 means no scaling.",
      },
    );
  }
  if (ext.nonTransferable && (ext.transferFeeConfig || ext.transferHook)) {
    throw new SolwalletError(
      "nonTransferable is incompatible with transferFeeConfig and transferHook.",
      {
        code: "EXTENSIONS_INCOMPATIBLE",
        hint: "A non-transferable mint never executes transfers, so fee/hooks on transfers are meaningless and rejected.",
      },
    );
  }
}

function authorityKey(
  value: string | Keypair | PublicKey | null | undefined,
  fallback: PublicKey,
): PublicKey | null {
  if (value === null) return null;
  if (value === undefined) return fallback;
  return value instanceof Keypair ? value.publicKey : toPublicKey(value);
}

/**
 * Create a classic SPL Token mint in one transaction:
 * System createAccount + initializeMint.
 */
export async function createSplToken(
  conn: ClusterConnection,
  from: Keypair,
  opts: CreateMintOptions & {
    /**
     * Name/symbol/uri via a Metaplex Token Metadata account, created in the
     * same transaction. Requires the Metaplex program on the cluster.
     */
    metadata?: TokenMetadataInput;
  },
): Promise<CreateTokenResult> {
  validateMintParams(opts);
  if (opts.metadata) validateTokenMetadata(opts.metadata);
  const mint = Keypair.generate();
  const mintAuthority = authorityKey(opts.mintAuthority, from.publicKey)!;
  const freezeAuthority = authorityKey(opts.freezeAuthority, from.publicKey);
  const extraSigners = [mint];
  if (opts.metadata && !mintAuthority.equals(from.publicKey)) {
    // Metaplex requires the mint authority to sign CreateMetadataAccountV3.
    if (opts.mintAuthority instanceof Keypair) {
      extraSigners.push(opts.mintAuthority);
    } else {
      throw new SolwalletError("Creating metadata requires the mint authority to sign.", {
        code: "METADATA_INVALID",
        hint: "Pass mintAuthority as a Keypair, or leave it as the payer, when setting metadata.",
      });
    }
  }

  const lamports = await conn.connection.getMinimumBalanceForRentExemption(82);
  const instructions = [
    SystemProgram.createAccount({
      fromPubkey: from.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports,
      space: 82, // classic Mint layout (no extensions)
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      mint.publicKey,
      opts.decimals,
      mintAuthority,
      freezeAuthority,
    ),
  ];
  if (opts.metadata) {
    instructions.push(
      createMetaplexMetadataInstruction({
        mint: mint.publicKey,
        mintAuthority,
        payer: from.publicKey,
        updateAuthority: from.publicKey,
        metadata: opts.metadata,
      }),
    );
  }

  const result = await signAndSendTokenTx(conn, from, instructions, {
    dryRun: opts.dryRun,
    allowMainnet: opts.allowMainnet,
    policy: opts.policy,
    extraSigners,
  });
  return {
    ...result,
    mint: mint.publicKey.toBase58(),
    extensions: opts.metadata ? ["metaplexMetadata"] : [],
  };
}

/**
 * Create a Token-2022 mint with optional extensions in one transaction:
 * System createAccount (space from getMintLen) → extension init instructions
 * → initializeMint2 → token-metadata init (when configured).
 */
export async function createToken2022(
  conn: ClusterConnection,
  from: Keypair,
  opts: CreateMintOptions & { extensions?: Token2022ExtensionOptions },
): Promise<CreateTokenResult> {
  validateMintParams(opts);
  const ext = opts.extensions ?? {};
  validateExtensions(ext);

  const mint = Keypair.generate();
  const mintAuthority = authorityKey(opts.mintAuthority, from.publicKey)!;
  const freezeAuthority = authorityKey(opts.freezeAuthority, from.publicKey);
  const hasMetadata = ext.tokenMetadata !== undefined;

  // --- account space: fixed-size extensions only (MetadataPointer included).
  // Token-2022's InitializeMint2 requires the account length to equal the
  // length computed from its initialized fixed extensions — allocating the
  // TokenMetadata TLV up front makes it fail with InvalidAccountData.
  // Instead, the metadata bytes are pre-funded as rent (TYPE + LENGTH header
  // + packed metadata) so createInitializeInstruction can realloc in place.
  const extensionTypes: ExtensionType[] = [];
  if (ext.transferFeeConfig) extensionTypes.push(ExtensionType.TransferFeeConfig);
  if (ext.transferHook) extensionTypes.push(ExtensionType.TransferHook);
  if (ext.interestBearingConfig) extensionTypes.push(ExtensionType.InterestBearingConfig);
  if (ext.nonTransferable) extensionTypes.push(ExtensionType.NonTransferable);
  if (ext.permanentDelegate) extensionTypes.push(ExtensionType.PermanentDelegate);
  if (hasMetadata) extensionTypes.push(ExtensionType.MetadataPointer);
  if (ext.defaultAccountState) extensionTypes.push(ExtensionType.DefaultAccountState);
  if (ext.scaledUiAmount) extensionTypes.push(ExtensionType.ScaledUiAmountConfig);
  if (ext.pausable) extensionTypes.push(ExtensionType.PausableConfig);
  if (ext.mintCloseAuthority) extensionTypes.push(ExtensionType.MintCloseAuthority);

  const space = getMintLen(extensionTypes);
  const metadataLen = hasMetadata
    ? TYPE_SIZE +
      LENGTH_SIZE +
      pack({
        mint: mint.publicKey,
        updateAuthority: from.publicKey,
        name: ext.tokenMetadata!.name,
        symbol: ext.tokenMetadata!.symbol,
        uri: ext.tokenMetadata!.uri,
        additionalMetadata: [],
      }).length
    : 0;

  const lamports = await conn.connection.getMinimumBalanceForRentExemption(
    space + metadataLen,
  );

  const instructions: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: from.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports,
      space,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
  ];

  // --- extension initialization (before initializeMint2)
  if (ext.transferFeeConfig) {
    instructions.push(
      createInitializeTransferFeeConfigInstruction(
        mint.publicKey,
        from.publicKey, // transfer fee config authority
        from.publicKey, // withdraw withheld authority
        ext.transferFeeConfig.transferFeeBasisPoints,
        BigInt(ext.transferFeeConfig.maximumFee),
      ),
    );
  }
  if (ext.transferHook) {
    instructions.push(
      createInitializeTransferHookInstruction(
        mint.publicKey,
        from.publicKey, // hook authority
        toPublicKey(ext.transferHook.programId),
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }
  if (ext.interestBearingConfig) {
    instructions.push(
      createInitializeInterestBearingMintInstruction(
        mint.publicKey,
        from.publicKey, // rate authority
        ext.interestBearingConfig.rate,
      ),
    );
  }
  if (ext.nonTransferable) {
    instructions.push(
      createInitializeNonTransferableMintInstruction(mint.publicKey, TOKEN_2022_PROGRAM_ID),
    );
  }
  if (ext.permanentDelegate) {
    instructions.push(
      createInitializePermanentDelegateInstruction(
        mint.publicKey,
        toPublicKey(ext.permanentDelegate.delegate),
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }
  if (hasMetadata) {
    // Pointer first, metadata init later (after initializeMint2).
    instructions.push(
      createInitializeMetadataPointerInstruction(
        mint.publicKey,
        from.publicKey, // pointer authority
        mint.publicKey, // metadata lives on the mint itself
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }
  if (ext.defaultAccountState) {
    instructions.push(
      createInitializeDefaultAccountStateInstruction(
        mint.publicKey,
        AccountState.Frozen,
      ),
    );
  }

  if (ext.scaledUiAmount) {
    instructions.push(
      createInitializeScaledUiAmountConfigInstruction(
        mint.publicKey,
        ext.scaledUiAmount.authority ? toPublicKey(ext.scaledUiAmount.authority) : from.publicKey,
        ext.scaledUiAmount.multiplier,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }

  if (ext.pausable) {
    instructions.push(
      createInitializePausableConfigInstruction(
        mint.publicKey,
        ext.pausable.authority ? toPublicKey(ext.pausable.authority) : from.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }
  if (ext.mintCloseAuthority) {
    instructions.push(
      createInitializeMintCloseAuthorityInstruction(
        mint.publicKey,
        ext.mintCloseAuthority.closeAuthority ? toPublicKey(ext.mintCloseAuthority.closeAuthority) : from.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }

  // --- mint core
  instructions.push(
    createInitializeMint2Instruction(
      mint.publicKey,
      opts.decimals,
      mintAuthority,
      freezeAuthority,
      TOKEN_2022_PROGRAM_ID,
    ),
  );

  // --- token metadata last (requires an initialized mint)
  if (hasMetadata) {
    instructions.push(
      createInitializeInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint.publicKey,
        updateAuthority: from.publicKey,
        mint: mint.publicKey,
        mintAuthority,
        name: ext.tokenMetadata!.name,
        symbol: ext.tokenMetadata!.symbol,
        uri: ext.tokenMetadata!.uri,
      }),
    );
  }

  const result = await signAndSendTokenTx(conn, from, instructions, {
    dryRun: opts.dryRun,
    allowMainnet: opts.allowMainnet,
    policy: opts.policy,
    extraSigners: [mint],
  });
  return { ...result, mint: mint.publicKey.toBase58(), extensions: Object.keys(ext) };
}
