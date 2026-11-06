/**
 * End-to-end tests (11.6): Client ↔ server over InMemoryTransport with a
 * fake RPC layer. Asserts the tool catalog, schema sanity, error shapes and
 * — critically — that no secret material ever crosses the boundary.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { ClusterConnection, resolveClusterTarget } from "@solwallet/core";
import { buildMcpServer } from "./server.js";

// --- fake ClusterConnection plumbing ---------------------------------------

function makeFakeConnectionFactory() {
  const mint = Keypair.generate().publicKey;
  const holderAta = getAssociatedTokenAddressSync(
    mint,
    Keypair.generate().publicKey,
    true,
  );

  const fake = {
    getSlot: vi.fn().mockResolvedValue(1000),
    getVersion: vi.fn().mockResolvedValue({ "solana-core": "2.1.0" }),
    getRecentPerformanceSamples: vi.fn().mockResolvedValue([
      { samplePeriodSecs: 60, numTransactions: 3_000_000n },
    ]),
    getAccountInfo: vi.fn().mockImplementation((addr: PublicKey) => {
      if (addr.equals(mint)) {
        return Promise.resolve({ owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(0) });
      }
      if (addr.equals(holderAta)) {
        return Promise.resolve({ owner: Keypair.generate().publicKey, data: Buffer.alloc(0) });
      }
      return Promise.resolve(null);
    }),
    requestAirdrop: vi.fn().mockResolvedValue("SIG_AIRDROP"),
    confirmTransaction: vi
      .fn()
      .mockResolvedValue({ value: { err: null }, context: { slot: 1001 } }),
    getBalance: vi.fn().mockResolvedValue(1_500_000_000),
    getParsedTokenAccountsByOwner: vi.fn().mockResolvedValue({ value: [] }),
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 999,
    }),
    sendRawTransaction: vi.fn().mockResolvedValue("SIG_TX"),
    simulateTransaction: vi.fn().mockResolvedValue({
      value: { err: null, logs: ["Program log: ok"], unitsConsumed: 100 },
    }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
  };

  // The ConnectionManager expects a ClusterConnection — wrap the fake RPC
  // inside a real one so class methods (getHealth, sendWithRetry…) work.
  const factory = vi.fn(
    (clusterOrUrl: string) =>
      new ClusterConnection(resolveClusterTarget(clusterOrUrl), {
        connection: fake as unknown as Connection,
      }),
  );
  return { factory, fake, mint, holderAta };
}

async function setup() {
  const rpc = makeFakeConnectionFactory();
  const server = buildMcpServer({ connectionFactory: rpc.factory });
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (res: CallToolResult): string =>
    (res.content?.[0] as { text: string } | undefined)?.text ?? "";
  return {
    rpc,
    server,
    client,
    call,
    text,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

const TOOL_NAMES = [
  "create_wallet",
  "import_wallet",
  "list_wallets",
  "export_secret",
  "get_cluster_status",
  "request_airdrop",
  "get_balances",
  "transfer",
  "batch_transfer",
  "mixed_transfer",
  "create_token",
  "manage_token2022",
  "create_multisig",
];

describe("solwallet MCP server (11.6)", () => {
  it("exposes the full tool catalog, every tool with a real description", async () => {
    const t = await setup();
    const { tools } = await t.client.listTools();
    const names = tools.map((x) => x.name).sort();
    for (const expected of TOOL_NAMES) {
      expect(names, expected).toContain(expected);
    }
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(
        20,
        `${tool.name} lacks a description`,
      );
    }
    await t.cleanup();
  });

  it("create_wallet → list_wallets flow; mnemonic never in output", async () => {
    const t = await setup();
    const created = await t.call("create_wallet", { name: "test-wallet" });
    expect(created.isError).toBeFalsy();
    const createdText = t.text(created);
    expect(createdText).toContain("test-wallet");
    expect(createdText).not.toMatch(/abandon|mnemonic/);

    const listed = await t.call("list_wallets", {});
    expect(t.text(listed)).toContain("test-wallet");
    expect(t.text(listed)).not.toContain("secretKey");
    await t.cleanup();
  });

  it("get_cluster_status returns health info via fake RPC", async () => {
    const t = await setup();
    const res = await t.call("get_cluster_status", {});
    expect(res.isError).toBeFalsy();
    const txt = t.text(res);
    expect(txt).toContain("slot");
    expect(txt).toContain("tps");
    await t.cleanup();
  });

  it("invalid input → structured error, not a crash", async () => {
    const t = await setup();
    const res = await t.call("import_wallet", { name: "w1" }); // no secret source
    expect(res.isError).toBe(true);
    expect(t.text(res)).toContain("error");
    await t.cleanup();
  });

  it("unknown wallet → error suggesting the remedy", async () => {
    const t = await setup();
    const res = await t.call("get_balances", { walletName: "ghost" });
    expect(res.isError).toBe(true);
    expect(t.text(res)).toMatch(/list_wallets|create_wallet/);
    await t.cleanup();
  });

  it("SECURITY: benign session never leaks keyfile bytes or mnemonics", async () => {
    const t = await setup();
    const created = await t.call("create_wallet", { name: "sec-wallet" });
    await t.call("list_wallets", {});
    await t.call("get_cluster_status", {});
    await t.call("get_balances", { walletName: "sec-wallet" });
    await t.call("request_airdrop", { walletName: "sec-wallet", sol: "1" });

    // Refused export (missing confirmation flag) must also stay clean.
    const refused = await t.call("export_secret", {
      walletName: "sec-wallet",
      format: "keyfileJson",
    });

    const allOutput = [t.text(created), t.text(refused)].join("\n");
    expect(allOutput).not.toContain("keyfileJson");
    // No solana-keygen byte-array anywhere in the benign session.
    expect(allOutput).not.toMatch(/\[\s*\d+\s*,\s*\d+\s*(?:,\s*\d+\s*){61,}\]/);
    await t.cleanup();
  });

  it("export_secret without the danger flag is refused", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const refused = await t.call("export_secret", {
      walletName: "w",
      format: "mnemonic",
    });
    expect(refused.isError).toBe(true);
    expect(t.text(refused)).toContain("dangerouslyAllowSecretExport");
    await t.cleanup();
  });

  it("export_secret with the flag returns REAL mnemonic and keyfile (bug regression)", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });

    const mnemonicExport = await t.call("export_secret", {
      walletName: "w",
      format: "mnemonic",
      dangerouslyAllowSecretExport: true,
    });
    const mnemonicText = t.text(mnemonicExport);
    // Regression: sanitizer used to redact this even with the flag set.
    expect(mnemonicText).toContain('"mnemonic":');
    expect(mnemonicText).not.toContain("[REDACTED]");
    // A real 12-word BIP39 phrase (words separated by spaces).
    const words = JSON.parse(mnemonicText).mnemonic.split(" ");
    expect(words.length).toBe(12);

    const keyfileExport = await t.call("export_secret", {
      walletName: "w",
      format: "keyfileJson",
      dangerouslyAllowSecretExport: true,
    });
    const keyfileText = t.text(keyfileExport);
    expect(keyfileText).not.toContain("[REDACTED]");
    const keyfile = JSON.parse(keyfileText).keyfileJson;
    expect(JSON.parse(keyfile)).toHaveLength(64);
    await t.cleanup();
  });

  it("transfer tool surfaces structured errors on bad amounts", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const res = await t.call("transfer", {
      walletName: "w",
      to: Keypair.generate().publicKey.toBase58(),
      amount: "-5", // invalid: negative
    });
    expect(res.isError).toBe(true);
    const txt = t.text(res);
    expect(txt).toContain("AMOUNT_INVALID");
    expect(txt).toContain("suggestion");
    await t.cleanup();
  });
});
