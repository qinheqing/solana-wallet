import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { describeVaultMessage } from "./describe.js";

/** Compile instructions into the {accountKeys, instructions} shape Squads stores. */
function compile(ixs: TransactionInstruction[]) {
  const keys: PublicKey[] = [];
  const idx = (k: PublicKey) => {
    let i = keys.findIndex((x) => x.equals(k));
    if (i < 0) i = keys.push(k) - 1;
    return i;
  };
  const instructions = ixs.map((ix) => ({
    programIdIndex: idx(ix.programId),
    accountIndexes: Uint8Array.from(ix.keys.map((k) => idx(k.pubkey))),
    data: Uint8Array.from(ix.data),
  }));
  return { accountKeys: keys, instructions };
}

const vault = Keypair.generate().publicKey;
const to = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;

describe("describeVaultMessage", () => {
  it("decodes a SOL transfer", () => {
    const actions = describeVaultMessage(compile([SystemProgram.transfer({ fromPubkey: vault, toPubkey: to, lamports: 123_456n })]));
    expect(actions).toEqual([{ kind: "sol", from: vault.toBase58(), to: to.toBase58(), amount: "123456" }]);
  });

  it("decodes create-ATA + transferChecked and resolves the recipient wallet", () => {
    const srcAta = getAssociatedTokenAddressSync(mint, vault, true, TOKEN_2022_PROGRAM_ID);
    const dstAta = getAssociatedTokenAddressSync(mint, to, true, TOKEN_2022_PROGRAM_ID);
    const actions = describeVaultMessage(
      compile([
        createAssociatedTokenAccountIdempotentInstruction(vault, dstAta, to, mint, TOKEN_2022_PROGRAM_ID),
        createTransferCheckedInstruction(srcAta, mint, dstAta, vault, 5_000n, 6, [], TOKEN_2022_PROGRAM_ID),
      ]),
    );
    expect(actions[0]).toMatchObject({ kind: "createAta", owner: to.toBase58(), mint: mint.toBase58() });
    expect(actions[1]).toEqual({
      kind: "token",
      program: "token-2022",
      mint: mint.toBase58(),
      destinationAccount: dstAta.toBase58(),
      destinationOwner: to.toBase58(),
      amount: "5000",
      decimals: 6,
    });
  });

  it("falls back to 'other' for unknown programs", () => {
    const prog = Keypair.generate().publicKey;
    const actions = describeVaultMessage(compile([{ programId: prog, keys: [], data: Buffer.from([1, 2, 3]) } as TransactionInstruction]));
    expect(actions).toEqual([{ kind: "other", programId: prog.toBase58(), dataLength: 3 }]);
  });
});
