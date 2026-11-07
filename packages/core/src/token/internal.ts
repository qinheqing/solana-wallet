/**
 * Internal helpers shared by token creation (task #8) and Token-2022
 * runtime management (task #9): shared send pipeline + program guards.
 */
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import type { ClusterConnection, ConfirmPolicy } from "../connection/connection.js";
import { SolwalletError } from "../connection/errors.js";
import { dryRun } from "../transfer/dryrun.js";
import { getMintProgram } from "../transfer/program.js";

export interface SendTokenOptions {
  /** Simulate only — nothing is sent on chain. */
  dryRun?: boolean;
  /** Explicit mainnet confirmation, forwarded to sendWithRetry. */
  allowMainnet?: boolean;
  /** Confirm/retry policy override forwarded to sendWithRetry. */
  policy?: Partial<ConfirmPolicy>;
}

export interface TokenTxResult {
  /** Empty for simulated transactions. */
  signature: string;
  slot: number;
  /** Fee in lamports (0 for simulations). */
  feeLamports: number;
  simulatedOnly: boolean;
  /** Populated by dryRun: full simulation logs. */
  logs?: string[];
  unitsConsumed?: number;
}

/**
 * Sign a mint-creation/management instruction set with the payer (and any
 * extra signers, e.g. the fresh mint keypair) and send it through
 * sendWithRetry (mainnet guard included), or simulate it on dryRun.
 */
export async function signAndSendTokenTx(
  conn: ClusterConnection,
  from: Keypair,
  instructions: TransactionInstruction[],
  opts: SendTokenOptions & { extraSigners?: Keypair[] } = {},
): Promise<TokenTxResult> {
  const { blockhash } = await conn.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: from.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([from, ...(opts.extraSigners ?? [])]);

  if (opts.dryRun) {
    const sim = await dryRun(conn, tx);
    return {
      signature: "",
      slot: 0,
      feeLamports: 0,
      simulatedOnly: true,
      logs: sim.logs,
      unitsConsumed: sim.unitsConsumed,
    };
  }

  const sent = await conn.sendWithRetry(tx, {
    allowMainnet: opts.allowMainnet,
    policy: opts.policy,
  });
  return {
    signature: sent.signature,
    slot: sent.slot,
    feeLamports: sent.feeLamports,
    simulatedOnly: false,
  };
}

/** Resolve a mint and require it is owned by the Token-2022 program. */
export async function requireToken2022(
  conn: ClusterConnection,
  mint: PublicKey,
): Promise<void> {
  const program = await getMintProgram(conn, mint);
  if (program.kind !== "token-2022") {
    throw new SolwalletError(
      `Mint ${mint.toBase58()} is a classic SPL Token mint — this operation is Token-2022 only.`,
      {
        code: "TOKEN_PROGRAM_MISMATCH",
        hint: "Token-2022 extensions (transfer fee, on-chain metadata, account-state management…) exist only on TOKEN_2022_PROGRAM_ID mints. Create the mint with createToken2022(), or use the SPL-compatible operation instead.",
      },
    );
  }
}

/** Parse a string-or-PublicKey address (MCP tools pass base58 strings). */
export function toPublicKey(value: string | PublicKey): PublicKey {
  return typeof value === "string" ? new PublicKey(value) : value;
}
