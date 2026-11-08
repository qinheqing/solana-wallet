/**
 * Raw transaction channel (PRD T-D): sign / simulate / send a serialized
 * transaction supplied by an external party (or produced by us for them).
 *
 * Input is a hex string; base64 is accepted too and auto-detected (a valid
 * hex string is always treated as hex — base64 of a real transaction always
 * contains characters outside [0-9a-f]). Every result reports `encoding`.
 *
 * Both wire formats are supported. `VersionedTransaction.deserialize` reads
 * legacy (no version prefix) and v0 messages, so it is tried first; only if
 * that fails do we fall back to the legacy `Transaction.from` parser, which
 * tolerates a few shapes the versioned parser rejects (e.g. a legacy tx
 * serialized with `verifySignatures: false` carrying an odd signature count).
 */
import {
  Keypair,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

import type { ClusterConnection, ConfirmPolicy, SendResult } from "../connection/connection.js";
import { SolwalletError } from "../connection/errors.js";
import { dryRun, type DryRunResult } from "./dryrun.js";

export type RawTxEncoding = "hex" | "base64";
export type RawTxKind = "legacy" | "v0";

export interface DecodedRawTransaction {
  bytes: Uint8Array;
  encoding: RawTxEncoding;
}

/** Decode hex (preferred) or base64 into bytes, reporting which one matched. */
export function decodeRawTransaction(input: string): DecodedRawTransaction {
  const trimmed = input.trim().replace(/^0x/i, "");
  if (trimmed.length === 0) {
    throw new SolwalletError("Transaction payload is empty.", {
      code: "RAW_TX_INVALID",
      hint: "Pass the serialized transaction as a hex (or base64) string.",
    });
  }
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return { bytes: Uint8Array.from(Buffer.from(trimmed, "hex")), encoding: "hex" };
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length % 4 === 0) {
    return { bytes: Uint8Array.from(Buffer.from(trimmed, "base64")), encoding: "base64" };
  }
  throw new SolwalletError("Transaction payload is neither valid hex nor valid base64.", {
    code: "RAW_TX_INVALID",
    hint: "Hex must have even length and only [0-9a-f]; base64 must be padded to a multiple of 4.",
  });
}

export interface ParsedRawTransaction {
  tx: VersionedTransaction;
  kind: RawTxKind;
  encoding: RawTxEncoding;
}

/** Parse a hex/base64 payload into a VersionedTransaction (legacy or v0). */
export function parseRawTransaction(input: string): ParsedRawTransaction {
  const { bytes, encoding } = decodeRawTransaction(input);
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(bytes);
  } catch (versionedError) {
    try {
      // Legacy fallback: re-serialize through the legacy parser into the
      // common wire format the versioned class understands.
      const legacy = Transaction.from(bytes);
      tx = VersionedTransaction.deserialize(
        legacy.serialize({ requireAllSignatures: false, verifySignatures: false }),
      );
    } catch {
      throw new SolwalletError(
        `Could not deserialize transaction: ${describe(versionedError)}`,
        {
          code: "RAW_TX_INVALID",
          hint: "Expected the full serialized transaction (signatures + message), not just the message bytes.",
          cause: versionedError,
        },
      );
    }
  }
  return { tx, kind: tx.version === "legacy" ? "legacy" : "v0", encoding };
}

export interface RawSignature {
  pubkey: string;
  /** 64-byte ed25519 signature, hex; all zeros when not yet signed. */
  signatureHex: string;
}

export interface SignRawResult {
  txHex: string;
  txBase64: string;
  /** Encoding the input was detected as. */
  encoding: RawTxEncoding;
  kind: RawTxKind;
  /** One entry per required signer, in message order (fee payer first). */
  signatures: RawSignature[];
  /** True when every required signature slot is populated. */
  fullySigned: boolean;
  /** Signers from the input that were applied by this call. */
  signedBy: string[];
}

function signatureSlots(tx: VersionedTransaction): RawSignature[] {
  const keys = tx.message.staticAccountKeys;
  return tx.signatures.map((sig, i) => ({
    pubkey: keys[i]!.toBase58(),
    signatureHex: Buffer.from(sig).toString("hex"),
  }));
}

const ZERO_SIG_HEX = "0".repeat(128);

/**
 * Partially sign a serialized transaction. Signers that the message does
 * not require are rejected (code SIGNER_NOT_REQUIRED) rather than silently
 * ignored, so a wrong wallet name is caught immediately.
 */
export function signTransactionHex(txInput: string, signers: Keypair[]): SignRawResult {
  const { tx, kind, encoding } = parseRawTransaction(txInput);
  const required = tx.message.staticAccountKeys
    .slice(0, tx.message.header.numRequiredSignatures)
    .map((k) => k.toBase58());
  const notRequired = signers
    .map((k) => k.publicKey.toBase58())
    .filter((pk) => !required.includes(pk));
  if (notRequired.length > 0) {
    throw new SolwalletError(
      `Transaction does not require a signature from ${notRequired.join(", ")}.`,
      {
        code: "SIGNER_NOT_REQUIRED",
        hint: `Required signers: ${required.join(", ")}. Pass only wallets among them.`,
      },
    );
  }
  if (signers.length > 0) tx.sign(signers);
  const signatures = signatureSlots(tx);
  const serialized = Buffer.from(tx.serialize());
  return {
    txHex: serialized.toString("hex"),
    txBase64: serialized.toString("base64"),
    encoding,
    kind,
    signatures,
    fullySigned: signatures.every((s) => s.signatureHex !== ZERO_SIG_HEX),
    signedBy: signers.map((k) => k.publicKey.toBase58()),
  };
}

export interface SimulateRawResult extends DryRunResult {
  encoding: RawTxEncoding;
  kind: RawTxKind;
}

/** Simulate a serialized transaction (signatures are not verified). */
export async function simulateRaw(
  conn: ClusterConnection,
  txInput: string,
): Promise<SimulateRawResult> {
  const { tx, kind, encoding } = parseRawTransaction(txInput);
  const result = await dryRun(conn, tx);
  return { ...result, encoding, kind };
}

export interface SendRawOptions {
  allowMainnet?: boolean;
  policy?: Partial<ConfirmPolicy>;
}

export interface SendRawResult extends SendResult {
  encoding: RawTxEncoding;
  kind: RawTxKind;
}

/**
 * Send a fully-signed serialized transaction through sendWithRetry (the
 * mainnet guard applies). Refuses up front when a signature slot is empty.
 */
export async function sendRaw(
  conn: ClusterConnection,
  txInput: string,
  options: SendRawOptions = {},
): Promise<SendRawResult> {
  const { tx, kind, encoding } = parseRawTransaction(txInput);
  const missing = signatureSlots(tx).filter((s) => s.signatureHex === ZERO_SIG_HEX);
  if (missing.length > 0) {
    throw new SolwalletError(
      `Transaction is not fully signed; missing signature(s) from ${missing.map((m) => m.pubkey).join(", ")}.`,
      {
        code: "TX_NOT_FULLY_SIGNED",
        hint: "Call signTransactionHex / sign_transaction with the remaining signers first.",
      },
    );
  }
  const sent = await conn.sendWithRetry(tx, {
    allowMainnet: options.allowMainnet,
    policy: options.policy,
  });
  return { ...sent, encoding, kind };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
