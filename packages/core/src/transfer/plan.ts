/**
 * TransactionPlan (PRD T-B): a machine-readable description of a compiled
 * but unsigned transaction — every instruction with its program, account
 * metas and raw data, plus the serialized v0 message, wire-size estimate,
 * required signers and the blockhash it was compiled against.
 *
 * Pure functions only: nothing here touches the network.
 */
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type MessageV0,
  type TransactionInstruction,
} from "@solana/web3.js";

/** Stable labels attached to instructions produced by buildTransferInstructions. */
export type InstructionLabel =
  | "setComputeUnitLimit"
  | "setComputeUnitPrice"
  | "createAssociatedTokenAccountIdempotent"
  | "createAssociatedTokenAccount"
  | "memo"
  | "transferChecked"
  | "transfer"
  | "transferCheckedWithFee"
  | "systemTransfer";

export interface PlannedAccount {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface PlannedInstruction {
  /** Position inside the transaction (0-based). */
  index: number;
  /** Human/AI-readable label; "unknown" when the caller supplied none. */
  label: string;
  programId: string;
  accounts: PlannedAccount[];
  /** Raw instruction data, hex encoded (no 0x prefix). */
  dataHex: string;
}

export interface TransactionPlan {
  instructions: PlannedInstruction[];
  /** `message.serialize()` of the compiled v0 message, hex encoded. */
  messageHex: string;
  /** Full wire size incl. the signature section (compact count + 64 bytes per signer). */
  estimatedBytes: number;
  /** Every account the message requires a signature from, fee payer first. */
  signers: string[];
  blockhash: string;
  feePayer: string;
}

/** Describe instructions; `labels[i]` is attached to `ixs[i]` when provided. */
export function describeInstructions(
  ixs: readonly TransactionInstruction[],
  labels: readonly string[] = [],
): PlannedInstruction[] {
  return ixs.map((ix, index) => ({
    index,
    label: labels[index] ?? "unknown",
    programId: ix.programId.toBase58(),
    accounts: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    dataHex: Buffer.from(ix.data).toString("hex"),
  }));
}

/**
 * Build a plan from an already-compiled v0 message. `ixs`/`labels` are the
 * instructions the message was compiled from (needed because a compiled
 * message only holds account indices, not labels).
 */
export function planFromMessage(
  message: MessageV0,
  ixs: readonly TransactionInstruction[],
  labels: readonly string[] = [],
): TransactionPlan {
  const numSigners = message.header.numRequiredSignatures;
  return {
    instructions: describeInstructions(ixs, labels),
    messageHex: Buffer.from(message.serialize()).toString("hex"),
    // serialize() of an unsigned VersionedTransaction = compact-u16 count
    // + 64 zero bytes per required signer + message: the exact wire size.
    estimatedBytes: new VersionedTransaction(message).serialize().length,
    signers: message.staticAccountKeys.slice(0, numSigners).map((k) => k.toBase58()),
    blockhash: message.recentBlockhash,
    feePayer: message.staticAccountKeys[0]!.toBase58(),
  };
}

/** Compile `ixs` into a v0 message for `payer` and describe it. */
export function planFromInstructions(
  payer: PublicKey,
  blockhash: string,
  ixs: readonly TransactionInstruction[],
  labels: readonly string[] = [],
): { message: MessageV0; plan: TransactionPlan } {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [...ixs],
  }).compileToV0Message();
  return { message, plan: planFromMessage(message, ixs, labels) };
}
