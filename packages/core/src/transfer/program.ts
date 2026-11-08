/**
 * Program identification for transfers: which on-chain program owns a mint?
 */
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import type { ClusterConnection } from "../connection/connection.js";
import { SolwalletError } from "../connection/errors.js";

export type TokenProgramKind = "spl-token" | "token-2022";

export interface MintProgram {
  kind: TokenProgramKind;
  programId: PublicKey;
}

/**
 * Identify the token program that owns a mint account by reading its owner.
 * Throws a structured error when the account doesn't exist on this cluster —
 * a common cause is querying the wrong cluster/RPC.
 */
export async function getMintProgram(
  conn: ClusterConnection,
  mint: PublicKey,
): Promise<MintProgram> {
  const info = await conn.connection.getAccountInfo(mint);
  if (!info) {
    throw new SolwalletError(
      `Mint ${mint.toBase58()} not found on cluster "${conn.cluster}".`,
      {
        code: "MINT_NOT_FOUND",
        hint: "Verify the mint address and the connected cluster; a mint that exists on devnet does not exist on mainnet-beta.",
      },
    );
  }
  return mintProgramFromOwner(mint, info.owner);
}

/** Pure half of getMintProgram: classify an already-fetched mint by its owner (throws NOT_A_MINT). */
export function mintProgramFromOwner(mint: PublicKey, ownerKey: PublicKey): MintProgram {
  const owner = ownerKey.toBase58();
  if (owner === TOKEN_PROGRAM_ID.toBase58()) {
    return { kind: "spl-token", programId: TOKEN_PROGRAM_ID };
  }
  if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) {
    return { kind: "token-2022", programId: TOKEN_2022_PROGRAM_ID };
  }
  throw new SolwalletError(
    `Account ${mint.toBase58()} is not a token mint (owned by ${owner}).`,
    {
      code: "NOT_A_MINT",
      hint: "Pass the mint address of an SPL Token or Token-2022 mint, or omit `mint` to transfer native SOL.",
    },
  );
}
