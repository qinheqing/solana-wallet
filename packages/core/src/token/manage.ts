/**
 * Token-2022 runtime management (task #9): mintTo/burn (both programs),
 * transfer-fee updates, freeze/thaw, authority rotation and on-chain
 * metadata updates. Every mutating call goes through signAndSendTokenTx
 * (dryRun-aware, mainnet-guarded) and returns a uniform result shape.
 */
import {
  ACCOUNT_SIZE,
  AuthorityType,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  AccountState,
  createBurnInstruction,
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  createPauseInstruction,
  createResumeInstruction,
  createUpdateDefaultAccountStateInstruction,
  createUpdateRateInterestBearingMintInstruction,
  getMint,
  getTransferFeeAmount,
  unpackAccount,
  createDisableRequiredMemoTransfersInstruction,
  createEnableRequiredMemoTransfersInstruction,
  createFreezeAccountInstruction,
  createHarvestWithheldTokensToMintInstruction,
  createMintToInstruction,
  createReallocateInstruction,
  createSetAuthorityInstruction,
  createSetTransferFeeInstruction,
  createThawAccountInstruction,
  createUpdateMultiplierDataInstruction,
  createUpdateTransferHookInstruction,
  createWithdrawWithheldTokensFromAccountsInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
  getAssociatedTokenAddress,
  getExtensionTypes,
} from "@solana/spl-token";
import { Field, createUpdateFieldInstruction } from "@solana/spl-token-metadata";
import { Keypair, PublicKey } from "@solana/web3.js";

import type { ClusterConnection } from "../connection/connection.js";
import { SolwalletError } from "../connection/errors.js";
import { getMintProgram } from "../transfer/program.js";
import {
  requireToken2022,
  signAndSendTokenTx,
  toPublicKey,
  type SendTokenOptions,
  type TokenTxResult,
} from "./internal.js";

export type TokenManageResult = TokenTxResult;

const MAX_BPS = 10_000;

function assertPositiveAmount(fn: string, amount: bigint): void {
  if (amount <= 0n) {
    throw new SolwalletError(`${fn}: amount must be a positive integer, got ${amount}.`, {
      code: "AMOUNT_INVALID",
      hint: "Amounts are token base units (bigint). Use parseAmount(humanString, decimals) to convert.",
    });
  }
}

/** Transfer-fee params accepted by setTransferFee (and validated there). */
export interface TransferFeeUpdate {
  /** New fee in basis points, 0–10000. Takes effect at the next epoch. */
  transferFeeBasisPoints: number;
  /** New maximum fee in base units. */
  maximumFee: bigint | number | string;
}

function validateTransferFee(fee: TransferFeeUpdate): bigint {
  if (
    !Number.isInteger(fee.transferFeeBasisPoints) ||
    fee.transferFeeBasisPoints < 0 ||
    fee.transferFeeBasisPoints > MAX_BPS
  ) {
    throw new SolwalletError(
      `transferFeeBasisPoints must be an integer between 0 and ${MAX_BPS}, got ${fee.transferFeeBasisPoints}.`,
      {
        code: "TRANSFER_FEE_INVALID",
        hint: "Basis points are 1/100th of a percent: 100 = 1%, 10000 = 100%.",
      },
    );
  }
  const maxFee = BigInt(fee.maximumFee);
  if (maxFee < 0n) {
    throw new SolwalletError("maximumFee must be a non-negative integer.", {
      code: "TRANSFER_FEE_INVALID",
    });
  }
  return maxFee;
}

/** Resolve the ATA of `owner` and an idempotent-create instruction if missing. */
async function prepareAta(
  conn: ClusterConnection,
  payer: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  programId: PublicKey,
): Promise<{ ata: PublicKey; createInstruction: ReturnType<typeof createAssociatedTokenAccountIdempotentInstruction> | null }> {
  const ata = await getAssociatedTokenAddress(mint, owner, true, programId);
  const info = await conn.connection.getAccountInfo(ata);
  if (info) return { ata, createInstruction: null };
  return {
    ata,
    createInstruction: createAssociatedTokenAccountIdempotentInstruction(
      payer,
      ata,
      owner,
      mint,
      programId,
    ),
  };
}

/** Token-2022 metadata field names mapped to the on-chain Field enum. */
const METADATA_FIELDS = {
  name: Field.Name,
  symbol: Field.Symbol,
  uri: Field.Uri,
} as const;

/**
 * Mint `amount` base units to the owner's ATA (created idempotently when
 * missing), or into `opts.destinationAccount` (any token account, never
 * created — `destinationOwner` may then be null). Works for both SPL and
 * Token-2022 mints.
 */
export async function mintTokens(
  conn: ClusterConnection,
  from: Keypair,
  mint: string | PublicKey,
  destinationOwner: string | PublicKey | null,
  amount: bigint,
  opts: SendTokenOptions & { destinationAccount?: string | PublicKey } = {},
): Promise<TokenManageResult> {
  assertPositiveAmount("mintTokens", amount);
  const mintKey = toPublicKey(mint);
  const program = await getMintProgram(conn, mintKey);

  const instructions = [];
  let target: PublicKey;
  if (opts.destinationAccount) {
    target = toPublicKey(opts.destinationAccount);
  } else {
    if (destinationOwner === null) {
      throw new SolwalletError("mintTokens needs a destination owner or opts.destinationAccount.", {
        code: "DESTINATION_REQUIRED",
      });
    }
    const dest = await prepareAta(conn, from.publicKey, mintKey, toPublicKey(destinationOwner), program.programId);
    if (dest.createInstruction) instructions.push(dest.createInstruction);
    target = dest.ata;
  }
  instructions.push(
    createMintToInstruction(
      mintKey,
      target,
      from.publicKey, // mint authority
      amount,
      [],
      program.programId,
    ),
  );
  return signAndSendTokenTx(conn, from, instructions, opts);
}

export interface BurnTokensOptions extends SendTokenOptions {
  /** Token account to burn from (ATA or not). Excludes sourceOwner. */
  sourceAccount?: string | PublicKey;
  /** Owner whose ATA is burned from. Default: the signer. */
  sourceOwner?: string | PublicKey;
  /** Default "burnChecked" (validates decimals); "burn" emits the unchecked instruction. */
  instruction?: "burnChecked" | "burn";
}

/**
 * Burn `amount` base units. Source: `sourceAccount`, else the ATA of
 * `sourceOwner` (default: the signer). The signer is the burn authority —
 * the account owner, its approved delegate, or the mint's permanent
 * delegate; the token program decides whether it may.
 */
export async function burnTokens(
  conn: ClusterConnection,
  from: Keypair,
  mint: string | PublicKey,
  amount: bigint,
  opts: BurnTokensOptions = {},
): Promise<TokenManageResult> {
  assertPositiveAmount("burnTokens", amount);
  if (opts.sourceAccount && opts.sourceOwner) {
    throw new SolwalletError("sourceAccount and sourceOwner are mutually exclusive.", {
      code: "OPTION_CONFLICT",
      hint: "sourceAccount names the token account directly; sourceOwner derives its ATA. Pass one.",
    });
  }
  const mintKey = toPublicKey(mint);
  const program = await getMintProgram(conn, mintKey);
  const source = opts.sourceAccount
    ? toPublicKey(opts.sourceAccount)
    : await getAssociatedTokenAddress(
        mintKey,
        opts.sourceOwner ? toPublicKey(opts.sourceOwner) : from.publicKey,
        true,
        program.programId,
      );

  const ix =
    opts.instruction === "burn"
      ? createBurnInstruction(source, mintKey, from.publicKey, amount, [], program.programId)
      : createBurnCheckedInstruction(
          source,
          mintKey,
          from.publicKey, // authority: owner / delegate / permanent delegate
          amount,
          (await getMint(conn.connection, mintKey, "confirmed", program.programId)).decimals,
          [],
          program.programId,
        );
  return signAndSendTokenTx(conn, from, [ix], opts);
}

/**
 * Update a Token-2022 mint's transfer fee. NOTE: the new fee takes effect
 * at the START OF THE NEXT EPOCH (~2 days), not immediately.
 */
export async function setTransferFee(
  conn: ClusterConnection,
  from: Keypair,
  mint: string | PublicKey,
  fee: TransferFeeUpdate,
  opts: SendTokenOptions = {},
): Promise<TokenManageResult> {
  const maxFee = validateTransferFee(fee);
  const mintKey = toPublicKey(mint);
  await requireToken2022(conn, mintKey);

  return signAndSendTokenTx(
    conn,
    from,
    [
      createSetTransferFeeInstruction(
        mintKey,
        from.publicKey, // transfer fee config authority
        [],
        fee.transferFeeBasisPoints,
        maxFee,
      ),
    ],
    opts,
  );
}

/** Freeze the ATA owned by `accountOwner` (requires freeze authority). */
export async function freezeTokenAccount(
  conn: ClusterConnection,
  from: Keypair,
  mint: string | PublicKey,
  accountOwner: string | PublicKey,
  opts: SendTokenOptions = {},
): Promise<TokenManageResult> {
  const mintKey = toPublicKey(mint);
  const program = await getMintProgram(conn, mintKey);
  const ata = await getAssociatedTokenAddress(mintKey, toPublicKey(accountOwner), true, program.programId);

  return signAndSendTokenTx(
    conn,
    from,
    [
      createFreezeAccountInstruction(
        ata,
        mintKey,
        from.publicKey, // freeze authority
        [],
        program.programId,
      ),
    ],
    opts,
  );
}

/** Thaw a previously frozen ATA (requires freeze authority). */
export async function thawTokenAccount(
  conn: ClusterConnection,
  from: Keypair,
  mint: string | PublicKey,
  accountOwner: string | PublicKey,
  opts: SendTokenOptions = {},
): Promise<TokenManageResult> {
  const mintKey = toPublicKey(mint);
  const program = await getMintProgram(conn, mintKey);
  const ata = await getAssociatedTokenAddress(mintKey, toPublicKey(accountOwner), true, program.programId);

  return signAndSendTokenTx(
    conn,
    from,
    [
      createThawAccountInstruction(
        ata,
        mintKey,
        from.publicKey, // freeze authority
        [],
        program.programId,
      ),
    ],
    opts,
  );
}

/** Rotate (or revoke) the mint authority. Revoke requires confirmRevoke. */
export async function setMintAuthority(
  conn: ClusterConnection,
  from: Keypair,
  mint: string | PublicKey,
  newAuthority: string | PublicKey | null,
  opts: SendTokenOptions & { confirmRevoke?: boolean } = {},
): Promise<TokenManageResult> {
  return setAuthority(conn, from, mint, newAuthority, AuthorityType.MintTokens, opts);
}

/** Rotate (or revoke) the freeze authority. Revoke requires confirmRevoke. */
export async function setFreezeAuthority(
  conn: ClusterConnection,
  from: Keypair,
  mint: string | PublicKey,
  newAuthority: string | PublicKey | null,
  opts: SendTokenOptions & { confirmRevoke?: boolean } = {},
): Promise<TokenManageResult> {
  return setAuthority(conn, from, mint, newAuthority, AuthorityType.FreezeAccount, opts);
}

async function setAuthority(
  conn: ClusterConnection,
  from: Keypair,
  mint: string | PublicKey,
  newAuthority: string | PublicKey | null,
  authorityType: AuthorityType,
  opts: SendTokenOptions & { confirmRevoke?: boolean },
  label?: string,
): Promise<TokenManageResult> {
  const mintKey = toPublicKey(mint);
  const program = await getMintProgram(conn, mintKey);
  const newKey = newAuthority === null ? null : toPublicKey(newAuthority);

  if (newKey === null && opts.confirmRevoke !== true) {
    throw new SolwalletError(
      `Refusing to revoke ${label ?? (authorityType === AuthorityType.MintTokens ? "mint" : "freeze")} authority on ${mintKey.toBase58()}: revocation is IRREVERSIBLE.`,
      {
        code: "REVOCATION_UNCONFIRMED",
        hint: "Pass { confirmRevoke: true } to permanently renounce this authority. Nobody will ever be able to mint more tokens (or freeze accounts) afterwards.",
      },
    );
  }

  return signAndSendTokenTx(
    conn,
    from,
    [
      createSetAuthorityInstruction(
        mintKey,
        from.publicKey, // current authority
        authorityType,
        newKey,
        [],
        program.programId,
      ),
    ],
    opts,
  );
}

/**
 * Update one on-chain metadata field of a Token-2022 mint. `field` is
 * "name" | "symbol" | "uri" or any custom key (stored as additional
 * metadata). Requires the metadata update authority in `from`.
 */
export async function updateTokenMetadata(
  conn: ClusterConnection,
  from: Keypair,
  mint: string | PublicKey,
  update: { field: string; value: string },
  opts: SendTokenOptions = {},
): Promise<TokenManageResult> {
  const mintKey = toPublicKey(mint);
  await requireToken2022(conn, mintKey);

  if (update.value.length > 200) {
    throw new SolwalletError(
      `Metadata value too long (${update.value.length} chars, max 200).`,
      {
        code: "METADATA_INVALID",
        hint: "Keep on-chain metadata short; put long content off chain and link it via the uri field.",
      },
    );
  }
  const field = (METADATA_FIELDS as Record<string, Field | undefined>)[update.field.toLowerCase()] ?? update.field;

  return signAndSendTokenTx(
    conn,
    from,
    [
      createUpdateFieldInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mintKey, // Token-2022 metadata lives on the mint itself
        updateAuthority: from.publicKey,
        field,
        value: update.value,
      }),
    ],
    opts,
  );
}

// ---------------------------------------------------------------------------
// PRD T-F: ScaledUiAmount multiplier updates
// ---------------------------------------------------------------------------

export interface UpdateScaledUiMultiplierParams {
  mint: string | PublicKey;
  /** The ScaledUiAmount authority (signs). */
  authority: Keypair;
  /** New display multiplier, must be > 0. */
  multiplier: number;
  /**
   * Unix timestamp (seconds) from which the new multiplier applies.
   * Defaults to 0 = effective immediately.
   */
  effectiveTimestamp?: bigint | number;
}

/**
 * Update a Token-2022 mint's ScaledUiAmount multiplier. Display-only: raw
 * balances never change; UIs show raw × multiplier.
 */
export async function updateScaledUiMultiplier(
  conn: ClusterConnection,
  params: UpdateScaledUiMultiplierParams,
  opts: SendTokenOptions = {},
): Promise<TokenManageResult> {
  if (!(Number.isFinite(params.multiplier) && params.multiplier > 0)) {
    throw new SolwalletError(
      `multiplier must be a finite number > 0, got ${params.multiplier}.`,
      {
        code: "SCALED_UI_MULTIPLIER_INVALID",
        hint: "The multiplier only changes how UIs display balances (raw × multiplier); 1 means no scaling.",
      },
    );
  }
  const mintKey = toPublicKey(params.mint);
  await requireToken2022(conn, mintKey);
  return signAndSendTokenTx(
    conn,
    params.authority,
    [
      createUpdateMultiplierDataInstruction(
        mintKey,
        params.authority.publicKey,
        params.multiplier,
        BigInt(params.effectiveTimestamp ?? 0),
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    opts,
  );
}

// ---------------------------------------------------------------------------
// PRD T-G: account-level extension operations
// ---------------------------------------------------------------------------

export interface MemoTransferParams {
  /** Owner of the token account (signs; also pays for any reallocation). */
  owner: Keypair;
  mint: string | PublicKey;
}

/** Account-level TLV extension types present on a Token-2022 token account. */
function accountExtensionTypes(data: Buffer | Uint8Array | undefined): ExtensionType[] {
  if (!data || data.length <= ACCOUNT_SIZE + 1) return [];
  try {
    return getExtensionTypes(Buffer.from(data.subarray(ACCOUNT_SIZE + 1)));
  } catch {
    return [];
  }
}

async function toggleMemoTransfer(
  conn: ClusterConnection,
  params: MemoTransferParams,
  enable: boolean,
  opts: SendTokenOptions,
): Promise<TokenManageResult> {
  const mintKey = toPublicKey(params.mint);
  await requireToken2022(conn, mintKey);
  const owner = params.owner.publicKey;
  const ata = await getAssociatedTokenAddress(mintKey, owner, true, TOKEN_2022_PROGRAM_ID);
  const info = await conn.connection.getAccountInfo(ata);

  const instructions = [];
  if (!info) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mintKey, TOKEN_2022_PROGRAM_ID),
    );
  }
  // MemoTransfer is an account extension that needs TLV space: a plain ATA
  // (or one just created above) lacks it, so reallocate first (owner pays).
  const hasExtension = info ? accountExtensionTypes(info.data).includes(ExtensionType.MemoTransfer) : false;
  if (!hasExtension) {
    instructions.push(
      createReallocateInstruction(ata, owner, [ExtensionType.MemoTransfer], owner, [], TOKEN_2022_PROGRAM_ID),
    );
  }
  instructions.push(
    enable
      ? createEnableRequiredMemoTransfersInstruction(ata, owner, [], TOKEN_2022_PROGRAM_ID)
      : createDisableRequiredMemoTransfersInstruction(ata, owner, [], TOKEN_2022_PROGRAM_ID),
  );
  return signAndSendTokenTx(conn, params.owner, instructions, opts);
}

/**
 * Require incoming transfers to the owner's ATA of `mint` to carry a memo
 * instruction. Reallocates the ATA (and creates it) when needed.
 */
export function enableMemoTransfer(
  conn: ClusterConnection,
  params: MemoTransferParams,
  opts: SendTokenOptions = {},
): Promise<TokenManageResult> {
  return toggleMemoTransfer(conn, params, true, opts);
}

/** Stop requiring memos on incoming transfers to the owner's ATA of `mint`. */
export function disableMemoTransfer(
  conn: ClusterConnection,
  params: MemoTransferParams,
  opts: SendTokenOptions = {},
): Promise<TokenManageResult> {
  return toggleMemoTransfer(conn, params, false, opts);
}

export interface WithdrawWithheldFromAccountsParams {
  mint: string | PublicKey;
  /** Withdraw-withheld authority of the mint (signs). */
  authority: Keypair;
  /** Token accounts (not owners) holding withheld fees. */
  sources: Array<string | PublicKey>;
  /** Destination token account; defaults to the authority's ATA (created if missing). */
  destination?: string | PublicKey;
}

async function resolveWithheldDestination(
  conn: ClusterConnection,
  mint: PublicKey,
  authority: PublicKey,
  destination: string | PublicKey | undefined,
): Promise<{ destination: PublicKey; createInstruction: ReturnType<typeof createAssociatedTokenAccountIdempotentInstruction> | null }> {
  if (destination) return { destination: toPublicKey(destination), createInstruction: null };
  const ata = await prepareAta(conn, authority, mint, authority, TOKEN_2022_PROGRAM_ID);
  return { destination: ata.ata, createInstruction: ata.createInstruction };
}

/** Withdraw withheld transfer fees from token accounts into `destination`. */
export async function withdrawWithheldFromAccounts(
  conn: ClusterConnection,
  params: WithdrawWithheldFromAccountsParams,
  opts: SendTokenOptions = {},
): Promise<TokenManageResult> {
  const mintKey = toPublicKey(params.mint);
  if (params.sources.length === 0) {
    throw new SolwalletError("withdrawWithheldFromAccounts: sources must contain at least one token account.", {
      code: "SOURCES_EMPTY",
      hint: "Pass the token account addresses (ATAs) that accumulated withheld fees; inspectTokenAccount shows TransferFeeAmount.withheldAmount.",
    });
  }
  await requireToken2022(conn, mintKey);
  const dest = await resolveWithheldDestination(conn, mintKey, params.authority.publicKey, params.destination);
  const instructions = [];
  if (dest.createInstruction) instructions.push(dest.createInstruction);
  instructions.push(
    createWithdrawWithheldTokensFromAccountsInstruction(
      mintKey,
      dest.destination,
      params.authority.publicKey,
      [],
      params.sources.map(toPublicKey),
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  return signAndSendTokenTx(conn, params.authority, instructions, opts);
}

export interface HarvestWithheldToMintParams {
  /** Fee payer for the transaction — harvesting is permissionless. */
  payer: Keypair;
  mint: string | PublicKey;
  /** Token accounts whose withheld fees move to the mint. */
  sources: Array<string | PublicKey>;
}

/** Move withheld fees from token accounts to the mint (permissionless). */
export async function harvestWithheldToMint(
  conn: ClusterConnection,
  params: HarvestWithheldToMintParams,
  opts: SendTokenOptions = {},
): Promise<TokenManageResult> {
  const mintKey = toPublicKey(params.mint);
  if (params.sources.length === 0) {
    throw new SolwalletError("harvestWithheldToMint: sources must contain at least one token account.", {
      code: "SOURCES_EMPTY",
      hint: "Pass the token account addresses (ATAs) that accumulated withheld fees.",
    });
  }
  await requireToken2022(conn, mintKey);
  return signAndSendTokenTx(
    conn,
    params.payer,
    [createHarvestWithheldTokensToMintInstruction(mintKey, params.sources.map(toPublicKey), TOKEN_2022_PROGRAM_ID)],
    opts,
  );
}

export interface WithdrawWithheldFromMintParams {
  mint: string | PublicKey;
  /** Withdraw-withheld authority of the mint (signs). */
  authority: Keypair;
  /** Destination token account; defaults to the authority's ATA (created if missing). */
  destination?: string | PublicKey;
}

/** Withdraw fees previously harvested to the mint into `destination`. */
export async function withdrawWithheldFromMint(
  conn: ClusterConnection,
  params: WithdrawWithheldFromMintParams,
  opts: SendTokenOptions = {},
): Promise<TokenManageResult> {
  const mintKey = toPublicKey(params.mint);
  await requireToken2022(conn, mintKey);
  const dest = await resolveWithheldDestination(conn, mintKey, params.authority.publicKey, params.destination);
  const instructions = [];
  if (dest.createInstruction) instructions.push(dest.createInstruction);
  instructions.push(
    createWithdrawWithheldTokensFromMintInstruction(
      mintKey,
      dest.destination,
      params.authority.publicKey,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  return signAndSendTokenTx(conn, params.authority, instructions, opts);
}

export interface UpdateTransferHookProgramParams {
  mint: string | PublicKey;
  /** Transfer-hook authority of the mint (signs). */
  authority: Keypair;
  /** New hook program, or null to clear the hook (stored as the zero pubkey). */
  programId: string | PublicKey | null;
}

/** Point a Token-2022 mint's TransferHook extension at a new program (or none). */
export async function updateTransferHookProgram(
  conn: ClusterConnection,
  params: UpdateTransferHookProgramParams,
  opts: SendTokenOptions = {},
): Promise<TokenManageResult> {
  const mintKey = toPublicKey(params.mint);
  await requireToken2022(conn, mintKey);
  return signAndSendTokenTx(
    conn,
    params.authority,
    [
      createUpdateTransferHookInstruction(
        mintKey,
        params.authority.publicKey,
        params.programId === null ? PublicKey.default : toPublicKey(params.programId),
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    opts,
  );
}

// ---------------------------------------------------------------------------
// Extension runtime management: pausable, mint close, interest rate,
// default account state, extension authorities, withheld-fee discovery
// ---------------------------------------------------------------------------

export interface MintAuthorityParams {
  mint: string | PublicKey;
  /** The relevant extension authority (signs). */
  authority: Keypair;
}

/** Pause a Pausable mint: all transfers, mints and burns fail until resumed. */
export async function pauseMint(
  conn: ClusterConnection,
  params: MintAuthorityParams,
  opts: SendTokenOptions = {},
): Promise<TokenManageResult> {
  const mintKey = toPublicKey(params.mint);
  await requireToken2022(conn, mintKey);
  return signAndSendTokenTx(
    conn,
    params.authority,
    [createPauseInstruction(mintKey, params.authority.publicKey, [], TOKEN_2022_PROGRAM_ID)],
    opts,
  );
}

/** Resume a paused Pausable mint. */
export async function resumeMint(
  conn: ClusterConnection,
  params: MintAuthorityParams,
  opts: SendTokenOptions = {},
): Promise<TokenManageResult> {
  const mintKey = toPublicKey(params.mint);
  await requireToken2022(conn, mintKey);
  return signAndSendTokenTx(
    conn,
    params.authority,
    [createResumeInstruction(mintKey, params.authority.publicKey, [], TOKEN_2022_PROGRAM_ID)],
    opts,
  );
}

export interface CloseMintParams extends MintAuthorityParams {
  /** Receives the mint's rent lamports. Defaults to the authority. */
  destination?: string | PublicKey;
  /** Closing is irreversible; must be true. */
  confirmClose?: boolean;
}

/**
 * Close a Token-2022 mint with the MintCloseAuthority extension (supply must
 * be 0). Rent goes to `destination`. IRREVERSIBLE: requires confirmClose.
 */
export async function closeMint(
  conn: ClusterConnection,
  params: CloseMintParams,
  opts: SendTokenOptions = {},
): Promise<TokenManageResult> {
  const mintKey = toPublicKey(params.mint);
  if (params.confirmClose !== true) {
    throw new SolwalletError(`Refusing to close mint ${mintKey.toBase58()}: closing is IRREVERSIBLE.`, {
      code: "CLOSE_UNCONFIRMED",
      hint: "Pass { confirmClose: true } to permanently close the mint account.",
    });
  }
  await requireToken2022(conn, mintKey);
  const mint = await getMint(conn.connection, mintKey, "confirmed", TOKEN_2022_PROGRAM_ID);
  if (mint.supply > 0n) {
    throw new SolwalletError(`Mint ${mintKey.toBase58()} still has supply ${mint.supply}; only an empty mint can be closed.`, {
      code: "MINT_SUPPLY_NONZERO",
      hint: "Burn all outstanding tokens first (supply must be 0).",
    });
  }
  const destination = params.destination ? toPublicKey(params.destination) : params.authority.publicKey;
  return signAndSendTokenTx(
    conn,
    params.authority,
    [createCloseAccountInstruction(mintKey, destination, params.authority.publicKey, [], TOKEN_2022_PROGRAM_ID)],
    opts,
  );
}

export interface UpdateInterestRateParams extends MintAuthorityParams {
  /** New rate in basis points per year (i16). */
  rate: number;
}

/** Update an InterestBearing mint's rate (requires the rate authority). */
export async function updateInterestRate(
  conn: ClusterConnection,
  params: UpdateInterestRateParams,
  opts: SendTokenOptions = {},
): Promise<TokenManageResult> {
  if (!Number.isInteger(params.rate) || params.rate < -32_768 || params.rate > 32_767) {
    throw new SolwalletError(`interest rate must be an integer between -32768 and 32767, got ${params.rate}.`, {
      code: "INTEREST_RATE_INVALID",
      hint: "The rate is basis points per year stored as a signed i16.",
    });
  }
  const mintKey = toPublicKey(params.mint);
  await requireToken2022(conn, mintKey);
  return signAndSendTokenTx(
    conn,
    params.authority,
    [
      createUpdateRateInterestBearingMintInstruction(
        mintKey,
        params.authority.publicKey,
        params.rate,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    opts,
  );
}

export interface UpdateDefaultAccountStateParams {
  mint: string | PublicKey;
  /** The mint's FREEZE authority (signs). */
  freezeAuthority: Keypair;
  state: "initialized" | "frozen";
}

/** Change the state new token accounts of this mint start in. */
export async function updateDefaultAccountState(
  conn: ClusterConnection,
  params: UpdateDefaultAccountStateParams,
  opts: SendTokenOptions = {},
): Promise<TokenManageResult> {
  const mintKey = toPublicKey(params.mint);
  await requireToken2022(conn, mintKey);
  return signAndSendTokenTx(
    conn,
    params.freezeAuthority,
    [
      createUpdateDefaultAccountStateInstruction(
        mintKey,
        params.state === "frozen" ? AccountState.Frozen : AccountState.Initialized,
        params.freezeAuthority.publicKey,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    opts,
  );
}

/** Token-2022 extension authorities that can be rotated with SetAuthority. */
export const EXTENSION_AUTHORITY_TYPES = {
  transferFeeConfig: AuthorityType.TransferFeeConfig,
  withheldWithdraw: AuthorityType.WithheldWithdraw,
  closeMint: AuthorityType.CloseMint,
  interestRate: AuthorityType.InterestRate,
  permanentDelegate: AuthorityType.PermanentDelegate,
  transferHookProgramId: AuthorityType.TransferHookProgramId,
  metadataPointer: AuthorityType.MetadataPointer,
  scaledUiAmount: AuthorityType.ScaledUiAmountConfig,
  pausable: AuthorityType.PausableConfig,
} as const;

export type ExtensionAuthorityKind = keyof typeof EXTENSION_AUTHORITY_TYPES;

/**
 * Rotate (or revoke with confirmRevoke) one Token-2022 extension authority.
 * `from` must be the current holder of that authority.
 */
export async function setExtensionAuthority(
  conn: ClusterConnection,
  from: Keypair,
  mint: string | PublicKey,
  kind: ExtensionAuthorityKind,
  newAuthority: string | PublicKey | null,
  opts: SendTokenOptions & { confirmRevoke?: boolean } = {},
): Promise<TokenManageResult> {
  const authorityType = EXTENSION_AUTHORITY_TYPES[kind];
  if (authorityType === undefined) {
    throw new SolwalletError(`Unknown extension authority kind "${kind}".`, {
      code: "AUTHORITY_KIND_INVALID",
      hint: `One of: ${Object.keys(EXTENSION_AUTHORITY_TYPES).join(", ")}.`,
    });
  }
  const mintKey = toPublicKey(mint);
  await requireToken2022(conn, mintKey);
  return setAuthority(conn, from, mintKey, newAuthority, authorityType, opts, kind);
}

export interface WithheldAccount {
  /** Token account address. */
  address: string;
  owner: string;
  /** Withheld transfer fees in this account, raw base units. */
  withheldAmount: string;
}

/**
 * Find token accounts of a Token-2022 mint holding withheld transfer fees
 * (getProgramAccounts filtered by mint). Some public RPCs disable or rate
 * limit getProgramAccounts on mainnet.
 */
export async function findWithheldAccounts(
  conn: ClusterConnection,
  mint: string | PublicKey,
): Promise<WithheldAccount[]> {
  const mintKey = toPublicKey(mint);
  await requireToken2022(conn, mintKey);
  const accounts = await conn.connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: mintKey.toBase58() } }],
  });
  const out: WithheldAccount[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      const acc = unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID);
      const fee = getTransferFeeAmount(acc);
      if (fee && fee.withheldAmount > 0n) {
        out.push({ address: pubkey.toBase58(), owner: acc.owner.toBase58(), withheldAmount: fee.withheldAmount.toString() });
      }
    } catch {
      // not a token account (e.g. the mint itself matched the memcmp) — skip
    }
  }
  out.sort((a, b) => (BigInt(b.withheldAmount) > BigInt(a.withheldAmount) ? 1 : -1));
  return out;
}
