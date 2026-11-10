/**
 * Offline decoding of a serialized (usually signed) transaction — the bytes a
 * wallet hands to sendTransaction, which may never have landed on chain.
 *
 * `decodeSignedTransaction` is pure: signatures are verified locally,
 * account flags come from the message header, and instructions for the
 * well-known programs (System, Compute Budget, SPL Token / Token-2022,
 * Associated Token Account, Memo) are decoded. Everything else is shown as
 * raw data.
 *
 * `inspectSignedTransaction` additionally (optionally) asks the RPC whether
 * the signature has landed, whether the blockhash is still valid, and
 * resolves v0 address-lookup-table entries.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  ComputeBudgetInstruction,
  PublicKey,
  SystemInstruction,
  TransactionInstruction,
  VersionedTransaction,
  type VersionedMessage,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenInstruction,
  decodeInstruction as decodeTokenInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";

import type { ClusterConnection } from "../connection/connection.js";
import { SolwalletError } from "../connection/errors.js";

export type SignedTxEncoding = "base58" | "base64" | "hex";

export interface SignedTxSignature {
  signer: string;
  /** base58; null when the slot is empty (all zeros = not signed yet). */
  signature: string | null;
  /** ed25519 check against the message; null when the slot is empty. */
  valid: boolean | null;
}

export interface SignedTxAccount {
  index: number;
  /** null for a v0 lookup entry that has not been resolved. */
  pubkey: string | null;
  signer: boolean;
  writable: boolean;
  source: "static" | "lookup";
  lookup?: { table: string; index: number };
}

export interface SignedTxInstructionAccount {
  /** Index into `accounts`. */
  index: number;
  pubkey: string | null;
  signer: boolean;
  writable: boolean;
}

export type DecodedValue = string | number | boolean | null;

export interface SignedTxInstruction {
  index: number;
  programId: string;
  /** Human name for well-known programs, else null. */
  programName: string | null;
  accounts: SignedTxInstructionAccount[];
  dataHex: string;
  dataLength: number;
  /** Decoded for well-known programs; null when unknown or undecodable. */
  decoded: { type: string; info: Record<string, DecodedValue> } | null;
}

export interface SignedTxChainStatus {
  /** "not-found" means the RPC has no record of the signature (yet). */
  status: "processed" | "confirmed" | "finalized" | "not-found";
  slot: number | null;
  err: unknown;
  /** Whether recentBlockhash can still be used; null when it could not be checked. */
  blockhashValid: boolean | null;
}

export interface SignedTransactionInspection {
  encoding: SignedTxEncoding;
  version: "legacy" | 0;
  sizeBytes: number;
  /** First signature (= transaction id) or null when unsigned. */
  signature: string | null;
  feePayer: string;
  recentBlockhash: string;
  header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
  signatures: SignedTxSignature[];
  fullySigned: boolean;
  /** All signatures present AND valid. */
  allSignaturesValid: boolean;
  accounts: SignedTxAccount[];
  addressTableLookups: Array<{ table: string; writableIndexes: number[]; readonlyIndexes: number[] }>;
  instructions: SignedTxInstruction[];
  /** Filled by inspectSignedTransaction when a connection was used. */
  chain: SignedTxChainStatus | null;
  warnings: string[];
}

// --- program registry ---------------------------------------------------------

const SYSTEM = "11111111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const SPL = TOKEN_PROGRAM_ID.toBase58();
const T22 = TOKEN_2022_PROGRAM_ID.toBase58();
const ATA = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
const MEMO_V2 = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const MEMO_V1 = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";

const PROGRAM_NAMES: Record<string, string> = {
  [SYSTEM]: "System Program",
  [COMPUTE_BUDGET]: "Compute Budget",
  [SPL]: "SPL Token",
  [T22]: "Token-2022",
  [ATA]: "Associated Token Account",
  [MEMO_V2]: "Memo",
  [MEMO_V1]: "Memo (v1)",
  AddressLookupTab1e1111111111111111111111111: "Address Lookup Table",
  Stake11111111111111111111111111111111111111: "Stake Program",
  Vote111111111111111111111111111111111111111: "Vote Program",
  BPFLoaderUpgradeab1e11111111111111111111111: "BPF Loader Upgradeable",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex Token Metadata",
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf: "Squads Multisig v4",
};

export function programName(programId: string): string | null {
  return PROGRAM_NAMES[programId] ?? null;
}

// --- input decoding -------------------------------------------------------------

const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

function candidates(input: string): Array<{ encoding: SignedTxEncoding; bytes: Uint8Array }> {
  const raw = input.trim().replace(/^0x/i, "");
  const out: Array<{ encoding: SignedTxEncoding; bytes: Uint8Array }> = [];
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    out.push({ encoding: "hex", bytes: Uint8Array.from(Buffer.from(raw, "hex")) });
  }
  if (B58.test(raw)) {
    try {
      out.push({ encoding: "base58", bytes: bs58.decode(raw) });
    } catch {
      /* not base58 */
    }
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length % 4 === 0) {
    out.push({ encoding: "base64", bytes: Uint8Array.from(Buffer.from(raw, "base64")) });
  }
  return out;
}

/** Decode a base58 / base64 / hex serialized transaction (auto-detected). */
export function parseSignedTransaction(input: string): { tx: VersionedTransaction; encoding: SignedTxEncoding; sizeBytes: number } {
  if (!input.trim()) {
    throw new SolwalletError("Transaction payload is empty.", {
      code: "RAW_TX_INVALID",
      hint: "Paste the serialized transaction (base58, base64 or hex).",
    });
  }
  let lastError: unknown = null;
  for (const c of candidates(input)) {
    try {
      const tx = VersionedTransaction.deserialize(c.bytes);
      // A strict round-trip rejects garbage that happens to parse with trailing bytes.
      if (tx.serialize().length !== c.bytes.length) throw new Error(`trailing bytes after ${tx.serialize().length} of ${c.bytes.length}`);
      return { tx, encoding: c.encoding, sizeBytes: c.bytes.length };
    } catch (e) {
      lastError = e;
    }
  }
  throw new SolwalletError(
    `Could not decode a transaction from the input${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : " (not base58, base64 or hex)"}.`,
    {
      code: "RAW_TX_INVALID",
      hint: "Expected the full serialized transaction (signatures + message) as base58, base64 or hex — not a signature, and not just the message bytes.",
      cause: lastError ?? undefined,
    },
  );
}

// --- instruction decoders ----------------------------------------------------------

type Info = Record<string, DecodedValue>;
type Decoded = { type: string; info: Info } | null;

function plain(v: unknown): DecodedValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof PublicKey) return v.toBase58();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  if (typeof v === "object" && v && "pubkey" in v && (v as { pubkey: unknown }).pubkey instanceof PublicKey) {
    return (v as { pubkey: PublicKey }).pubkey.toBase58();
  }
  return String(v);
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function decodeSystem(ix: TransactionInstruction): Decoded {
  const type = SystemInstruction.decodeInstructionType(ix);
  // lamports are base units → always decimal strings (web3.js yields number or bigint).
  const pick = (o: object): Info => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, plain(v)]));
  switch (type) {
    case "Transfer": {
      const d = SystemInstruction.decodeTransfer(ix);
      return { type: "transfer", info: pick({ source: d.fromPubkey, destination: d.toPubkey, lamports: String(d.lamports) }) };
    }
    case "TransferWithSeed": {
      const d = SystemInstruction.decodeTransferWithSeed(ix);
      return { type: "transferWithSeed", info: pick({ source: d.fromPubkey, base: d.basePubkey, destination: d.toPubkey, lamports: String(d.lamports), seed: d.seed, owner: d.programId }) };
    }
    case "Create": {
      const d = SystemInstruction.decodeCreateAccount(ix);
      return { type: "createAccount", info: pick({ source: d.fromPubkey, newAccount: d.newAccountPubkey, lamports: String(d.lamports), space: d.space, owner: d.programId }) };
    }
    case "CreateWithSeed": {
      const d = SystemInstruction.decodeCreateWithSeed(ix);
      return { type: "createAccountWithSeed", info: pick({ source: d.fromPubkey, newAccount: d.newAccountPubkey, base: d.basePubkey, seed: d.seed, lamports: String(d.lamports), space: d.space, owner: d.programId }) };
    }
    case "Assign": {
      const d = SystemInstruction.decodeAssign(ix);
      return { type: "assign", info: pick({ account: d.accountPubkey, owner: d.programId }) };
    }
    case "Allocate": {
      const d = SystemInstruction.decodeAllocate(ix);
      return { type: "allocate", info: pick({ account: d.accountPubkey, space: d.space }) };
    }
    case "AdvanceNonceAccount": {
      const d = SystemInstruction.decodeNonceAdvance(ix);
      return { type: "advanceNonce", info: pick({ nonceAccount: d.noncePubkey, authority: d.authorizedPubkey }) };
    }
    case "WithdrawNonceAccount": {
      const d = SystemInstruction.decodeNonceWithdraw(ix);
      return { type: "withdrawNonce", info: pick({ nonceAccount: d.noncePubkey, destination: d.toPubkey, authority: d.authorizedPubkey, lamports: String(d.lamports) }) };
    }
    case "InitializeNonceAccount": {
      const d = SystemInstruction.decodeNonceInitialize(ix);
      return { type: "initializeNonce", info: pick({ nonceAccount: d.noncePubkey, authority: d.authorizedPubkey }) };
    }
    case "AuthorizeNonceAccount": {
      const d = SystemInstruction.decodeNonceAuthorize(ix);
      return { type: "authorizeNonce", info: pick({ nonceAccount: d.noncePubkey, authority: d.authorizedPubkey, newAuthority: d.newAuthorizedPubkey }) };
    }
    default:
      return { type: lowerFirst(type), info: {} };
  }
}

function decodeComputeBudget(ix: TransactionInstruction): Decoded {
  const type = ComputeBudgetInstruction.decodeInstructionType(ix);
  switch (type) {
    case "SetComputeUnitLimit":
      return { type: "setComputeUnitLimit", info: { units: ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix).units } };
    case "SetComputeUnitPrice":
      return {
        type: "setComputeUnitPrice",
        info: { microLamports: plain(ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix).microLamports) },
      };
    case "RequestHeapFrame":
      return { type: "requestHeapFrame", info: { bytes: ComputeBudgetInstruction.decodeRequestHeapFrame(ix).bytes } };
    case "RequestUnits": {
      const d = ComputeBudgetInstruction.decodeRequestUnits(ix);
      return { type: "requestUnits", info: { units: d.units, additionalFee: d.additionalFee } };
    }
    default:
      return { type: lowerFirst(String(type)), info: {} };
  }
}

function decodeToken(ix: TransactionInstruction): Decoded {
  const tag = ix.data[0];
  const name = tag === undefined ? "unknown" : (TokenInstruction[tag] as string | undefined) ?? `instruction${tag}`;
  try {
    const d = decodeTokenInstruction(ix, ix.programId) as unknown as {
      keys: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    const info: Info = {};
    for (const [k, v] of Object.entries(d.keys)) {
      if (Array.isArray(v)) {
        if (v.length) info[k] = v.map((x) => plain(x)).join(", ");
      } else if (v) info[k] = plain(v);
    }
    for (const [k, v] of Object.entries(d.data)) {
      if (k === "instruction") continue;
      info[k] = plain(v);
    }
    return { type: lowerFirst(name), info };
  } catch {
    // Extension instructions etc.: name only, raw data stays available.
    return { type: lowerFirst(name), info: {} };
  }
}

function decodeAta(ix: TransactionInstruction): Decoded {
  const tag = ix.data.length === 0 ? 0 : ix.data[0];
  const type = tag === 0 ? "create" : tag === 1 ? "createIdempotent" : tag === 2 ? "recoverNested" : `instruction${tag}`;
  const k = ix.keys.map((x) => x.pubkey.toBase58());
  if (tag === 0 || tag === 1) {
    return { type, info: { payer: k[0] ?? null, account: k[1] ?? null, wallet: k[2] ?? null, mint: k[3] ?? null, tokenProgram: k[5] ?? null } };
  }
  return { type, info: {} };
}

function decodeMemo(ix: TransactionInstruction): Decoded {
  return { type: "memo", info: { memo: new TextDecoder("utf-8", { fatal: false }).decode(ix.data) } };
}

function decode(ix: TransactionInstruction): Decoded {
  const id = ix.programId.toBase58();
  try {
    if (id === SYSTEM) return decodeSystem(ix);
    if (id === COMPUTE_BUDGET) return decodeComputeBudget(ix);
    if (id === SPL || id === T22) return decodeToken(ix);
    if (id === ATA) return decodeAta(ix);
    if (id === MEMO_V2 || id === MEMO_V1) return decodeMemo(ix);
  } catch {
    return null;
  }
  return null;
}

// --- main ------------------------------------------------------------------------

function messageAccounts(message: VersionedMessage, resolved?: Map<string, PublicKey[]>): SignedTxAccount[] {
  const flags = (i: number) => ({ signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) });
  const out: SignedTxAccount[] = message.staticAccountKeys.map((k, i) => ({
    index: i,
    pubkey: k.toBase58(),
    ...flags(i),
    source: "static" as const,
  }));
  // v0: all writable lookups (table by table), then all readonly lookups.
  const lookups = message.addressTableLookups;
  const push = (table: PublicKey, idx: number) => {
    const i = out.length;
    out.push({
      index: i,
      pubkey: resolved?.get(table.toBase58())?.[idx]?.toBase58() ?? null,
      ...flags(i),
      source: "lookup",
      lookup: { table: table.toBase58(), index: idx },
    });
  };
  for (const l of lookups) for (const idx of l.writableIndexes) push(l.accountKey, idx);
  for (const l of lookups) for (const idx of l.readonlyIndexes) push(l.accountKey, idx);
  return out;
}

/** Pure, offline decode of a serialized transaction. */
export function decodeSignedTransaction(
  input: string,
  opts: { resolvedLookups?: Map<string, PublicKey[]> } = {},
): SignedTransactionInspection {
  const { tx, encoding, sizeBytes } = parseSignedTransaction(input);
  const message = tx.message;
  const messageBytes = message.serialize();
  const warnings: string[] = [];

  const signatures: SignedTxSignature[] = tx.signatures.map((sig, i) => {
    const signer = message.staticAccountKeys[i]!.toBase58();
    if (sig.every((b) => b === 0)) return { signer, signature: null, valid: null };
    let valid = false;
    try {
      valid = ed25519.verify(sig, messageBytes, message.staticAccountKeys[i]!.toBytes());
    } catch {
      valid = false;
    }
    return { signer, signature: bs58.encode(sig), valid };
  });
  const fullySigned = signatures.every((s) => s.signature !== null);
  const allSignaturesValid = fullySigned && signatures.every((s) => s.valid === true);
  if (!fullySigned) warnings.push(`${signatures.filter((s) => !s.signature).length} required signature(s) missing — the transaction cannot be submitted as is.`);
  for (const s of signatures) if (s.valid === false) warnings.push(`Signature of ${s.signer} does NOT verify against the message (tampered message or wrong signer).`);

  const accounts = messageAccounts(message, opts.resolvedLookups);
  if (accounts.some((a) => a.pubkey === null)) {
    warnings.push("Some accounts come from address lookup tables and are not resolved (offline decode); query the cluster to resolve them.");
  }

  const instructions: SignedTxInstruction[] = message.compiledInstructions.map((ci, index) => {
    const programId = accounts[ci.programIdIndex]?.pubkey ?? message.staticAccountKeys[ci.programIdIndex]!.toBase58();
    const ixAccounts = ci.accountKeyIndexes.map((i) => ({
      index: i,
      pubkey: accounts[i]?.pubkey ?? null,
      signer: accounts[i]?.signer ?? false,
      writable: accounts[i]?.writable ?? false,
    }));
    const data = Uint8Array.from(ci.data);
    let decoded: Decoded = null;
    if (ixAccounts.every((a) => a.pubkey !== null)) {
      decoded = decode(
        new TransactionInstruction({
          programId: new PublicKey(programId),
          keys: ixAccounts.map((a) => ({ pubkey: new PublicKey(a.pubkey!), isSigner: a.signer, isWritable: a.writable })),
          data: Buffer.from(data),
        }),
      );
    }
    return {
      index,
      programId,
      programName: programName(programId),
      accounts: ixAccounts,
      dataHex: Buffer.from(data).toString("hex"),
      dataLength: data.length,
      decoded,
    };
  });

  return {
    encoding,
    version: tx.version === "legacy" ? "legacy" : 0,
    sizeBytes,
    signature: signatures[0]?.signature ?? null,
    feePayer: message.staticAccountKeys[0]!.toBase58(),
    recentBlockhash: message.recentBlockhash,
    header: { ...message.header },
    signatures,
    fullySigned,
    allSignaturesValid,
    accounts,
    addressTableLookups: message.addressTableLookups.map((l) => ({
      table: l.accountKey.toBase58(),
      writableIndexes: [...l.writableIndexes],
      readonlyIndexes: [...l.readonlyIndexes],
    })),
    instructions,
    chain: null,
    warnings,
  };
}

/**
 * Decode, then (with a connection) resolve lookup tables and ask the cluster
 * whether the signature has landed and whether the blockhash is still valid.
 * RPC failures degrade to warnings — the offline decode is always returned.
 */
export async function inspectSignedTransaction(input: string, conn?: ClusterConnection): Promise<SignedTransactionInspection> {
  const offline = decodeSignedTransaction(input);
  if (!conn) return offline;
  const c = conn.connection;
  const warnings: string[] = [];

  let resolved: Map<string, PublicKey[]> | undefined;
  if (offline.addressTableLookups.length) {
    resolved = new Map();
    for (const l of offline.addressTableLookups) {
      try {
        const res = await c.getAddressLookupTable(new PublicKey(l.table));
        if (res.value) resolved.set(l.table, res.value.state.addresses);
        else warnings.push(`Address lookup table ${l.table} not found on cluster "${conn.cluster}".`);
      } catch (e) {
        warnings.push(`Could not load address lookup table ${l.table}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  const result = resolved ? decodeSignedTransaction(input, { resolvedLookups: resolved }) : offline;

  let chain: SignedTxChainStatus | null = null;
  if (result.signature) {
    try {
      const st = (await c.getSignatureStatuses([result.signature], { searchTransactionHistory: true })).value[0];
      chain = st
        ? { status: st.confirmationStatus ?? "processed", slot: st.slot, err: st.err ?? null, blockhashValid: null }
        : { status: "not-found", slot: null, err: null, blockhashValid: null };
    } catch (e) {
      warnings.push(`Could not query signature status: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (chain && chain.status === "not-found") {
    try {
      chain.blockhashValid = (await c.isBlockhashValid(result.recentBlockhash, { commitment: "confirmed" })).value;
      if (chain.blockhashValid === false) {
        warnings.push(
          `Not found on cluster "${conn.cluster}" and its recentBlockhash is not valid there: either it expired (the transaction can no longer land, unless it uses a durable nonce — an "advanceNonce" first instruction) or the transaction was built for another cluster.`,
        );
      }
    } catch (e) {
      warnings.push(`Could not check blockhash validity: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ...result, chain, warnings: [...result.warnings, ...warnings] };
}
