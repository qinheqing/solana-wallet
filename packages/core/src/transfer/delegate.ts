/**
 * Delegate management (PRD T-H): `approveDelegate` / `revokeDelegate` on the
 * owner's associated token account, for SPL Token and Token-2022 alike.
 *
 * A delegate can then move up to `amount` base units out of the owner's ATA
 * via `transfer()` with `{ from: delegateKeypair, sourceOwner: owner,
 * authority: delegate }`. Results follow the `transfer()` convention: send
 * failures come back in-band as `error` (parsed), never thrown.
 */
import {
  createApproveCheckedInstruction,
  createRevokeInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import type { ClusterConnection, ConfirmPolicy } from "../connection/connection.js";
import { SolwalletError, TransactionSendError } from "../connection/errors.js";
import { parseTransactionError, type ParsedProgramError } from "../utils/parse-error.js";
import { getMintProgram, type TokenProgramKind } from "./program.js";

export interface DelegateSendOptions {
  /** Explicit mainnet confirmation, forwarded to sendWithRetry. */
  allowMainnet?: boolean;
  /** Confirm/retry policy override forwarded to sendWithRetry. */
  policy?: Partial<ConfirmPolicy>;
}

export interface ApproveDelegateRequest extends DelegateSendOptions {
  /** Owner of the source ATA; pays fees and signs the approval. */
  owner: Keypair;
  mint: string | PublicKey;
  /** Address allowed to move funds out of the owner's ATA. */
  delegate: string | PublicKey;
  /** Allowance in base units (ApproveChecked validates `decimals` on chain). */
  amount: bigint;
  decimals: number;
}

export interface RevokeDelegateRequest extends DelegateSendOptions {
  owner: Keypair;
  mint: string | PublicKey;
}

export interface DelegateResult {
  /** Empty when sending failed before a signature existed. */
  signature: string;
  slot: number;
  feeLamports: number;
  /** The owner's ATA that was approved / revoked. */
  tokenAccount: string;
  program: TokenProgramKind;
  /** Parsed failure — set instead of throwing, for AI-friendly flows. */
  error?: ParsedProgramError;
}

function toPubkey(v: string | PublicKey): PublicKey {
  return typeof v === "string" ? new PublicKey(v) : v;
}

/** ApproveChecked: data = [13, amount u64 LE, decimals u8]. */
export async function approveDelegate(
  conn: ClusterConnection,
  req: ApproveDelegateRequest,
): Promise<DelegateResult> {
  if (req.amount <= 0n) {
    throw new SolwalletError(`Delegate allowance must be positive, got ${req.amount.toString()}.`, {
      code: "AMOUNT_ZERO_OR_NEGATIVE",
      hint: "Pass the allowance in base units (> 0). Use revokeDelegate to clear an existing delegate.",
    });
  }
  const mint = toPubkey(req.mint);
  const delegate = toPubkey(req.delegate);
  const program = await getMintProgram(conn, mint);
  const ata = getAssociatedTokenAddressSync(mint, req.owner.publicKey, true, program.programId);
  const ix = createApproveCheckedInstruction(
    ata,
    mint,
    delegate,
    req.owner.publicKey,
    req.amount,
    req.decimals,
    [],
    program.programId,
  );
  return sendOne(conn, req.owner, [ix], ata, program.kind, req);
}

/** Revoke: data = [5]; clears delegate + delegatedAmount on the owner's ATA. */
export async function revokeDelegate(
  conn: ClusterConnection,
  req: RevokeDelegateRequest,
): Promise<DelegateResult> {
  const mint = toPubkey(req.mint);
  const program = await getMintProgram(conn, mint);
  const ata = getAssociatedTokenAddressSync(mint, req.owner.publicKey, true, program.programId);
  const ix = createRevokeInstruction(ata, req.owner.publicKey, [], program.programId);
  return sendOne(conn, req.owner, [ix], ata, program.kind, req);
}

async function sendOne(
  conn: ClusterConnection,
  owner: Keypair,
  instructions: import("@solana/web3.js").TransactionInstruction[],
  ata: PublicKey,
  program: TokenProgramKind,
  opts: DelegateSendOptions,
): Promise<DelegateResult> {
  const { blockhash, lastValidBlockHeight } = await conn.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: owner.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([owner]);
  const base = { tokenAccount: ata.toBase58(), program };
  const parseOpts = { programId: program === "token-2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID };
  try {
    const sent = await conn.sendWithRetry(tx, { allowMainnet: opts.allowMainnet, policy: opts.policy, lastValidBlockHeight });
    return { ...base, signature: sent.signature, slot: sent.slot, feeLamports: sent.feeLamports };
  } catch (error) {
    return {
      ...base,
      signature: error instanceof TransactionSendError ? (error.signature ?? "") : "",
      slot: 0,
      feeLamports: 0,
      error: parseTransactionError(error, parseOpts),
    };
  }
}
