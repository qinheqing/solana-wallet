/**
 * Token-2022 runtime management (task #9): mintTo/burn (both programs),
 * transfer-fee updates, freeze/thaw, authority rotation and on-chain
 * metadata updates. Every mutating call goes through signAndSendTokenTx
 * (dryRun-aware, mainnet-guarded) and returns a uniform result shape.
 */
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnInstruction,
  createFreezeAccountInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  createSetTransferFeeInstruction,
  createThawAccountInstruction,
  getAssociatedTokenAddress,
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
 * missing). Works for both SPL and Token-2022 mints.
 */
export async function mintTokens(
  conn: ClusterConnection,
  from: Keypair,
  mint: string | PublicKey,
  destinationOwner: string | PublicKey,
  amount: bigint,
  opts: SendTokenOptions & { decimals?: number } = {},
): Promise<TokenManageResult> {
  assertPositiveAmount("mintTokens", amount);
  const mintKey = toPublicKey(mint);
  const ownerKey = toPublicKey(destinationOwner);
  const program = await getMintProgram(conn, mintKey);

  const dest = await prepareAta(conn, from.publicKey, mintKey, ownerKey, program.programId);
  const instructions = [];
  if (dest.createInstruction) instructions.push(dest.createInstruction);
  instructions.push(
    createMintToInstruction(
      mintKey,
      dest.ata,
      from.publicKey, // mint authority
      amount,
      [],
      program.programId,
    ),
  );
  return signAndSendTokenTx(conn, from, instructions, opts);
}

/** Burn `amount` base units from the wallet's own ATA of `mint`. */
export async function burnTokens(
  conn: ClusterConnection,
  from: Keypair,
  mint: string | PublicKey,
  amount: bigint,
  opts: SendTokenOptions & { decimals?: number } = {},
): Promise<TokenManageResult> {
  assertPositiveAmount("burnTokens", amount);
  const mintKey = toPublicKey(mint);
  const program = await getMintProgram(conn, mintKey);
  const ata = await getAssociatedTokenAddress(mintKey, from.publicKey, true, program.programId);

  return signAndSendTokenTx(
    conn,
    from,
    [
      createBurnInstruction(
        ata,
        mintKey,
        from.publicKey, // owner
        amount,
        [],
        program.programId,
      ),
    ],
    opts,
  );
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
): Promise<TokenManageResult> {
  const mintKey = toPublicKey(mint);
  const program = await getMintProgram(conn, mintKey);
  const newKey = newAuthority === null ? null : toPublicKey(newAuthority);

  if (newKey === null && opts.confirmRevoke !== true) {
    throw new SolwalletError(
      `Refusing to revoke ${authorityType === AuthorityType.MintTokens ? "mint" : "freeze"} authority on ${mintKey.toBase58()}: revocation is IRREVERSIBLE.`,
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
