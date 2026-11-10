/**
 * Shared plumbing for the example scripts: environment, keypair loading,
 * funding on a local validator, and the JSON report printed to stdout.
 *
 * Environment:
 *   SOLWALLET_RPC_URL   RPC endpoint (default http://127.0.0.1:8899 = solana-test-validator)
 *   SOLWALLET_KEYPAIR   solana-keygen JSON keyfile of the payer (default ~/.config/solana/id.json)
 *
 * Nothing secret is ever printed: reports carry addresses, signatures and
 * explorer links only. Logs go to stderr so stdout stays valid JSON.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Keypair, LAMPORTS_PER_SOL, type PublicKey } from "@solana/web3.js";
import {
  createConnection,
  explorerUrl,
  formatAmount,
  parseKeypairJson,
  shortAddress,
  type ClusterConnection,
  type ParsedProgramError,
} from "@sol-wallet/core";

export const RPC_URL = process.env.SOLWALLET_RPC_URL ?? "http://127.0.0.1:8899";
export const KEYPAIR_PATH =
  process.env.SOLWALLET_KEYPAIR ?? join(homedir(), ".config", "solana", "id.json");

/** Minimum SOL a signer needs for a handful of mint/realloc/transfer fees. */
const MIN_BALANCE_LAMPORTS = 0.5 * LAMPORTS_PER_SOL;
const AIRDROP_LAMPORTS = 2 * LAMPORTS_PER_SOL;

export function log(message: string): void {
  process.stderr.write(`[example] ${message}\n`);
}

export function short(address: string | PublicKey): string {
  return shortAddress(address);
}

export function connect(): ClusterConnection {
  log(`rpc ${RPC_URL}`);
  return createConnection(RPC_URL);
}

export async function loadPayer(): Promise<Keypair> {
  const text = await readFile(KEYPAIR_PATH, "utf8");
  const payer = parseKeypairJson(text);
  log(`payer ${short(payer.publicKey)} (from ${KEYPAIR_PATH})`);
  return payer;
}

/**
 * Top the account up from the faucet when it is below the minimum. Works on
 * solana-test-validator and provider RPCs; the public devnet faucet is closed
 * (FAUCET_UNAVAILABLE) — fund the keypair by hand in that case.
 */
export async function ensureFunded(conn: ClusterConnection, who: Keypair, label: string): Promise<void> {
  const balance = await conn.connection.getBalance(who.publicKey, "confirmed");
  if (balance >= MIN_BALANCE_LAMPORTS) {
    log(`${label} ${short(who.publicKey)} has ${balance / LAMPORTS_PER_SOL} SOL`);
    return;
  }
  log(`${label} ${short(who.publicKey)} low (${balance / LAMPORTS_PER_SOL} SOL); requesting airdrop`);
  await conn.requestAirdrop(who.publicKey, AIRDROP_LAMPORTS);
}

/**
 * Reading aid for the JSON reports: raw base units stay in the primary
 * field; this gives the "1.5 (6 dp)" / "0.01 SOL" sibling, exactly like the
 * MCP `*Display` fields. Null-safe so missing movement fields stay null.
 */
export function displayAmount(raw: bigint | string | number | null | undefined, decimals: number, symbol?: string): string | null {
  if (raw === null || raw === undefined) return null;
  const formatted = formatAmount(BigInt(raw), decimals);
  return symbol ? `${formatted} ${symbol}` : `${formatted} (${decimals} dp)`;
}

/** `{ signature, explorerUrl }` pair for any confirmed signature. */
export function txRef(conn: ClusterConnection, signature: string): { signature: string; explorerUrl: string | null } {
  return { signature, explorerUrl: explorerUrl(signature, { cluster: conn.cluster, rpcUrl: conn.rpcUrl }) };
}

/** Throw when a core result object carries an in-band `error`. */
export function assertOk<T extends { error?: ParsedProgramError }>(step: string, result: T): T {
  if (result.error) {
    throw new Error(`${step} failed: [${result.error.code}] ${result.error.message} — ${result.error.suggestion}`);
  }
  return result;
}

/** Throw when an expectation about the chain does not hold; the report says which. */
export function expect(condition: boolean, what: string): void {
  if (!condition) throw new Error(`expectation failed: ${what}`);
}

/** Print the report as JSON (bigint-safe) and exit non-zero on failure. */
export function emit(report: Record<string, unknown>, ok = true): void {
  process.stdout.write(
    JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n",
  );
  if (!ok) process.exitCode = 1;
}

/** Run an example: print the JSON report, or a JSON error with the steps completed so far. */
export async function runExample(
  name: string,
  body: (steps: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const steps: Record<string, unknown> = {};
  try {
    await body(steps);
    emit({ example: name, ok: true, rpcUrl: RPC_URL, steps });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`FAILED: ${message}`);
    emit({ example: name, ok: false, rpcUrl: RPC_URL, error: message, steps }, false);
  }
}
