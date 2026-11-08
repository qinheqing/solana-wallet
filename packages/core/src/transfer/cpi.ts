/**
 * CPI batch transfers (F4.4 / task #7): client-side support for the
 * `solwallet_cpi` example program (packages/cpi-program).
 *
 * The program owns a PDA vault (seeds `[b"vault"]`) whose data holds a
 * 32-byte stored authority pubkey. `initialize_vault` creates it (via a
 * System Program CreateAccount CPI) and sets the authority; `batch_transfer`
 * pays out N recipients, but only when the signer matches the stored
 * authority — a signer who is not the authority is rejected on-chain.
 * Everything on this side is hand-rolled wire format — no Anchor IDL, no
 * borsh:
 *
 *   initialize_vault instruction data : u8 discriminant (0) | 32B authority pubkey
 *   initialize_vault accounts         : [payer(signer,writable), vault(writable), systemProgram(readonly)]
 *
 *   batch_transfer instruction data : u8 discriminant (1) | u16 LE count | count × (32B pubkey + u64 LE lamports)
 *   batch_transfer accounts         : [authority(signer,writable), vault(writable), systemProgram(readonly), recipient × count (writable)]
 *
 *   forward_transfer_checked instruction data : u8 discriminant (2) | u64 LE amount | u8 decimals
 *   forward_transfer_checked accounts         : [authority(signer), source(writable), mint(readonly), destination(writable), tokenProgram(readonly), extras…]
 *   (PRD T-I — the program CPIs TransferChecked so the token movement shows
 *   up as an *inner* instruction; `cpiTokenTransfer` is the high-level entry.)
 *
 * `deployCpiProgram` implements the full BPFLoaderUpgradeable flow
 * (create buffer → InitializeBuffer → chunked Write → DeployWithMaxDataLen →
 * Close buffer) with raw instructions, mirroring `solana program deploy`.
 */

import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import type { ClusterConnection, ConfirmPolicy } from "../connection/connection.js";
import { MainnetNotAllowedError, SolwalletError, TransactionSendError } from "../connection/errors.js";
import { parseTransactionError, type ParsedProgramError } from "../utils/parse-error.js";
import { dryRun } from "./dryrun.js";
import { planFromInstructions, type TransactionPlan } from "./plan.js";
import { getMintProgram, type TokenProgramKind } from "./program.js";

// ---------------------------------------------------------------------------
// Program wire-format constants (must match packages/cpi-program/src/lib.rs)
// ---------------------------------------------------------------------------

/** BPFLoaderUpgradeable program id. */
export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

/** Discriminant byte of the program's `initialize_vault` instruction. */
export const CPI_INITIALIZE_VAULT_DISCRIMINANT = 0;
/** Discriminant byte of the program's `batch_transfer` instruction. */
export const CPI_BATCH_TRANSFER_DISCRIMINANT = 1;
/** Discriminant byte of the program's `forward_transfer_checked` instruction (PRD T-I). */
export const CPI_FORWARD_TRANSFER_CHECKED_DISCRIMINANT = 2;
/** `forward_transfer_checked` instruction-data size (disc + u64 amount + u8 decimals). */
export const CPI_FORWARD_TRANSFER_CHECKED_DATA_BYTES = 1 + 8 + 1;

/** PDA seed of the program's SOL vault. */
export const CPI_VAULT_SEED = Buffer.from("vault");

/** Header size of the `batch_transfer` instruction data (disc + u16 count). */
export const CPI_HEADER_BYTES = 3;
/** Per-recipient instruction-data size (32B pubkey + 8B lamports). */
export const CPI_ITEM_BYTES = 32 + 8;
/** `initialize_vault` instruction-data size (disc + 32B authority pubkey). */
export const CPI_INITIALIZE_VAULT_DATA_BYTES = 1 + 32;

/** Buffer account header (Option<Pubkey> authority etc.), loader-side. */
export const LOADER_BUFFER_HEADER_BYTES = 37;
/** Program account size (just the program pubkey). */
export const LOADER_PROGRAM_ACCOUNT_BYTES = 36;

/**
 * Default bytes per buffer Write transaction. The playground CLI uses
 * PACKET_DATA_SIZE − 220 = 1012; 900 leaves comfortable room for the vec
 * length prefix and signature overhead under the 1232-byte tx limit.
 */
export const DEFAULT_DEPLOY_CHUNK_BYTES = 900;

/** One payout inside a `batch_transfer` call. */
export interface CpiRecipient {
  /** Recipient address. */
  to: PublicKey;
  /** Lamports to pay from the vault. */
  lamports: number | bigint;
}

/** Derive the program's vault PDA (seeds `[b"vault"]`). */
export function findCpiVaultPda(
  programId: PublicKey,
): { vault: PublicKey; bump: number } {
  const [vault, bump] = PublicKey.findProgramAddressSync(
    [CPI_VAULT_SEED],
    programId,
  );
  return { vault, bump };
}

/** Maximum recipients encodable in the u16 count field. */
export const CPI_MAX_RECIPIENTS = 65_535;

/**
 * Serialize `batch_transfer` instruction data:
 * `[discriminant: u8][count: u16 LE][recipient: 32B][lamports: u64 LE]…`
 */
export function serializeCpiBatchTransferData(
  recipients: readonly CpiRecipient[],
): Buffer {
  if (recipients.length === 0) {
    throw new SolwalletError("batch_transfer requires at least one recipient.", {
      code: "CPI_BATCH_EMPTY",
    });
  }
  if (recipients.length > CPI_MAX_RECIPIENTS) {
    throw new SolwalletError(
      `batch_transfer supports at most ${CPI_MAX_RECIPIENTS} recipients, got ${recipients.length}.`,
      { code: "CPI_BATCH_TOO_LARGE" },
    );
  }
  const data = Buffer.alloc(CPI_HEADER_BYTES + recipients.length * CPI_ITEM_BYTES);
  data.writeUInt8(CPI_BATCH_TRANSFER_DISCRIMINANT, 0);
  data.writeUInt16LE(recipients.length, 1);
  recipients.forEach((r, i) => {
    const offset = CPI_HEADER_BYTES + i * CPI_ITEM_BYTES;
    data.set(r.to.toBytes(), offset);
    const lamports = BigInt(r.lamports);
    if (lamports < 0n) {
      throw new SolwalletError(`lamports must be ≥ 0, got ${lamports}.`, {
        code: "CPI_BATCH_INVALID_LAMPORTS",
      });
    }
    data.writeBigUInt64LE(lamports, offset + 32);
  });
  return data;
}

/**
 * Serialize `initialize_vault` instruction data:
 * `[discriminant: u8 (0)][authority: 32B pubkey]`
 */
export function serializeCpiInitializeVaultData(authority: PublicKey): Buffer {
  const data = Buffer.alloc(CPI_INITIALIZE_VAULT_DATA_BYTES);
  data.writeUInt8(CPI_INITIALIZE_VAULT_DISCRIMINANT, 0);
  data.set(authority.toBytes(), 1);
  return data;
}

/**
 * Build the `initialize_vault` transaction instruction.
 *
 * Account layout (must match the Rust program): [0] payer (signer,
 * writable — funds rent), [1] vault PDA (derived here, must not already
 * exist), [2] System Program (readonly). `authority` need not equal
 * `payer` — a relayer can fund the vault for a cold-wallet-controlled
 * authority.
 */
export function buildCpiInitializeVaultInstruction(
  programId: PublicKey,
  payer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const { vault } = findCpiVaultPda(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: serializeCpiInitializeVaultData(authority),
  });
}

/**
 * Build the `batch_transfer` transaction instruction.
 *
 * Account layout (must match the Rust program): [0] authority (signer,
 * writable), [1] vault PDA (derived here, writable), [2] System Program
 * (readonly — validated on-chain but not invoked by this instruction; the
 * payout moves lamports by direct arithmetic since the vault carries data
 * and the real System Program `Transfer` CPI cannot debit a data-carrying
 * account), [3..] recipients (writable).
 */
export function buildCpiBatchTransferInstruction(
  programId: PublicKey,
  vaultAuthority: PublicKey,
  recipients: readonly CpiRecipient[],
): TransactionInstruction {
  const { vault } = findCpiVaultPda(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: vaultAuthority, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...recipients.map((r) => ({
        pubkey: r.to,
        isSigner: false,
        isWritable: true,
      })),
    ],
    data: serializeCpiBatchTransferData(recipients),
  });
}

/** Result of a `batch_transfer` call (sent or simulated). */
export interface CpiBatchTransferResult {
  /** Empty for simulated calls. */
  signature: string;
  slot: number;
  /** Fee in lamports (0 for simulations). */
  feeLamports: number;
  /** Vault PDA the lamports were paid from. */
  vault: string;
  recipientCount: number;
  /** Sum of all lamports paid out. */
  totalLamports: bigint;
  /** True when this was a dry-run simulation — nothing was sent on chain. */
  simulatedOnly: boolean;
  /** Populated by dryRun: full simulation logs. */
  logs?: string[];
  unitsConsumed?: number;
  /** Parsed failure — set instead of throwing, for AI-friendly flows. */
  error?: ParsedProgramError;
}

export interface CpiBatchTransferOptions {
  /** Explicit mainnet confirmation, forwarded to sendWithRetry. */
  allowMainnet?: boolean;
  /** Confirm/retry policy override forwarded to sendWithRetry. */
  policy?: Partial<ConfirmPolicy>;
  /** Simulate only — nothing is sent on chain. */
  dryRun?: boolean;
}

/**
 * Execute a CPI batch transfer: derive the vault PDA, build the
 * `batch_transfer` instruction, sign and send through sendWithRetry.
 * The on-chain program pays every recipient from the vault in one atomic
 * transaction — one signature covers N payouts.
 *
 * When `opts.dryRun` is set, the transaction is simulated instead of sent;
 * send failures are also caught and returned as a parsed error rather than
 * thrown, mirroring `transfer()` in `transfer.ts`.
 */
export async function executeCpiBatchTransfer(
  conn: ClusterConnection,
  from: Keypair,
  programId: PublicKey,
  recipients: readonly CpiRecipient[],
  opts: CpiBatchTransferOptions = {},
): Promise<CpiBatchTransferResult> {
  const instruction = buildCpiBatchTransferInstruction(
    programId,
    from.publicKey,
    recipients,
  );
  const { blockhash, lastValidBlockHeight } = await conn.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: from.publicKey,
    recentBlockhash: blockhash,
    instructions: [instruction],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([from]);

  const vault = findCpiVaultPda(programId).vault.toBase58();
  const totalLamports = recipients.reduce((sum, r) => sum + BigInt(r.lamports), 0n);

  if (opts.dryRun) {
    const sim = await dryRun(conn, tx);
    const base: CpiBatchTransferResult = {
      signature: "",
      slot: 0,
      feeLamports: 0,
      vault,
      recipientCount: recipients.length,
      totalLamports,
      logs: sim.logs,
      unitsConsumed: sim.unitsConsumed,
      simulatedOnly: true,
    };
    if (!sim.ok) {
      const simErr = {
        message: `Transaction simulation failed: ${JSON.stringify(sim.err)}`,
        logs: sim.logs,
      };
      return { ...base, error: parseTransactionError(simErr) };
    }
    return base;
  }

  try {
    const sent = await conn.sendWithRetry(tx, {
      lastValidBlockHeight,
      allowMainnet: opts.allowMainnet,
      policy: opts.policy,
    });
    return {
      signature: sent.signature,
      slot: sent.slot,
      feeLamports: sent.feeLamports,
      vault,
      recipientCount: recipients.length,
      totalLamports,
      simulatedOnly: false,
    };
  } catch (error) {
    return {
      signature:
        error instanceof TransactionSendError ? (error.signature ?? "") : "",
      slot: 0,
      feeLamports: 0,
      vault,
      recipientCount: recipients.length,
      totalLamports,
      simulatedOnly: false,
      error: parseTransactionError(error),
    };
  }
}

/** Result of an `initialize_vault` call (sent or simulated). */
export interface CpiInitializeVaultResult {
  /** Empty for simulated calls. */
  signature: string;
  slot: number;
  /** Fee in lamports (0 for simulations). */
  feeLamports: number;
  /** The vault PDA that was initialized. */
  vault: string;
  /** The authority stored on the vault. */
  authority: string;
  /** True when this was a dry-run simulation — nothing was sent on chain. */
  simulatedOnly: boolean;
  /** Populated by dryRun: full simulation logs. */
  logs?: string[];
  unitsConsumed?: number;
  /** Parsed failure — set instead of throwing, for AI-friendly flows. */
  error?: ParsedProgramError;
}

export interface CpiInitializeVaultOptions {
  /** Explicit mainnet confirmation, forwarded to sendWithRetry. */
  allowMainnet?: boolean;
  /** Confirm/retry policy override forwarded to sendWithRetry. */
  policy?: Partial<ConfirmPolicy>;
  /** Simulate only — nothing is sent on chain. */
  dryRun?: boolean;
}

/**
 * Initialize the CPI program's vault: derive the vault PDA, build the
 * `initialize_vault` instruction, sign and send through sendWithRetry.
 * `payer` funds the vault's rent and pays the transaction fee; `authority`
 * is the pubkey stored on-chain as the only signer later allowed to
 * withdraw via `executeCpiBatchTransfer` (it need not equal `payer`).
 *
 * When `opts.dryRun` is set, the transaction is simulated instead of sent;
 * send failures are also caught and returned as a parsed error rather than
 * thrown, mirroring `transfer()` in `transfer.ts`.
 */
export async function initializeCpiVault(
  conn: ClusterConnection,
  payer: Keypair,
  programId: PublicKey,
  authority: PublicKey,
  opts: CpiInitializeVaultOptions = {},
): Promise<CpiInitializeVaultResult> {
  const instruction = buildCpiInitializeVaultInstruction(
    programId,
    payer.publicKey,
    authority,
  );
  const { blockhash, lastValidBlockHeight } = await conn.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [instruction],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);

  const vault = findCpiVaultPda(programId).vault.toBase58();
  const authorityBase58 = authority.toBase58();

  if (opts.dryRun) {
    const sim = await dryRun(conn, tx);
    const base: CpiInitializeVaultResult = {
      signature: "",
      slot: 0,
      feeLamports: 0,
      vault,
      authority: authorityBase58,
      logs: sim.logs,
      unitsConsumed: sim.unitsConsumed,
      simulatedOnly: true,
    };
    if (!sim.ok) {
      const simErr = {
        message: `Transaction simulation failed: ${JSON.stringify(sim.err)}`,
        logs: sim.logs,
      };
      return { ...base, error: parseTransactionError(simErr) };
    }
    return base;
  }

  try {
    const sent = await conn.sendWithRetry(tx, {
      lastValidBlockHeight,
      allowMainnet: opts.allowMainnet,
      policy: opts.policy,
    });
    return {
      signature: sent.signature,
      slot: sent.slot,
      feeLamports: sent.feeLamports,
      vault,
      authority: authorityBase58,
      simulatedOnly: false,
    };
  } catch (error) {
    return {
      signature:
        error instanceof TransactionSendError ? (error.signature ?? "") : "",
      slot: 0,
      feeLamports: 0,
      vault,
      authority: authorityBase58,
      simulatedOnly: false,
      error: parseTransactionError(error),
    };
  }
}

// ---------------------------------------------------------------------------
// forward_transfer_checked (PRD T-I): token transfer as an inner instruction
// ---------------------------------------------------------------------------

/**
 * Serialize `forward_transfer_checked` instruction data:
 * `[discriminant: u8 (2)][amount: u64 LE][decimals: u8]`
 */
export function serializeCpiForwardTransferCheckedData(
  amount: number | bigint,
  decimals: number,
): Buffer {
  const raw = BigInt(amount);
  if (raw < 0n || raw > 0xffff_ffff_ffff_ffffn) {
    throw new SolwalletError(`amount must fit an unsigned u64, got ${raw}.`, {
      code: "CPI_FORWARD_INVALID_AMOUNT",
    });
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new SolwalletError(`decimals must be an integer in 0..255, got ${decimals}.`, {
      code: "CPI_FORWARD_INVALID_DECIMALS",
    });
  }
  const data = Buffer.alloc(CPI_FORWARD_TRANSFER_CHECKED_DATA_BYTES);
  data.writeUInt8(CPI_FORWARD_TRANSFER_CHECKED_DISCRIMINANT, 0);
  data.writeBigUInt64LE(raw, 1);
  data.writeUInt8(decimals, 9);
  return data;
}

export interface ForwardTransferCheckedInstructionParams {
  /** Deployed `solwallet_cpi` program id. */
  programId: PublicKey;
  /** Source owner (or delegate) — signs the outer transaction. */
  authority: PublicKey;
  /** Source token account (writable). */
  source: PublicKey;
  /** Mint of the token being moved (readonly). */
  mint: PublicKey;
  /** Destination token account (writable). */
  destination: PublicKey;
  /** SPL Token or Token-2022 program id — the on-chain program rejects anything else. */
  tokenProgramId: PublicKey;
  amount: number | bigint;
  decimals: number;
  /**
   * Extra accounts appended after the fixed five and passed through verbatim
   * to the TransferChecked CPI (needed when the mint carries a TransferHook).
   */
  extraAccounts?: readonly { pubkey: PublicKey; isSigner?: boolean; isWritable?: boolean }[];
}

/**
 * Build the `forward_transfer_checked` instruction.
 *
 * Account layout (must match the Rust program): [0] authority (signer),
 * [1] source token account (writable), [2] mint (readonly), [3] destination
 * token account (writable), [4] token program (readonly), [5..] extras.
 * The program CPIs TransferChecked on `tokenProgramId` with `authority` as
 * the signer — no PDA signing is involved.
 */
export function buildForwardTransferCheckedInstruction(
  params: ForwardTransferCheckedInstructionParams,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: params.source, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.destination, isSigner: false, isWritable: true },
      { pubkey: params.tokenProgramId, isSigner: false, isWritable: false },
      ...(params.extraAccounts ?? []).map((a) => ({
        pubkey: a.pubkey,
        isSigner: a.isSigner === true,
        isWritable: a.isWritable === true,
      })),
    ],
    data: serializeCpiForwardTransferCheckedData(params.amount, params.decimals),
  });
}

export interface CpiTokenTransferRequest {
  /** Deployed `solwallet_cpi` program id (see `deployCpiProgram`). */
  programId: PublicKey;
  /** Source wallet — owns the source ATA, signs and pays fees. */
  from: Keypair;
  /** Destination *owner* (wallet address); its ATA is derived here. */
  destination: PublicKey;
  mint: PublicKey;
  /** Base units (already scaled by `decimals`). */
  amount: number | bigint;
  decimals: number;
  /** Create the destination ATA (idempotent) when missing. Default true. */
  allowAtaCreation?: boolean;
  /** Pass-through accounts for the TransferChecked CPI (TransferHook mints). */
  extraAccounts?: ForwardTransferCheckedInstructionParams["extraAccounts"];
  /** Explicit mainnet confirmation, forwarded to sendWithRetry. */
  allowMainnet?: boolean;
  /** Confirm/retry policy override forwarded to sendWithRetry. */
  policy?: Partial<ConfirmPolicy>;
  /** Simulate only — nothing is sent on chain. */
  dryRun?: boolean;
}

/** Result of a `cpiTokenTransfer` call (sent or simulated); mirrors `TransferResult`. */
export interface CpiTokenTransferResult {
  /** Empty for simulated transfers. */
  signature: string;
  slot: number;
  /** Fee in lamports (0 for simulations). */
  feeLamports: number;
  /** Token program the mint belongs to (resolved on chain). */
  program: TokenProgramKind;
  sourceAta: string;
  destinationAta: string;
  /** Destination ATA creation was included in this transaction. */
  destinationAtaCreated: boolean;
  /** Base units moved. */
  amount: bigint;
  /** True when this was a dry-run simulation — nothing was sent on chain. */
  simulatedOnly: boolean;
  /** Populated by dryRun: full simulation logs. */
  logs?: string[];
  unitsConsumed?: number;
  /** Parsed failure — set instead of throwing, for AI-friendly flows. */
  error?: ParsedProgramError;
  /** What was compiled: instructions, message hex, signers, blockhash. */
  plan: TransactionPlan;
}

/**
 * Move tokens through the CPI forwarder so the TransferChecked lands as an
 * *inner* instruction (PRD T-I): resolve the mint's program, derive both
 * ATAs, optionally prepend an idempotent create for the destination ATA,
 * then sign and send through sendWithRetry (or simulate with `dryRun`).
 * Send/simulation failures are returned in-band as `error`, like
 * `transfer()`.
 */
export async function cpiTokenTransfer(
  conn: ClusterConnection,
  req: CpiTokenTransferRequest,
): Promise<CpiTokenTransferResult> {
  const program = await getMintProgram(conn, req.mint);
  const sourceAta = getAssociatedTokenAddressSync(
    req.mint,
    req.from.publicKey,
    true,
    program.programId,
  );
  const destinationAta = getAssociatedTokenAddressSync(
    req.mint,
    req.destination,
    true,
    program.programId,
  );

  const instructions: TransactionInstruction[] = [];
  const labels: string[] = [];
  let destinationAtaCreated = false;
  const destInfo = await conn.connection.getAccountInfo(destinationAta);
  if (!destInfo) {
    if (req.allowAtaCreation === false) {
      throw new SolwalletError(
        `Destination token account ${destinationAta.toBase58()} does not exist and allowAtaCreation is false.`,
        {
          code: "DESTINATION_ATA_MISSING",
          hint: "Pass allowAtaCreation: true (default) to create it idempotently in the same transaction.",
        },
      );
    }
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        req.from.publicKey,
        destinationAta,
        req.destination,
        req.mint,
        program.programId,
      ),
    );
    labels.push("createAssociatedTokenAccountIdempotent");
    destinationAtaCreated = true;
  }

  instructions.push(
    buildForwardTransferCheckedInstruction({
      programId: req.programId,
      authority: req.from.publicKey,
      source: sourceAta,
      mint: req.mint,
      destination: destinationAta,
      tokenProgramId: program.programId,
      amount: req.amount,
      decimals: req.decimals,
      extraAccounts: req.extraAccounts,
    }),
  );
  labels.push("cpiForwardTransferChecked");

  const { blockhash, lastValidBlockHeight } = await conn.connection.getLatestBlockhash("confirmed");
  const { message, plan } = planFromInstructions(req.from.publicKey, blockhash, instructions, labels);
  const tx = new VersionedTransaction(message);
  tx.sign([req.from]);

  const base: CpiTokenTransferResult = {
    signature: "",
    slot: 0,
    feeLamports: 0,
    program: program.kind,
    sourceAta: sourceAta.toBase58(),
    destinationAta: destinationAta.toBase58(),
    destinationAtaCreated,
    amount: BigInt(req.amount),
    simulatedOnly: req.dryRun === true,
    plan,
  };

  if (req.dryRun) {
    const sim = await dryRun(conn, tx);
    const simulated = { ...base, logs: sim.logs, unitsConsumed: sim.unitsConsumed };
    if (!sim.ok) {
      const simErr = {
        message: `Transaction simulation failed: ${JSON.stringify(sim.err)}`,
        logs: sim.logs,
      };
      return { ...simulated, error: parseTransactionError(simErr) };
    }
    return simulated;
  }

  try {
    const sent = await conn.sendWithRetry(tx, {
      lastValidBlockHeight,
      allowMainnet: req.allowMainnet,
      policy: req.policy,
    });
    return { ...base, signature: sent.signature, slot: sent.slot, feeLamports: sent.feeLamports };
  } catch (error) {
    return {
      ...base,
      signature: error instanceof TransactionSendError ? (error.signature ?? "") : "",
      error: parseTransactionError(error),
    };
  }
}

// ---------------------------------------------------------------------------
// BPFLoaderUpgradeable deployment (create buffer → write → deploy → close)
// ---------------------------------------------------------------------------

/** LE u32 loader instruction discriminants. */
const LOADER_IX = {
  initializeBuffer: 0,
  write: 1,
  deployWithMaxDataLen: 2,
  close: 5,
} as const;

function u32le(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

/** u32 LE discriminant + u32 LE offset + rust-Vec bytes (u32 LE len + data). */
function loaderWriteData(offset: number, chunk: Buffer): Buffer {
  return Buffer.concat([u32le(LOADER_IX.write), u32le(offset), u32le(chunk.length), chunk]);
}

/** u32 LE discriminant + u32 LE maxDataLen + zero padding slot. */
function loaderDeployData(maxDataLen: number): Buffer {
  return Buffer.concat([
    u32le(LOADER_IX.deployWithMaxDataLen),
    u32le(maxDataLen),
    u32le(0),
  ]);
}

/** ProgramData account PDA for an upgradeable program. */
export function findProgramDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  )[0];
}

export interface DeployCpiProgramOptions {
  /** Deterministic program address; generated when omitted. */
  programKeypair?: Keypair;
  /** Deterministic buffer address; generated when omitted. */
  bufferKeypair?: Keypair;
  /** Explicit mainnet confirmation — deployment is refused without it. */
  allowMainnet?: boolean;
  /** Confirm/retry policy forwarded to sendWithRetry. */
  policy?: Partial<ConfirmPolicy>;
  /** Bytes per buffer-write transaction. Default 900. */
  chunkBytes?: number;
  /** Reclaim the buffer's rent after deploy (default true). */
  closeBuffer?: boolean;
}

/** Result of a successful program deployment. */
export interface DeployCpiProgramResult {
  programId: string;
  bufferPubkey: string;
  bytesWritten: number;
  /** Signature of the DeployWithMaxDataLen transaction. */
  deploySignature: string;
  /** Signature of the buffer Close transaction (absent when skipped/failed). */
  closeBufferSignature?: string;
}

/**
 * Deploy a .so program over BPFLoaderUpgradeable, raw-instruction style:
 *
 *  1. CreateAccount(buffer, space = 37 + programLen) + InitializeBuffer
 *  2. Write chunks (chunkBytes each) until the whole ELF is uploaded
 *  3. CreateAccount(program, 36 B) + DeployWithMaxDataLen(maxDataLen = programLen)
 *  4. Close(buffer) — best effort, reclaims the buffer rent
 *
 * Every transaction goes through conn.sendWithRetry (confirmed serially).
 * Mirrors `solana program deploy` semantics; refuses mainnet-beta unless
 * allowMainnet is passed (same guard as the rest of ClusterConnection).
 */
export async function deployCpiProgram(
  conn: ClusterConnection,
  payer: Keypair,
  soBytesOrPath: Buffer | Uint8Array | string,
  opts: DeployCpiProgramOptions = {},
): Promise<DeployCpiProgramResult> {
  // Same guard sendWithRetry applies (custom RPCs are probed by genesis
  // hash), checked up front so no rent lookups or buffer writes happen first.
  if (!opts.allowMainnet && (await conn.isMainnet())) {
    throw new MainnetNotAllowedError(
      conn.cluster === "custom" ? "custom(mainnet-beta)" : conn.cluster,
      "deploy a BPF program",
    );
  }

  const programBytes = Buffer.isBuffer(soBytesOrPath)
    ? soBytesOrPath
    : Buffer.from(
        typeof soBytesOrPath === "string"
          ? await (await import("node:fs/promises")).readFile(soBytesOrPath) // lazy: keeps core browser-safe
          : soBytesOrPath,
      );
  if (programBytes.length === 0) {
    throw new SolwalletError("Program bytes are empty — nothing to deploy.", {
      code: "CPI_DEPLOY_EMPTY_PROGRAM",
    });
  }

  const bufferKeypair = opts.bufferKeypair ?? Keypair.generate();
  const programKeypair = opts.programKeypair ?? Keypair.generate();
  const chunkSize = opts.chunkBytes ?? DEFAULT_DEPLOY_CHUNK_BYTES;
  const rpc = conn.connection;

  // Rent for the buffer (37 + len) and the program account (36 B); the
  // programdata account (45 + maxDataLen) is paid for by the loader CPI.
  const bufferLamports = await rpc.getMinimumBalanceForRentExemption(
    LOADER_BUFFER_HEADER_BYTES + programBytes.length,
  );
  const programLamports = await rpc.getMinimumBalanceForRentExemption(
    LOADER_PROGRAM_ACCOUNT_BYTES,
  );

  const signAndSend = async (
    instructions: readonly TransactionInstruction[],
    signers: readonly Keypair[],
  ): Promise<string> => {
    const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [...instructions],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([...signers]);
    return (
      await conn.sendWithRetry(tx, {
        policy: opts.policy,
        allowMainnet: opts.allowMainnet,
        lastValidBlockHeight,
      })
    ).signature;
  };

  // 1. Create + initialize the buffer account.
  await signAndSend(
    [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: bufferKeypair.publicKey,
        lamports: bufferLamports,
        space: LOADER_BUFFER_HEADER_BYTES + programBytes.length,
        programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
      }),
      new TransactionInstruction({
        programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
        keys: [
          { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: false, isWritable: false },
        ],
        data: u32le(LOADER_IX.initializeBuffer),
      }),
    ],
    [payer, bufferKeypair],
  );

  // 2. Upload the ELF in chunks (offsets are multiples of chunkSize).
  for (let offset = 0; offset < programBytes.length; offset += chunkSize) {
    const chunk = programBytes.subarray(offset, offset + chunkSize);
    await signAndSend(
      [
        new TransactionInstruction({
          programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
          keys: [
            { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          ],
          data: loaderWriteData(offset, chunk),
        }),
      ],
      [payer],
    );
  }

  // 3. Create the program account and deploy from the buffer.
  const deploySignature = await signAndSend(
    [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: programKeypair.publicKey,
        lamports: programLamports,
        space: LOADER_PROGRAM_ACCOUNT_BYTES,
        programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
      }),
      new TransactionInstruction({
        programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: findProgramDataAddress(programKeypair.publicKey), isSigner: false, isWritable: true },
          { pubkey: programKeypair.publicKey, isSigner: false, isWritable: true },
          { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: true },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        ],
        data: loaderDeployData(programBytes.length),
      }),
    ],
    [payer, programKeypair],
  );

  // 4. Reclaim the buffer rent (best effort — failure is not fatal).
  let closeBufferSignature: string | undefined;
  if (opts.closeBuffer !== false) {
    try {
      closeBufferSignature = await signAndSend(
        [
          new TransactionInstruction({
            programId: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
            keys: [
              { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: true },
              { pubkey: payer.publicKey, isSigner: false, isWritable: true },
              { pubkey: payer.publicKey, isSigner: true, isWritable: false },
            ],
            data: u32le(LOADER_IX.close),
          }),
        ],
        [payer],
      );
    } catch {
      // Buffer left open — its rent stays locked; report and move on.
    }
  }

  return {
    programId: programKeypair.publicKey.toBase58(),
    bufferPubkey: bufferKeypair.publicKey.toBase58(),
    bytesWritten: programBytes.length,
    deploySignature,
    closeBufferSignature,
  };
}
