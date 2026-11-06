/**
 * Transfer instruction builders — SOL (System), SPL Token and Token-2022
 * (transferChecked with decimals validation), with optional idempotent ATA
 * creation for the destination.
 */
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";

import type { ClusterConnection } from "../connection/connection.js";
import { SolwalletError } from "../connection/errors.js";
import { getMintProgram, type MintProgram } from "./program.js";

export interface BuildTransferOptions {
  /** Wallet paying fees and owning the source funds. */
  payer: PublicKey;
  /** SOL recipient (no mint) or token-receiving owner (with mint). */
  destination: PublicKey;
  /** Omit for native SOL transfer. */
  mint?: PublicKey;
  /** Base units — lamports for SOL, token base units otherwise. */
  amount: bigint;
  /** Required for token transfers (transferChecked validates it on chain). */
  decimals?: number;
  /** Auto-create the destination ATA when missing. Default: true. */
  allowAtaCreation?: boolean;
}

export interface BuiltTransfer {
  program: MintProgram | null; // null = native SOL
  instructions: TransactionInstruction[];
  /** Whether a destination-ATA creation instruction was prepended. */
  destinationAtaCreated: boolean;
  destinationAta: PublicKey | null;
}

/**
 * Resolve the destination token account, creating it idempotently when
 * allowed. Idempotent means: if the ATA already exists the instruction is a
 * no-op on chain — no check-then-create race.
 */
async function prepareDestinationAta(
  conn: ClusterConnection,
  opts: Required<Pick<BuildTransferOptions, "payer" | "destination" | "allowAtaCreation">> & {
    mint: PublicKey;
    programId: PublicKey;
  },
): Promise<{ ata: PublicKey; created: boolean }> {
  const ata = await getAssociatedTokenAddress(
    opts.mint,
    opts.destination,
    true,
    opts.programId,
  );
  const info = await conn.connection.getAccountInfo(ata);
  if (info) return { ata, created: false };

  if (!opts.allowAtaCreation) {
    throw new SolwalletError(
      `Destination token account ${ata.toBase58()} does not exist.`,
      {
        code: "ATA_MISSING",
        hint: "Pass allowAtaCreation: true to create it automatically (the payer covers ~0.002 SOL rent), or send to an address that already holds this token.",
      },
    );
  }
  return {
    ata,
    created: true,
  };
}

/** Build the full instruction list for one transfer. */
export async function buildTransferInstructions(
  conn: ClusterConnection,
  opts: BuildTransferOptions,
): Promise<BuiltTransfer> {
  const allowAtaCreation = opts.allowAtaCreation ?? true;

  // Native SOL — no mint, plain System transfer.
  if (!opts.mint) {
    if (opts.decimals !== undefined) {
      throw new SolwalletError("decimals is only valid for token transfers.", {
        code: "DECIMALS_UNEXPECTED",
      });
    }
    if (opts.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new SolwalletError("SOL amount exceeds safe integer lamports.", {
        code: "AMOUNT_OVERFLOW",
      });
    }
    return {
      program: null,
      destinationAtaCreated: false,
      destinationAta: null,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: opts.payer,
          toPubkey: opts.destination,
          lamports: Number(opts.amount),
        }),
      ],
    };
  }

  // Token transfer (SPL or Token-2022) via the mint's owning program.
  const program = await getMintProgram(conn, opts.mint);
  if (opts.decimals === undefined) {
    throw new SolwalletError("Token transfers require `decimals` (transferChecked).", {
      code: "DECIMALS_REQUIRED",
      hint: "Fetch decimals once with getMintDecimals() and cache per mint.",
    });
  }

  const sourceAta = await getAssociatedTokenAddress(
    opts.mint,
    opts.payer,
    true,
    program.programId,
  );
  const sourceInfo = await conn.connection.getAccountInfo(sourceAta);
  if (!sourceInfo) {
    throw new SolwalletError(
      `Payer holds no token account for mint ${opts.mint.toBase58()}.`,
      {
        code: "SOURCE_ATA_MISSING",
        hint: "The wallet never received this token. Mint or receive it first, then transfer.",
      },
    );
  }

  const dest = await prepareDestinationAta(conn, {
    payer: opts.payer,
    destination: opts.destination,
    mint: opts.mint,
    programId: program.programId,
    allowAtaCreation,
  });

  const instructions: TransactionInstruction[] = [];
  if (dest.created) {
    // Idempotent: a no-op when the account already exists (race-safe).
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        opts.payer,
        dest.ata,
        opts.destination,
        opts.mint,
        program.programId === TOKEN_2022_PROGRAM_ID ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
      ),
    );
  }
  instructions.push(
    createTransferCheckedInstruction(
      sourceAta,
      opts.mint,
      dest.ata,
      opts.payer,
      opts.amount,
      opts.decimals,
      [],
      program.programId,
    ),
  );

  return {
    program,
    instructions,
    destinationAtaCreated: dest.created,
    destinationAta: dest.ata,
  };
}

export const TOKEN_PROGRAM_IDS = {
  spl: TOKEN_PROGRAM_ID,
  token2022: TOKEN_2022_PROGRAM_ID,
} as const;
