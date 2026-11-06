/**
 * ClusterConnection — wraps @solana/web3.js Connection with:
 *  - cluster awareness (devnet/testnet/mainnet/custom)
 *  - health checks & restricted airdrops
 *  - a configurable confirm/retry policy (sendWithRetry)
 *  - a mainnet-beta safety guard (allowMainnet)
 */
import {
  Connection,
  SolanaJSONRPCError,
  TransactionExpiredBlockheightExceededError,
  TransactionExpiredTimeoutError,
  type SendOptions,
  type VersionedTransaction,
} from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

/** Minimal shape of getRecentPerformanceSamples() entries. */
interface PerfSample {
  samplePeriodSecs: number;
  numTransactions: bigint | number;
}

import { resolveClusterTarget, type Cluster, type ClusterTarget } from "./cluster.js";
import {
  AirdropNotSupportedError,
  MainnetNotAllowedError,
  SolwalletError,
  TransactionSendError,
} from "./errors.js";

/** How a sent transaction is confirmed and retried. */
export interface ConfirmPolicy {
  /** Finality to wait for. `confirmed` is fast; `finalized` is immutable. */
  commitment: "confirmed" | "finalized";
  /** Give up waiting after this long (per attempt). */
  timeoutMs: number;
  /** Max attempts (1 = send once, never retry). */
  retries: number;
  /** Base delay for exponential backoff between attempts. */
  backoffMs: number;
}

export const DEFAULT_CONFIRM_POLICY: ConfirmPolicy = {
  commitment: "confirmed",
  timeoutMs: 30_000,
  retries: 5,
  backoffMs: 500,
};

export interface ClusterConnectionOptions {
  /**
   * Explicit confirmation that mutating operations on mainnet-beta are
   * intended. Can also be passed per-call; per-call wins.
   */
  allowMainnet?: boolean;
  /** Inject a pre-built Connection (used by tests). */
  connection?: Connection;
}

export interface ClusterHealth {
  cluster: Cluster;
  rpcUrl: string;
  slot: number;
  version: string;
  /** Approximate transactions per second from recent performance samples. */
  tps: number;
}

export interface SendResult {
  signature: string;
  slot: number;
  /** Fee in lamports charged for the transaction. */
  feeLamports: number;
  commitment: "confirmed" | "finalized";
}

/** Failure signatures that are deterministic — retrying cannot succeed. */
const DETERMINISTIC_SEND_FAILURES =
  /attempt to debit|accountnotfound|account does not exist|custom program error|insufficient funds|owner.*not match|invalid account|account .* missing|simulation failed.*error/i;

/**
 * Decide whether a failed send attempt should be retried (with exponential
 * backoff handled by the caller: backoffMs * 2^(attempt-1)).
 *
 * Policy (user-specified): exponential backoff, up to 5 attempts by default.
 * Safety rules layered on top:
 *  - On-chain program failures (TRANSACTION_FAILED) are deterministic —
 *    resending wastes RPC quota and cannot succeed.
 *  - Blockhash expiry errors require re-signing with a fresh blockhash,
 *    not resending the same raw transaction.
 *  - RPC 4xx (bad request, etc.) will fail identically — no retry.
 *  - Deterministic simulation failures (unfunded account, missing accounts,
 *    program errors) are detected by message and never retried.
 *  - Everything else (network errors, timeouts, 429/5xx) is retried:
 *    resending the same signed transaction is idempotent (same signature,
 *    cannot double-apply on chain).
 */
export function shouldRetrySend(
  error: unknown,
  attempt: number,
  policy: ConfirmPolicy,
): boolean {
  if (attempt >= policy.retries) return false;

  if (error instanceof TransactionSendError && error.code === "TRANSACTION_FAILED") {
    return false;
  }
  if (
    error instanceof TransactionExpiredBlockheightExceededError ||
    error instanceof TransactionExpiredTimeoutError
  ) {
    return false;
  }
  if (error instanceof SolanaJSONRPCError) {
    return typeof error.code === "number" && (error.code === 429 || error.code >= 500);
  }
  if (error instanceof Error && DETERMINISTIC_SEND_FAILURES.test(error.message)) {
    return false;
  }
  // Plain network failures (fetch TypeError, aborts): safe to retry.
  return true;
}

/** The public RPC faucets return 410 with a pointer to the web faucet. */
function isFaucetClosedError(error: unknown): boolean {
  const text =
    error instanceof Error ? error.message : String(error ?? "");
  return /faucet is closed|410\b|gone/i.test(text);
}

export class ClusterConnection {
  readonly target: ClusterTarget;
  readonly connection: Connection;
  private readonly defaultAllowMainnet: boolean;

  constructor(
    target: ClusterTarget,
    options: ClusterConnectionOptions = {},
  ) {
    this.target = target;
    this.defaultAllowMainnet = options.allowMainnet ?? false;
    this.connection =
      options.connection ??
      new Connection(target.rpcUrl, {
        commitment: "confirmed",
      });
  }

  get cluster(): Cluster {
    return this.target.cluster;
  }

  get rpcUrl(): string {
    return this.target.rpcUrl;
  }

  /** Aggregate health snapshot: slot, node version, approximate TPS. */
  async getHealth(): Promise<ClusterHealth> {
    const [slot, version, samples] = await Promise.all([
      this.connection.getSlot(),
      this.connection.getVersion(),
      this.connection.getRecentPerformanceSamples(10),
    ]);
    return {
      cluster: this.cluster,
      rpcUrl: this.rpcUrl,
      slot,
      version: version["solana-core"] ?? "unknown",
      tps: estimateTps(samples),
    };
  }

  /**
   * Request faucet SOL. Blocked on mainnet-beta only.
   *
   * Allowed: devnet/testnet (public faucets) and custom endpoints — a local
   * `solana-test-validator` HAS a faucet, and provider RPCs (Helius etc.)
   * keep requestAirdrop working. Reality (Nov 2026): the *public* devnet/
   * testnet endpoints return 410; see FAUCET_UNAVAILABLE for remedies.
   *
   * @returns the airdrop transaction signature
   */
  async requestAirdrop(address: PublicKey, lamports: number): Promise<string> {
    if (this.cluster === "mainnet-beta") {
      throw new AirdropNotSupportedError(this.cluster);
    }
    try {
      const signature = await this.connection.requestAirdrop(address, lamports);
      await this.connection.confirmTransaction(signature, "confirmed");
      return signature;
    } catch (error) {
      if (isFaucetClosedError(error)) {
        throw new SolwalletError(
          `The ${this.cluster} RPC faucet is closed (public endpoints no longer serve airdrops).`,
          {
            code: "FAUCET_UNAVAILABLE",
            hint: "Three ways to get test SOL: (1) request at https://faucet.solana.com (GitHub-verified, pastes the address there), (2) pass a provider RPC URL (e.g. Helius) directly as the cluster parameter — they keep the faucet enabled, (3) import an already-funded wallet with import_wallet.",
          },
        );
      }
      throw error;
    }
  }

  /**
   * Send a signed transaction under the confirm policy, guarding mainnet.
   */
  async sendWithRetry(
    signedTx: VersionedTransaction,
    options: {
      policy?: Partial<ConfirmPolicy>;
      allowMainnet?: boolean;
      sendOptions?: SendOptions;
    } = {},
  ): Promise<SendResult> {
    const policy: ConfirmPolicy = { ...DEFAULT_CONFIRM_POLICY, ...options.policy };
    this.guardMainnet("send a transaction", options.allowMainnet);

    const raw = signedTx.serialize();
    let lastError: unknown;

    for (let attempt = 1; attempt <= policy.retries; attempt++) {
      try {
        const signature = await this.connection.sendRawTransaction(raw, options.sendOptions);
        const latest = await this.connection.getLatestBlockhash(policy.commitment);
        const confirmation = await this.connection.confirmTransaction(
          { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
          policy.commitment,
        );
        const status = confirmation.value;
        const slot = confirmation.context.slot;
        if (status.err) {
          throw new TransactionSendError(
            `Transaction failed on-chain: ${JSON.stringify(status.err)}`,
            { code: "TRANSACTION_FAILED", signature, hint: "Inspect the program error; simulate with dryRun before resending." },
          );
        }
        const fee = (await this.connection.getFeeForMessage(
          signedTx.message,
          policy.commitment,
        )).value ?? 0n;
        return {
          signature,
          slot,
          feeLamports: Number(fee),
          commitment: policy.commitment,
        };
      } catch (error) {
        lastError = error;
        if (!shouldRetrySend(error, attempt, policy)) break;
        await sleep(policy.backoffMs * 2 ** (attempt - 1));
      }
    }

    const signature =
      lastError instanceof TransactionSendError ? lastError.signature : undefined;
    throw new TransactionSendError(
      `Send failed after ${policy.retries} attempt(s): ${describe(lastError)}`,
      {
        code: "SEND_FAILED",
        signature,
        hint: "Check RPC health (getHealth), blockhash freshness, and account balances, then retry.",
        cause: lastError,
      },
    );
  }

  /** Throw unless mainnet usage was explicitly acknowledged. */
  private guardMainnet(operation: string, allowMainnet?: boolean): void {
    if (this.cluster === "mainnet-beta") {
      const allowed = allowMainnet ?? this.defaultAllowMainnet;
      if (!allowed) throw new MainnetNotAllowedError(this.cluster, operation);
    }
  }
}

/** Mean TPS across recent performance samples (0 when samples are missing). */
function estimateTps(samples: readonly PerfSample[]): number {
  if (samples.length === 0) return 0;
  const totalTx = samples.reduce((sum, s) => sum + Number(s.numTransactions), 0);
  const totalSecs = samples.reduce((sum, s) => sum + s.samplePeriodSecs, 0);
  return totalSecs > 0 ? Math.round(totalTx / totalSecs) : 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create a ClusterConnection from a cluster name or RPC URL. */
export function createConnection(
  target: Cluster | string,
  options: ClusterConnectionOptions = {},
): ClusterConnection {
  return new ClusterConnection(resolveClusterTarget(target), options);
}
