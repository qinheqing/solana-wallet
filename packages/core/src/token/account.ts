/**
 * Token accounts at arbitrary (non-associated) addresses:
 * SystemProgram.createAccount + InitializeAccount3, sized for the mint's
 * program — SPL's fixed ACCOUNT_SIZE, or for Token-2022 the length that
 * includes every account extension the mint's extensions require.
 */
import {
  ACCOUNT_SIZE,
  createInitializeAccount3Instruction,
  getAccountLenForMint,
  getMint,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import type { ClusterConnection } from "../connection/connection.js";
import { getMintProgram, type TokenProgramKind } from "../transfer/program.js";
import { signAndSendTokenTx, toPublicKey, type SendTokenOptions, type TokenTxResult } from "./internal.js";

export interface CreateTokenAccountParams {
  mint: string | PublicKey;
  /** Token-account owner (authority over the balance). Default: the payer. */
  owner?: string | PublicKey;
  /** Keypair whose address becomes the account. Default: freshly generated. */
  account?: Keypair;
}

export interface CreateTokenAccountResult extends TokenTxResult {
  /** Address of the new token account. */
  address: string;
  owner: string;
  mint: string;
  program: TokenProgramKind;
  /** Bytes allocated (includes Token-2022 account extensions). */
  space: number;
  /** Rent-exempt lamports funded by the payer. */
  rentLamports: number;
}

/**
 * Create and initialize a token account for `mint` at a non-ATA address.
 * The payer funds rent and signs together with the new account keypair.
 */
export async function createTokenAccount(
  conn: ClusterConnection,
  payer: Keypair,
  params: CreateTokenAccountParams,
  opts: SendTokenOptions = {},
): Promise<CreateTokenAccountResult> {
  const mint = toPublicKey(params.mint);
  const owner = params.owner ? toPublicKey(params.owner) : payer.publicKey;
  const account = params.account ?? Keypair.generate();
  const program = await getMintProgram(conn, mint);

  const space =
    program.kind === "token-2022"
      ? getAccountLenForMint(await getMint(conn.connection, mint, "confirmed", program.programId))
      : ACCOUNT_SIZE;
  const rentLamports = await conn.connection.getMinimumBalanceForRentExemption(space);

  const instructions = [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: account.publicKey,
      space,
      lamports: rentLamports,
      programId: program.programId,
    }),
    createInitializeAccount3Instruction(account.publicKey, mint, owner, program.programId),
  ];
  const res = await signAndSendTokenTx(conn, payer, instructions, { ...opts, extraSigners: [account] });
  return {
    ...res,
    address: account.publicKey.toBase58(),
    owner: owner.toBase58(),
    mint: mint.toBase58(),
    program: program.kind,
    space,
    rentLamports,
  };
}
