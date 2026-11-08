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
import bs58 from "bs58";

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
  /**
   * Give up waiting for confirmation after this long. The transaction is
   * NOT resent on timeout — it may still land; the error carries the
   * signature so callers can poll its status.
   */
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

/**
 * Genesis hash of mainnet-beta. Custom RPC endpoints (Helius, QuickNode,
 * private nodes…) are probed against it so the mainnet guard cannot be
 * bypassed by passing a mainnet provider URL instead of "mainnet-beta".
 */
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export interface ClusterConnectionOptions {
  /**
   * Explicit confirmation that mutating operations on mainnet-beta are
   * intended. Can also be passed per-call; per-call wins.
   */
  allowMainnet?: boolean;
  /** Inject a pre-built Connection (used by tests). */
  connection?: Connection;
  /**
   * Explicit websocket endpoint. web3.js derives it from the RPC URL as
   * "port + 1", which is wrong when the RPC is reached through a reverse
   * proxy (e.g. the web dev server forwarding /rpc and /rpc-ws).
   */
  wsEndpoint?: string;
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

/**
 * The RPC rejects a resend of a transaction that already landed with
 * "This transaction has already been processed" (preflight) — that means the
 * earlier attempt succeeded, so the caller should confirm, not fail.
 */
export function isAlreadyProcessedError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  const logs = (error as { logs?: string[] } | null)?.logs?.join("\n") ?? "";
  const txMsg =
    (error as { transactionError?: { message?: string } } | null)?.transactionError
      ?.message ?? "";
  return /already (been )?processed|AlreadyProcessed/i.test(
    `${text}\n${logs}\n${txMsg}`,
  );
}

export class ClusterConnection {
  readonly target: ClusterTarget;
  readonly connection: Connection;
  private readonly defaultAllowMainnet: boolean;
  /** Cached genesis-hash probe for custom endpoints (one RPC call per instance). */
  private mainnetProbe?: Promise<boolean>;

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
        wsEndpoint: options.wsEndpoint,
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
    if (await this.isMainnet()) {
      throw new AirdropNotSupportedError(this.clusterLabel());
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
   * Whether this connection talks to mainnet-beta. Official targets are
   * known statically; `custom` endpoints are probed once via getGenesisHash
   * (cached). A failed probe is treated conservatively: it throws, so a
   * mutating call never proceeds against an endpoint of unknown identity.
   */
  async isMainnet(): Promise<boolean> {
    if (this.cluster === "mainnet-beta") return true;
    if (this.cluster !== "custom") return false;
    this.mainnetProbe ??= this.connection.getGenesisHash().then(
      (hash) => hash === MAINNET_GENESIS_HASH,
      (error: unknown) => {
        this.mainnetProbe = undefined; // allow a later retry
        throw new SolwalletError(
          `Could not identify the cluster behind custom RPC ${this.rpcUrl} (getGenesisHash failed): ${describe(error)}`,
          {
            code: "CLUSTER_UNIDENTIFIED",
            hint: "Mutating operations on a custom RPC are refused until its genesis hash can be checked against mainnet-beta. Check RPC health (getHealth) and retry, or pass an official cluster name.",
            cause: error,
          },
        );
      },
    );
    return this.mainnetProbe;
  }

  /**
   * Send a signed transaction under the confirm policy, guarding mainnet.
   *
   * Only the send itself (sendRawTransaction) is retried — resending the
   * same signed bytes is idempotent on chain. Confirmation runs exactly once
   * against the transaction's own blockhash, bounded by `policy.timeoutMs`;
   * any failure after the send carries the signature so callers can poll.
   *
   * Expiry detection needs the `lastValidBlockHeight` that came with the
   * transaction's blockhash: pass it when you fetched the blockhash yourself
   * (BLOCKHASH_EXPIRED is raised as soon as the chain passes that height).
   * Without it — e.g. a raw transaction built elsewhere — the signature is
   * polled together with `isBlockhashValid`, and BLOCKHASH_EXPIRED is raised
   * once the blockhash is no longer valid and the signature has no status.
   */
  async sendWithRetry(
    signedTx: VersionedTransaction,
    options: {
      policy?: Partial<ConfirmPolicy>;
      allowMainnet?: boolean;
      sendOptions?: SendOptions;
      /**
       * `lastValidBlockHeight` from the getLatestBlockhash call that produced
       * `signedTx.message.recentBlockhash`. Never substitute a freshly fetched
       * one — it would belong to a different blockhash.
       */
      lastValidBlockHeight?: number;
    } = {},
  ): Promise<SendResult> {
    const policy: ConfirmPolicy = { ...DEFAULT_CONFIRM_POLICY, ...options.policy };
    await this.guardMainnet("send a transaction", options.allowMainnet);

    const raw = signedTx.serialize();

    // --- phase 1: send (retried per policy)
    let signature: string | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= policy.retries; attempt++) {
      try {
        signature = await this.connection.sendRawTransaction(raw, options.sendOptions);
        break;
      } catch (error) {
        if (isAlreadyProcessedError(error)) {
          // An earlier attempt landed; the RPC refuses duplicates. Confirm it.
          signature = signatureOf(signedTx);
          if (signature !== undefined) break;
        }
        lastError = error;
        if (!shouldRetrySend(error, attempt, policy)) break;
        await sleep(policy.backoffMs * 2 ** (attempt - 1));
      }
    }
    if (signature === undefined) {
      throw new TransactionSendError(
        `Send failed after ${policy.retries} attempt(s): ${describe(lastError)}`,
        {
          code: "SEND_FAILED",
          hint: "Check RPC health (getHealth), blockhash freshness, and account balances, then retry.",
          cause: lastError,
        },
      );
    }

    // --- phase 2: confirm once (never resend). Expiry is judged against the
    // transaction's own blockhash: with the caller's lastValidBlockHeight via
    // web3's blockheight strategy, otherwise by polling isBlockhashValid.
    const blockhash = signedTx.message.recentBlockhash;
    let confirmation: Confirmation;
    try {
      confirmation =
        options.lastValidBlockHeight !== undefined
          ? await confirmWithTimeout(
              this.connection,
              { signature, blockhash, lastValidBlockHeight: options.lastValidBlockHeight },
              policy,
            )
          : await confirmByPolling(this.connection, signature, blockhash, policy);
    } catch (error) {
      if (error instanceof TransactionSendError) throw error;
      if (error instanceof TransactionExpiredBlockheightExceededError) {
        throw blockhashExpiredError(signature, blockhash, error);
      }
      throw new TransactionSendError(
        `Transaction ${signature} was sent but confirmation failed: ${describe(error)}`,
        {
          code: "SEND_FAILED",
          signature,
          hint: "The transaction was submitted and may still land. Poll its status by signature (getSignatureStatuses / explorer) before rebuilding or resending.",
          cause: error,
        },
      );
    }

    const status = confirmation.value;
    const slot = confirmation.context.slot;
    if (status.err) {
      throw new TransactionSendError(
        `Transaction failed on-chain: ${JSON.stringify(status.err)}`,
        { code: "TRANSACTION_FAILED", signature, hint: "Inspect the program error; simulate with dryRun before resending." },
      );
    }

    // Fee lookup is informational — never fail a landed transaction over it.
    let feeLamports = 0;
    try {
      const fee = await this.connection.getFeeForMessage(signedTx.message, policy.commitment);
      feeLamports = Number(fee.value ?? 0);
    } catch {
      feeLamports = 0;
    }
    return {
      signature,
      slot,
      feeLamports,
      commitment: policy.commitment,
    };
  }

  /** Throw unless mainnet usage was explicitly acknowledged. */
  private async guardMainnet(operation: string, allowMainnet?: boolean): Promise<void> {
    if (!(await this.isMainnet())) return;
    const allowed = allowMainnet ?? this.defaultAllowMainnet;
    if (!allowed) throw new MainnetNotAllowedError(this.clusterLabel(), operation);
  }

  /** "mainnet-beta", or "custom(mainnet-beta)" for a probed custom endpoint. */
  private clusterLabel(): string {
    return this.cluster === "custom" ? "custom(mainnet-beta)" : this.cluster;
  }
}

/** Base58 signature of a signed transaction (undefined if unsigned). */
function signatureOf(tx: VersionedTransaction): string | undefined {
  const sig = tx.signatures?.[0];
  return sig && sig.length > 0 ? bs58.encode(sig) : undefined;
}

/** What both confirmation strategies resolve to (subset of web3's RpcResponseAndContext<SignatureResult>). */
interface Confirmation {
  context: { slot: number };
  value: { err: unknown };
}

function confirmTimeoutError(signature: string, policy: ConfirmPolicy): TransactionSendError {
  return new TransactionSendError(
    `Transaction ${signature} was sent but not confirmed within ${policy.timeoutMs} ms.`,
    {
      code: "SEND_FAILED",
      signature,
      hint: "The transaction may still land before its blockhash expires. Poll its status by signature before rebuilding; do not resend the same bytes blindly.",
    },
  );
}

function blockhashExpiredError(signature: string, blockhash: string, cause?: unknown): TransactionSendError {
  return new TransactionSendError(
    `Transaction ${signature} expired: blockhash ${blockhash} is no longer valid and the transaction never landed.`,
    {
      code: "BLOCKHASH_EXPIRED",
      signature,
      hint: "Rebuild the transaction with a fresh blockhash and resend; do not retry the same signed bytes. Check the signature once (getSignatureStatuses) in case it landed at the last moment.",
      cause,
    },
  );
}

/**
 * confirmTransaction bounded by policy.timeoutMs. On timeout the pending
 * confirmation is aborted and a TransactionSendError with the signature is
 * thrown — the transaction is never resent.
 */
async function confirmWithTimeout(
  connection: Connection,
  strategy: { signature: string; blockhash: string; lastValidBlockHeight: number },
  policy: ConfirmPolicy,
): Promise<Confirmation> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject first so the race settles on the timeout error, then abort
      // the in-flight confirmation so web3.js stops polling.
      reject(confirmTimeoutError(strategy.signature, policy));
      controller.abort();
    }, policy.timeoutMs);
  });
  try {
    return await Promise.race([
      connection.confirmTransaction(
        { ...strategy, abortSignal: controller.signal },
        policy.commitment,
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function reachedCommitment(
  status: string | undefined,
  commitment: ConfirmPolicy["commitment"],
): boolean {
  if (status === "finalized") return true;
  return commitment === "confirmed" && status === "confirmed";
}

/**
 * Confirmation without a known lastValidBlockHeight: poll the signature's
 * status until it reaches the policy commitment. While it has no status at
 * all, `isBlockhashValid` decides expiry — once the blockhash is gone the
 * transaction can never land, so BLOCKHASH_EXPIRED is raised immediately
 * instead of waiting out the timeout.
 */
async function confirmByPolling(
  connection: Connection,
  signature: string,
  blockhash: string,
  policy: ConfirmPolicy,
): Promise<Confirmation> {
  const deadline = Date.now() + policy.timeoutMs;
  const interval = Math.min(1_000, Math.max(policy.backoffMs, 1));
  type Status = { slot: number; err: unknown; confirmationStatus?: string } | null | undefined;
  const lookup = async (): Promise<{ status: Status; done: Confirmation | null }> => {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status: Status = value[0];
    const done =
      status && reachedCommitment(status.confirmationStatus, policy.commitment)
        ? { context: { slot: status.slot }, value: { err: status.err } }
        : null;
    return { status, done };
  };
  let seen = false; // the signature has been processed at least once
  for (;;) {
    const first = await lookup();
    if (first.done) return first.done;
    if (first.status) {
      seen = true;
    } else if (!(await connection.isBlockhashValid(blockhash, { commitment: policy.commitment })).value) {
      // Re-check once: the transaction may have landed between the two calls.
      const late = await lookup();
      if (late.done) return late.done;
      if (late.status) seen = true;
      if (!seen) throw blockhashExpiredError(signature, blockhash);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw confirmTimeoutError(signature, policy);
    await sleep(Math.min(interval, remaining));
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
