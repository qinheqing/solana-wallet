/**
 * Wallet balance queries — SOL plus SPL Token and Token-2022 accounts.
 *
 * Both token programs are queried separately: a wallet's assets can live
 * under Tokenkeg… (classic SPL) or TokenzQd… (Token-2022), and neither RPC
 * filter covers both at once.
 */
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import type { ClusterConnection } from "../connection/connection.js";

export type TokenProgram = "spl-token" | "token-2022";

export interface TokenBalance {
  mint: string;
  /** Associated/derived token account holding the funds. */
  tokenAccount: string;
  /** Raw amount in base units (string to avoid precision loss). */
  amount: string;
  decimals: number;
  /**
   * DISPLAY ONLY (float, lossy). Optional: core never computes with it and
   * the MCP layer strips it; only UI code may read it.
   */
  uiAmount?: number | null;
  program: TokenProgram;
}

export interface WalletBalance {
  address: string;
  solLamports: number;
  /** SOL with 9-decimal precision — display only. */
  solUi: number;
  tokens: TokenBalance[];
}

async function tokenBalancesForProgram(
  conn: ClusterConnection,
  owner: PublicKey,
  program: TokenProgram,
  programId: PublicKey,
): Promise<Map<string, TokenBalance>> {
  const response = await conn.connection.getParsedTokenAccountsByOwner(
    owner,
    { programId },
    "confirmed",
  );

  const byMint = new Map<string, TokenBalance>();
  for (const { pubkey, account } of response.value) {
    const info = account.data.parsed?.info;
    if (!info) continue;
    const amount = info.tokenAmount as {
      amount: string;
      decimals: number;
      uiAmount: number | null;
    };
    const mint = info.mint as string;
    const existing = byMint.get(mint);
    if (existing) {
      // Same mint split across several token accounts: aggregate raw amounts.
      existing.amount = (BigInt(existing.amount) + BigInt(amount.amount)).toString();
    } else {
      byMint.set(mint, {
        mint,
        tokenAccount: pubkey.toBase58(),
        amount: amount.amount,
        decimals: amount.decimals,
        uiAmount: amount.uiAmount,
        program,
      });
    }
  }
  return byMint;
}

/** Full wallet snapshot: SOL + all token accounts under both programs. */
export async function getWalletBalance(
  conn: ClusterConnection,
  owner: PublicKey,
): Promise<WalletBalance> {
  const [lamports, spl, token2022] = await Promise.all([
    conn.connection.getBalance(owner, "confirmed"),
    tokenBalancesForProgram(conn, owner, "spl-token", TOKEN_PROGRAM_ID),
    tokenBalancesForProgram(conn, owner, "token-2022", TOKEN_2022_PROGRAM_ID),
  ]);

  // Merge both program result maps; a mint can only exist under one program.
  const tokens = [...spl.values()];
  for (const t of token2022.values()) tokens.push(t);
  tokens.sort((a, b) => (a.mint < b.mint ? -1 : 1));

  return {
    address: owner.toBase58(),
    solLamports: lamports,
    solUi: lamports / 1e9,
    tokens,
  };
}
