import {
  Keypair,
  PublicKey,
  TransactionExpiredBlockheightExceededError,
  type Connection,
  type VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClusterConnection,
  MAINNET_GENESIS_HASH,
  createConnection,
  type SendResult,
} from "./connection.js";
import {
  AirdropNotSupportedError,
  MainnetNotAllowedError,
  TransactionSendError,
} from "./errors.js";

const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

// Minimal fake of the web3 Connection surface used by ClusterConnection.
function fakeConnection() {
  return {
    getSlot: vi.fn().mockResolvedValue(1234),
    getVersion: vi.fn().mockResolvedValue({ "solana-core": "2.1.0" }),
    getRecentPerformanceSamples: vi.fn().mockResolvedValue([
      { samplePeriodSecs: 60, numTransactions: 3_000_000n },
    ]),
    requestAirdrop: vi.fn().mockResolvedValue("SIG_AIRDROP"),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null }, context: { slot: 1235 } }),
    sendRawTransaction: vi.fn().mockResolvedValue("SIG_TX"),
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: "BH",
      lastValidBlockHeight: 9999,
    }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
    getGenesisHash: vi.fn().mockResolvedValue(DEVNET_GENESIS_HASH),
    // Polling confirmation (no lastValidBlockHeight): landed & confirmed by default.
    getSignatureStatuses: vi.fn().mockResolvedValue({
      context: { slot: 1235 },
      value: [{ slot: 1235, confirmations: 3, err: null, confirmationStatus: "confirmed" }],
    }),
    isBlockhashValid: vi.fn().mockResolvedValue({ context: { slot: 1235 }, value: true }),
  };
}

/** The tx's blockhash paired with the height its producer reported. */
const WITH_HEIGHT = { lastValidBlockHeight: 9999 };

function asConnection(fake: unknown): Connection {
  return fake as unknown as Connection;
}

// We only exercise ClusterConnection's logic, not web3.js crypto — a stub
// transaction with a dummy serialize() is enough.
function stubTx(signature?: Uint8Array): VersionedTransaction {
  return {
    serialize: () => new Uint8Array([1, 2, 3]),
    message: { recentBlockhash: "TX_BLOCKHASH" },
    signatures: signature ? [signature] : [],
  } as unknown as VersionedTransaction;
}

/** Fast policy for retry tests: no real backoff sleeps. */
const FAST = { backoffMs: 1 };

describe("ClusterConnection (devnet)", () => {
  let fake: ReturnType<typeof fakeConnection>;
  let conn: ClusterConnection;

  beforeEach(() => {
    fake = fakeConnection();
    conn = new ClusterConnection(
      { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" },
      { connection: asConnection(fake) },
    );
  });

  it("aggregates health info", async () => {
    const health = await conn.getHealth();
    expect(health.slot).toBe(1234);
    expect(health.version).toBe("2.1.0");
    expect(health.tps).toBe(50_000); // 3_000_000 tx / 60 s
  });

  it("allows airdrop on devnet and confirms it", async () => {
    const sig = await conn.requestAirdrop(Keypair.generate().publicKey, 100);
    expect(sig).toBe("SIG_AIRDROP");
    expect(fake.requestAirdrop).toHaveBeenCalledOnce();
    expect(fake.confirmTransaction).toHaveBeenCalledOnce();
  });

  it("raises FAUCET_UNAVAILABLE with remedies when the RPC faucet is closed", async () => {
    // Real-world behavior (Nov 2026): devnet AND testnet RPC faucets return 410.
    fake.requestAirdrop.mockRejectedValue(
      new Error("410 Gone: The RPC faucet is closed on this cluster."),
    );
    const err = await conn
      .requestAirdrop(Keypair.generate().publicKey, 2_000_000_000)
      .catch((e) => e);
    expect(err.code).toBe("FAUCET_UNAVAILABLE");
    expect(err.hint).toContain("faucet.solana.com");
    expect(err.hint).toContain("cluster parameter");
    expect(err.hint).toContain("import_wallet");
  });

  it("sends transactions and returns fee + slot", async () => {
    const result: SendResult = await conn.sendWithRetry(stubTx());
    expect(result.signature).toBe("SIG_TX");
    expect(result.feeLamports).toBe(5000);
    expect(result.slot).toBe(1235);
    expect(result.commitment).toBe("confirmed");
  });
});

describe("airdrop restriction", () => {
  it.each(["mainnet-beta"] as const)(
    "rejects airdrop on %s without touching RPC",
    async (cluster) => {
      const fake = fakeConnection();
      const c = new ClusterConnection(
        { cluster, rpcUrl: "https://example.com" },
        { connection: asConnection(fake) },
      );
      await expect(
        c.requestAirdrop(PublicKey.default, 100),
      ).rejects.toThrowError(AirdropNotSupportedError);
      expect(fake.requestAirdrop).not.toHaveBeenCalled();
    },
  );
});

describe("mainnet guard (2.4)", () => {
  function mainnetConn(allowMainnet?: boolean) {
    const fake = fakeConnection();
    return {
      fake,
      conn: new ClusterConnection(
        { cluster: "mainnet-beta", rpcUrl: "https://api.mainnet-beta.solana.com" },
        { allowMainnet, connection: asConnection(fake) },
      ),
    };
  }

  it("throws MainnetNotAllowedError without allowMainnet", async () => {
    const { conn } = mainnetConn();
    await expect(conn.sendWithRetry(stubTx())).rejects.toThrowError(
      MainnetNotAllowedError,
    );
  });

  it("never touches the RPC when guarded", async () => {
    const { conn, fake } = mainnetConn();
    await conn.sendWithRetry(stubTx()).catch(() => undefined);
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("proceeds when allowMainnet: true per-instance", async () => {
    const { conn, fake } = mainnetConn(true);
    const result = await conn.sendWithRetry(stubTx());
    expect(result.signature).toBe("SIG_TX");
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("per-call allowMainnet overrides the instance default", async () => {
    const { conn, fake } = mainnetConn(); // instance default: false
    const result = await conn.sendWithRetry(stubTx(), { allowMainnet: true });
    expect(result.signature).toBe("SIG_TX");
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("error message explains the remedy", async () => {
    const { conn } = mainnetConn();
    const err = await conn.sendWithRetry(stubTx()).catch((e) => e);
    expect(err.code).toBe("MAINNET_NOT_ALLOWED");
    expect(err.hint).toContain("allowMainnet: true");
  });
});

describe("mainnet guard via genesis hash (custom RPC)", () => {
  function customConn(genesis: string | Error, allowMainnet?: boolean) {
    const fake = fakeConnection();
    if (genesis instanceof Error) fake.getGenesisHash.mockRejectedValue(genesis);
    else fake.getGenesisHash.mockResolvedValue(genesis);
    return {
      fake,
      conn: new ClusterConnection(
        { cluster: "custom", rpcUrl: "https://mainnet.helius-rpc.com/?api-key=x" },
        { allowMainnet, connection: asConnection(fake) },
      ),
    };
  }

  it("a custom URL pointing at mainnet is guarded like mainnet-beta", async () => {
    const { conn, fake } = customConn(MAINNET_GENESIS_HASH);
    const err = await conn.sendWithRetry(stubTx()).catch((e) => e);
    expect(err).toBeInstanceOf(MainnetNotAllowedError);
    expect(err.message).toContain("custom(mainnet-beta)");
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("proceeds on a mainnet custom URL only with allowMainnet", async () => {
    const { conn, fake } = customConn(MAINNET_GENESIS_HASH);
    const result = await conn.sendWithRetry(stubTx(), { allowMainnet: true });
    expect(result.signature).toBe("SIG_TX");
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("probes the genesis hash once per instance (cached)", async () => {
    const { conn, fake } = customConn(MAINNET_GENESIS_HASH, true);
    await conn.sendWithRetry(stubTx());
    await conn.sendWithRetry(stubTx());
    expect(await conn.isMainnet()).toBe(true);
    expect(fake.getGenesisHash).toHaveBeenCalledOnce();
  });

  it("custom non-mainnet endpoints (localnet / devnet providers) need no acknowledgement", async () => {
    const { conn, fake } = customConn(DEVNET_GENESIS_HASH);
    const result = await conn.sendWithRetry(stubTx());
    expect(result.signature).toBe("SIG_TX");
    expect(fake.getGenesisHash).toHaveBeenCalledOnce();
  });

  it("refuses to send when the genesis hash cannot be fetched (fail closed)", async () => {
    const { conn, fake } = customConn(new Error("fetch failed"));
    const err = await conn.sendWithRetry(stubTx()).catch((e) => e);
    expect(err.code).toBe("CLUSTER_UNIDENTIFIED");
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
    // A failed probe is not cached: the next call probes again and succeeds.
    fake.getGenesisHash.mockResolvedValue(DEVNET_GENESIS_HASH);
    const result = await conn.sendWithRetry(stubTx());
    expect(result.signature).toBe("SIG_TX");
    expect(fake.getGenesisHash).toHaveBeenCalledTimes(2);
  });

  it("blocks airdrops on a mainnet custom URL without touching the faucet", async () => {
    const { conn, fake } = customConn(MAINNET_GENESIS_HASH);
    await expect(conn.requestAirdrop(PublicKey.default, 100)).rejects.toThrowError(
      AirdropNotSupportedError,
    );
    expect(fake.requestAirdrop).not.toHaveBeenCalled();
  });

  it("still allows airdrops on a local validator (custom, non-mainnet)", async () => {
    const { conn, fake } = customConn("FzfX3CtS41ZsS8fWP2YBqeZ7rseX8E8uXzkfzE63Ncx4");
    await expect(conn.requestAirdrop(PublicKey.default, 100)).resolves.toBe("SIG_AIRDROP");
    expect(fake.requestAirdrop).toHaveBeenCalledOnce();
  });

  it("official clusters never probe the genesis hash", async () => {
    const fake = fakeConnection();
    const conn = new ClusterConnection(
      { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" },
      { connection: asConnection(fake) },
    );
    await conn.sendWithRetry(stubTx());
    expect(await conn.isMainnet()).toBe(false);
    expect(fake.getGenesisHash).not.toHaveBeenCalled();
  });
});

describe("sendWithRetry: retry only the send, confirm once", () => {
  let fake: ReturnType<typeof fakeConnection>;
  let conn: ClusterConnection;

  beforeEach(() => {
    fake = fakeConnection();
    conn = new ClusterConnection(
      { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" },
      { connection: asConnection(fake) },
    );
  });

  it("confirms against the transaction's own blockhash with the caller's lastValidBlockHeight", async () => {
    await conn.sendWithRetry(stubTx(), WITH_HEIGHT);
    expect(fake.confirmTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: "SIG_TX",
        blockhash: "TX_BLOCKHASH",
        lastValidBlockHeight: 9999,
      }),
      "confirmed",
    );
    expect(fake.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("never pairs the tx blockhash with a freshly fetched lastValidBlockHeight", async () => {
    // Without the caller's height the blockhash is polled; a fresh
    // getLatestBlockhash would describe a *different* blockhash.
    const result = await conn.sendWithRetry(stubTx(), { policy: FAST });
    expect(result.signature).toBe("SIG_TX");
    expect(result.slot).toBe(1235);
    expect(fake.getLatestBlockhash).not.toHaveBeenCalled();
    expect(fake.confirmTransaction).not.toHaveBeenCalled();
    expect(fake.getSignatureStatuses).toHaveBeenCalledWith(["SIG_TX"]);
  });

  it("retries a failed send with backoff, then confirms once", async () => {
    fake.sendRawTransaction
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce("SIG_TX");
    const result = await conn.sendWithRetry(stubTx(), { policy: FAST, ...WITH_HEIGHT });
    expect(result.signature).toBe("SIG_TX");
    expect(fake.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(fake.confirmTransaction).toHaveBeenCalledOnce();
  });

  it("does NOT resend when the confirmation phase hits a network error", async () => {
    fake.confirmTransaction.mockRejectedValue(new TypeError("fetch failed"));
    const err = await conn.sendWithRetry(stubTx(), { policy: FAST, ...WITH_HEIGHT }).catch((e) => e);
    expect(err).toBeInstanceOf(TransactionSendError);
    expect(err.code).toBe("SEND_FAILED");
    expect(err.signature).toBe("SIG_TX");
    expect(err.message).toContain("SIG_TX");
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("does NOT resend when a status poll fails", async () => {
    fake.getSignatureStatuses.mockRejectedValue(new Error("503 bad gateway"));
    const err = await conn.sendWithRetry(stubTx(), { policy: FAST }).catch((e) => e);
    expect(err.code).toBe("SEND_FAILED");
    expect(err.signature).toBe("SIG_TX");
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("treats 'already processed' as a successful send and confirms it", async () => {
    const sigBytes = new Uint8Array(64).fill(7);
    const expected = bs58.encode(sigBytes);
    fake.sendRawTransaction.mockRejectedValue(
      new Error(
        "failed to send transaction: Transaction simulation failed: This transaction has already been processed",
      ),
    );
    const result = await conn.sendWithRetry(stubTx(sigBytes), { policy: FAST, ...WITH_HEIGHT });
    expect(result.signature).toBe(expected);
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();
    expect(fake.confirmTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ signature: expected, blockhash: "TX_BLOCKHASH" }),
      "confirmed",
    );
  });

  it("gives up with SEND_FAILED (no signature) when every send attempt fails", async () => {
    fake.sendRawTransaction.mockRejectedValue(new TypeError("fetch failed"));
    const err = await conn
      .sendWithRetry(stubTx(), { policy: { ...FAST, retries: 3 } })
      .catch((e) => e);
    expect(err.code).toBe("SEND_FAILED");
    expect(err.signature).toBeUndefined();
    expect(fake.sendRawTransaction).toHaveBeenCalledTimes(3);
    expect(fake.confirmTransaction).not.toHaveBeenCalled();
    expect(fake.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("reports on-chain failure with the signature and no resend (blockheight strategy)", async () => {
    fake.confirmTransaction.mockResolvedValue({
      value: { err: { InstructionError: [0, "Custom"] } },
      context: { slot: 1 },
    });
    const err = await conn.sendWithRetry(stubTx(), { policy: FAST, ...WITH_HEIGHT }).catch((e) => e);
    expect(err.code).toBe("TRANSACTION_FAILED");
    expect(err.signature).toBe("SIG_TX");
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("reports on-chain failure with the signature and no resend (polling strategy)", async () => {
    fake.getSignatureStatuses.mockResolvedValue({
      context: { slot: 2 },
      value: [{ slot: 2, confirmations: 1, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }],
    });
    const err = await conn.sendWithRetry(stubTx(), { policy: FAST }).catch((e) => e);
    expect(err.code).toBe("TRANSACTION_FAILED");
    expect(err.signature).toBe("SIG_TX");
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("a failed fee lookup degrades to feeLamports 0 instead of failing the send", async () => {
    fake.getFeeForMessage.mockRejectedValue(new Error("429 rate limited"));
    const result = await conn.sendWithRetry(stubTx(), WITH_HEIGHT);
    expect(result.signature).toBe("SIG_TX");
    expect(result.feeLamports).toBe(0);
  });

  it("times out confirmation per policy.timeoutMs, aborting it and keeping the signature", async () => {
    let seenSignal: AbortSignal | undefined;
    fake.confirmTransaction.mockImplementation(
      (strategy: { abortSignal?: AbortSignal }) =>
        new Promise((_, reject) => {
          seenSignal = strategy.abortSignal;
          strategy.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const err = await conn
      .sendWithRetry(stubTx(), { policy: { ...FAST, timeoutMs: 20 }, ...WITH_HEIGHT })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TransactionSendError);
    expect(err.code).toBe("SEND_FAILED");
    expect(err.signature).toBe("SIG_TX");
    expect(err.message).toMatch(/not confirmed within 20 ms/);
    expect(seenSignal?.aborted).toBe(true);
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("times out the polling strategy per policy.timeoutMs while the blockhash stays valid", async () => {
    fake.getSignatureStatuses.mockResolvedValue({ context: { slot: 1 }, value: [null] });
    const err = await conn
      .sendWithRetry(stubTx(), { policy: { ...FAST, timeoutMs: 20 } })
      .catch((e) => e);
    expect(err.code).toBe("SEND_FAILED");
    expect(err.signature).toBe("SIG_TX");
    expect(err.message).toMatch(/not confirmed within 20 ms/);
    expect(fake.isBlockhashValid).toHaveBeenCalledWith("TX_BLOCKHASH", { commitment: "confirmed" });
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();
  });
});

describe("sendWithRetry: blockhash expiry → BLOCKHASH_EXPIRED, not a timeout", () => {
  let fake: ReturnType<typeof fakeConnection>;
  let conn: ClusterConnection;

  beforeEach(() => {
    fake = fakeConnection();
    conn = new ClusterConnection(
      { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" },
      { connection: asConnection(fake) },
    );
  });

  it("blockheight strategy: web3's expiry error becomes BLOCKHASH_EXPIRED with the signature", async () => {
    fake.confirmTransaction.mockRejectedValue(new TransactionExpiredBlockheightExceededError("SIG_TX"));
    const err = await conn.sendWithRetry(stubTx(), { policy: FAST, ...WITH_HEIGHT }).catch((e) => e);
    expect(err).toBeInstanceOf(TransactionSendError);
    expect(err.code).toBe("BLOCKHASH_EXPIRED");
    expect(err.signature).toBe("SIG_TX");
    expect(err.hint).toMatch(/fresh blockhash/);
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("polling strategy: no status + blockhash no longer valid → BLOCKHASH_EXPIRED well before the timeout", async () => {
    fake.getSignatureStatuses.mockResolvedValue({ context: { slot: 1 }, value: [null] });
    fake.isBlockhashValid.mockResolvedValue({ context: { slot: 1 }, value: false });
    const started = Date.now();
    const err = await conn
      .sendWithRetry(stubTx(), { policy: { ...FAST, timeoutMs: 5_000 } })
      .catch((e) => e);
    expect(err.code).toBe("BLOCKHASH_EXPIRED");
    expect(err.signature).toBe("SIG_TX");
    expect(err.message).toContain("TX_BLOCKHASH");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();
    // Status was re-checked once after the blockhash check (landing race).
    expect(fake.getSignatureStatuses).toHaveBeenCalledTimes(2);
  });

  it("polling strategy: a transaction that lands right as its blockhash expires is still confirmed", async () => {
    fake.getSignatureStatuses
      .mockResolvedValueOnce({ context: { slot: 1 }, value: [null] })
      .mockResolvedValueOnce({
        context: { slot: 2 },
        value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed" }],
      });
    fake.isBlockhashValid.mockResolvedValue({ context: { slot: 1 }, value: false });
    const result = await conn.sendWithRetry(stubTx(), { policy: FAST });
    expect(result.signature).toBe("SIG_TX");
    expect(result.slot).toBe(2);
  });

  it("polling strategy: a processed-but-unconfirmed signature keeps waiting even when the blockhash is gone", async () => {
    fake.getSignatureStatuses
      .mockResolvedValueOnce({
        context: { slot: 1 },
        value: [{ slot: 1, confirmations: 0, err: null, confirmationStatus: "processed" }],
      })
      .mockResolvedValue({
        context: { slot: 3 },
        value: [{ slot: 1, confirmations: 2, err: null, confirmationStatus: "confirmed" }],
      });
    fake.isBlockhashValid.mockResolvedValue({ context: { slot: 1 }, value: false });
    const result = await conn.sendWithRetry(stubTx(), { policy: FAST });
    expect(result.signature).toBe("SIG_TX");
    expect(fake.isBlockhashValid).not.toHaveBeenCalled();
  });

  it("finalized policy waits for a finalized status", async () => {
    fake.getSignatureStatuses
      .mockResolvedValueOnce({
        context: { slot: 1 },
        value: [{ slot: 1, confirmations: 2, err: null, confirmationStatus: "confirmed" }],
      })
      .mockResolvedValueOnce({
        context: { slot: 40 },
        value: [{ slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" }],
      });
    const result = await conn.sendWithRetry(stubTx(), { policy: { ...FAST, commitment: "finalized" } });
    expect(result.commitment).toBe("finalized");
    expect(fake.getSignatureStatuses).toHaveBeenCalledTimes(2);
  });
});

describe("createConnection factory", () => {
  it("keeps the factory API stable", () => {
    const c = createConnection("devnet");
    expect(c.cluster).toBe("devnet");
  });
});
