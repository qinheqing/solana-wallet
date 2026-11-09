/**
 * Human-readable summary of what a Squads vault transaction will do when
 * executed: SOL transfers, SPL / Token-2022 transfers (with the recipient
 * wallet when the message also creates its ATA), or "other" instructions.
 * Pure decoding over the stored message — no RPC.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { SystemProgram, type PublicKey } from "@solana/web3.js";

export type ProposalAction =
  | {
      kind: "sol";
      from: string;
      to: string;
      /** Lamports (string). */
      amount: string;
    }
  | {
      kind: "token";
      program: "spl-token" | "token-2022";
      /** Mint, when the instruction carries it (transferChecked). */
      mint: string | null;
      /** Destination token account. */
      destinationAccount: string;
      /** Recipient wallet, when known (ATA created in the same message). */
      destinationOwner: string | null;
      /** Raw base units (string). */
      amount: string;
      decimals: number | null;
    }
  | { kind: "createAta"; ata: string; owner: string; mint: string }
  | { kind: "other"; programId: string; dataLength: number };

export interface CompiledMessageLike {
  accountKeys: PublicKey[];
  instructions: Array<{ programIdIndex: number; accountIndexes: Uint8Array | number[]; data: Uint8Array | number[] }>;
}

const SPL = TOKEN_PROGRAM_ID.toBase58();
const T22 = TOKEN_2022_PROGRAM_ID.toBase58();
const ATA = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
const SYSTEM = SystemProgram.programId.toBase58();

function u64(data: Uint8Array, offset: number): string | null {
  if (data.length < offset + 8) return null;
  return Buffer.from(data).readBigUInt64LE(offset).toString();
}

export function describeVaultMessage(message: CompiledMessageLike): ProposalAction[] {
  const keys = message.accountKeys.map((k) => k.toBase58());
  const raw = message.instructions.map((ix) => ({
    programId: keys[ix.programIdIndex] ?? "?",
    accounts: Array.from(ix.accountIndexes).map((i) => keys[i] ?? "?"),
    data: Uint8Array.from(ix.data),
  }));

  // ATA → owner, from create-ATA instructions (accounts: payer, ata, owner, mint, …)
  const ataOwner = new Map<string, string>();
  for (const ix of raw) {
    if (ix.programId === ATA && ix.accounts.length >= 4) ataOwner.set(ix.accounts[1]!, ix.accounts[2]!);
  }

  const out: ProposalAction[] = [];
  for (const ix of raw) {
    const d = ix.data;
    if (ix.programId === SYSTEM && d.length >= 12 && Buffer.from(d).readUInt32LE(0) === 2) {
      out.push({ kind: "sol", from: ix.accounts[0] ?? "?", to: ix.accounts[1] ?? "?", amount: u64(d, 4) ?? "0" });
      continue;
    }
    if ((ix.programId === SPL || ix.programId === T22) && d.length >= 9) {
      const program = ix.programId === T22 ? "token-2022" : "spl-token";
      if (d[0] === 12 && ix.accounts.length >= 3) {
        // TransferChecked: [source, mint, destination, owner]; data: amount u64, decimals u8
        const dest = ix.accounts[2]!;
        out.push({
          kind: "token",
          program,
          mint: ix.accounts[1]!,
          destinationAccount: dest,
          destinationOwner: ataOwner.get(dest) ?? null,
          amount: u64(d, 1) ?? "0",
          decimals: d.length >= 10 ? d[9]! : null,
        });
        continue;
      }
      if (d[0] === 3 && ix.accounts.length >= 2) {
        // Transfer: [source, destination, owner]
        const dest = ix.accounts[1]!;
        out.push({
          kind: "token",
          program,
          mint: null,
          destinationAccount: dest,
          destinationOwner: ataOwner.get(dest) ?? null,
          amount: u64(d, 1) ?? "0",
          decimals: null,
        });
        continue;
      }
    }
    if (ix.programId === ATA && ix.accounts.length >= 4) {
      out.push({ kind: "createAta", ata: ix.accounts[1]!, owner: ix.accounts[2]!, mint: ix.accounts[3]! });
      continue;
    }
    out.push({ kind: "other", programId: ix.programId, dataLength: d.length });
  }
  return out;
}

