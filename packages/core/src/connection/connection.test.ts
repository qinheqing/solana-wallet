import { Keypair, PublicKey, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClusterConnection, createConnection, type SendResult } from "./connection.js";
import { AirdropNotSupportedError, MainnetNotAllowedError } from "./errors.js";

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
  };
}

function asConnection(fake: unknown): Connection {
  return fake as unknown as Connection;
}

// We only exercise ClusterConnection's logic, not web3.js crypto — a stub
// transaction with a dummy serialize() is enough.
function stubTx(): VersionedTransaction {
  return {
    serialize: () => new Uint8Array([1, 2, 3]),
    message: {},
  } as unknown as VersionedTransaction;
}

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

  it("sends transactions and returns fee + slot", async () => {
    const result: SendResult = await conn.sendWithRetry(stubTx());
    expect(result.signature).toBe("SIG_TX");
    expect(result.feeLamports).toBe(5000);
    expect(result.slot).toBe(1235);
    expect(result.commitment).toBe("confirmed");
  });
});

describe("airdrop restriction", () => {
  it.each(["mainnet-beta", "custom"] as const)(
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

describe("createConnection factory", () => {
  it("keeps the factory API stable", () => {
    const c = createConnection("devnet");
    expect(c.cluster).toBe("devnet");
  });
});
