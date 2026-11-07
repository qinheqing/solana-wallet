/**
 * CPI batch transfers (F4.4 / task #7): client-side support for the
 * `solwallet_cpi` example program (packages/cpi-program).
 *
 * The program owns a PDA vault (seeds `[b"vault"]`) that holds SOL and pays
 * N recipients via one System Program CPI each. Everything on this side is
 * hand-rolled wire format — no Anchor IDL, no borsh:
 *
 *   instruction data : u8 discriminant | u16 LE count | count × (32B pubkey + u64 LE lamports)
 *   accounts         : [authority(signer), vault(writable), recipient × count (writable)]
 *
 * `deployCpiProgram` implements the full BPFLoaderUpgradeable flow
 * (create buffer → InitializeBuffer → chunked Write → DeployWithMaxDataLen →
 * Close buffer) with raw instructions, mirroring `solana program deploy`.
 */
import { readFile } from "node:fs/promises";

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
import { MainnetNotAllowedError, SolwalletError } from "../connection/errors.js";

// ---------------------------------------------------------------------------
// Program wire-format constants (must match packages/cpi-program/src/lib.rs)
// ---------------------------------------------------------------------------

/** BPFLoaderUpgradeable program id. */
export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

/** Discriminant byte of the program's `batch_transfer` instruction. */
export const CPI_BATCH_TRANSFER_DISCRIMINANT = 1;

/** PDA seed of the program's SOL vault. */
export const CPI_VAULT_SEED = Buffer.from("vault");

/** Header size of the `batch_transfer` instruction data (disc + u16 count). */
export const CPI_HEADER_BYTES = 3;
/** Per-recipient instruction-data size (32B pubkey + 8B lamports). */
export const CPI_ITEM_BYTES = 32 + 8;

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
 * Build the `batch_transfer` transaction instruction.
 *
 * Account layout (must match the Rust program): [0] authority (signer),
 * [1] vault PDA (derived here), [2..] recipients — all writable.
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
      ...recipients.map((r) => ({
        pubkey: r.to,
        isSigner: false,
        isWritable: true,
      })),
    ],
    data: serializeCpiBatchTransferData(recipients),
  });
}

/** Result of a confirmed `batch_transfer`. */
export interface CpiBatchTransferResult {
  signature: string;
  slot: number;
  feeLamports: number;
  /** Vault PDA the lamports were paid from. */
  vault: string;
  recipientCount: number;
  /** Sum of all lamports paid out. */
  totalLamports: bigint;
}

export interface CpiBatchTransferOptions {
  /** Explicit mainnet confirmation, forwarded to sendWithRetry. */
  allowMainnet?: boolean;
  /** Confirm/retry policy override forwarded to sendWithRetry. */
  policy?: Partial<ConfirmPolicy>;
}

/**
 * Execute a CPI batch transfer: derive the vault PDA, build the
 * `batch_transfer` instruction, sign and send through sendWithRetry.
 * The on-chain program pays every recipient from the vault in one atomic
 * transaction — one signature covers N payouts.
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
  const { blockhash } = await conn.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: from.publicKey,
    recentBlockhash: blockhash,
    instructions: [instruction],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([from]);

  const sent = await conn.sendWithRetry(tx, {
    allowMainnet: opts.allowMainnet,
    policy: opts.policy,
  });
  return {
    signature: sent.signature,
    slot: sent.slot,
    feeLamports: sent.feeLamports,
    vault: findCpiVaultPda(programId).vault.toBase58(),
    recipientCount: recipients.length,
    totalLamports: recipients.reduce((sum, r) => sum + BigInt(r.lamports), 0n),
  };
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
  if (conn.cluster === "mainnet-beta" && !opts.allowMainnet) {
    throw new MainnetNotAllowedError(conn.cluster, "deploy a BPF program");
  }

  const programBytes = Buffer.isBuffer(soBytesOrPath)
    ? soBytesOrPath
    : Buffer.from(
        typeof soBytesOrPath === "string"
          ? await readFile(soBytesOrPath)
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
    const { blockhash } = await rpc.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [...instructions],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([...signers]);
    return (await conn.sendWithRetry(tx, { policy: opts.policy })).signature;
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
