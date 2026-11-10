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
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { ClusterConnection, importFromMnemonic, resolveClusterTarget } from "@solwallet/core";
// Byte-faithful mint / token-account buffers (test-only, not part of core's public API).
import {
  accountBase,
  ext,
  mintBase,
  token2022AccountInfo,
  token2022MintInfo,
  type TlvEntry,
} from "../../core/src/inspect/__fixtures__/accounts.js";
import { makeSanitizer } from "./output.js";
import { buildMcpServer } from "./server.js";
import { WalletStore } from "./state.js";

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
    getMinimumBalanceForRentExemption: vi.fn().mockResolvedValue(1_500_000),
    getEpochInfo: vi.fn().mockResolvedValue({ epoch: 10, slotIndex: 0, slotsInEpoch: 432_000, absoluteSlot: 1 }),
    // Polling confirmation for raw sends (no lastValidBlockHeight known).
    getSignatureStatuses: vi.fn().mockResolvedValue({
      context: { slot: 1001 },
      value: [{ slot: 1001, confirmations: 1, err: null, confirmationStatus: "confirmed" }],
    }),
    isBlockhashValid: vi.fn().mockResolvedValue({ context: { slot: 1001 }, value: true }),
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
  "propose_multisig",
  "approve_multisig",
  "execute_multisig",
  "get_multisig",
  // PRD T-B / T-D (tasks 16, 18)
  "build_transfer",
  "sign_transaction",
  "simulate_transaction",
  "send_transaction",
  // PRD T-A / T-E (tasks 15, 19)
  "derive_address",
  "inspect_mint",
  "inspect_token_account",
  "inspect_transaction",
  // PRD T-C (task 17)
  "preflight_transfer",
  // PRD T-H (task 22)
  "approve_delegate",
  "revoke_delegate",
  // PRD T-I (task 23)
  "cpi_token_transfer",
  // web ↔ MCP parity
  "remove_wallet",
  "find_withheld_accounts",
  "inspect_raw_transaction",
];

describe("solwallet MCP server (11.6)", () => {
  it("exposes the full tool catalog, every tool with a real description", async () => {
    const t = await setup();
    const { tools } = await t.client.listTools();
    const names = tools.map((x) => x.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(names).toHaveLength(TOOL_NAMES.length);
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
    await t.call("request_airdrop", { walletName: "sec-wallet", lamports: "1000000000" });

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

  it("transfer tool rejects non-base-unit amounts at the schema with a units explanation", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    for (const amount of ["-5", "1.5", "1e9", ""]) {
      const res = await t.call("transfer", {
        walletName: "w",
        to: Keypair.generate().publicKey.toBase58(),
        amount,
      });
      expect(res.isError).toBe(true);
      expect(t.text(res)).toMatch(/base units/);
    }
    expect(t.rpc.fake.sendRawTransaction).not.toHaveBeenCalled();
    await t.cleanup();
  });
});

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("output sanitizer (fix 1: live secrets, valid JSON)", () => {
  it("scrubs secrets imported AFTER the sanitizer was built, keeps JSON valid", async () => {
    const store = new WalletStore();
    const sanitize = makeSanitizer(store); // built while the store is empty
    const imported = await importFromMnemonic(TEST_MNEMONIC);
    store.put({
      name: "late",
      keypair: imported.keypair,
      origin: "mnemonic",
      mnemonic: TEST_MNEMONIC,
      derivationPath: imported.path,
    });
    const secretKeyJson = JSON.stringify(Array.from(imported.keypair.secretKey));

    // A tool payload that (wrongly) embeds secret material under innocent keys.
    const out = sanitize({
      note: `phrase is: ${TEST_MNEMONIC} — keep it safe`,
      nested: { words: TEST_MNEMONIC, bytes: secretKeyJson, list: [secretKeyJson, "fine"] },
      address: imported.address.toBase58(),
      mnemonic: "masked-by-key-anyway",
    });

    expect(() => JSON.parse(out)).not.toThrow();
    const parsed = JSON.parse(out);
    expect(out).not.toContain("abandon");
    expect(out).not.toContain(secretKeyJson);
    expect(parsed.note).toBe("[REDACTED]"); // substring hit → whole string
    expect(parsed.nested.words).toBe("[REDACTED]");
    expect(parsed.nested.bytes).toBe("[REDACTED]");
    expect(parsed.nested.list).toEqual(["[REDACTED]", "fine"]);
    expect(parsed.mnemonic).toBe("[REDACTED]");
    expect(parsed.address).toBe(imported.address.toBase58());
  });

  it("e2e: import_wallet then export must still work, and non-export tools stay clean", async () => {
    const t = await setup();
    const imported = await t.call("import_wallet", { name: "imp", mnemonic: TEST_MNEMONIC });
    expect(imported.isError).toBeFalsy();
    expect(t.text(imported)).not.toContain("abandon");
    expect(() => JSON.parse(t.text(imported))).not.toThrow();

    const listed = await t.call("list_wallets", {});
    expect(t.text(listed)).not.toContain("abandon");

    const exported = await t.call("export_secret", {
      walletName: "imp",
      format: "mnemonic",
      dangerouslyAllowSecretExport: true,
    });
    expect(JSON.parse(t.text(exported)).mnemonic).toBe(TEST_MNEMONIC);
    await t.cleanup();
  });
});

describe("duplicate wallet names (fix 2: overwrite)", () => {
  it("create_wallet refuses a name clash unless overwrite: true", async () => {
    const t = await setup();
    const first = await t.call("create_wallet", { name: "dup" });
    const firstAddr = JSON.parse(t.text(first)).address;

    const clash = await t.call("create_wallet", { name: "dup" });
    expect(clash.isError).toBe(true);
    const err = JSON.parse(t.text(clash)).error;
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toContain('Wallet "dup" already exists');
    expect(err.message).toContain("overwrite: true");

    // Original wallet untouched.
    expect(t.text(await t.call("list_wallets", {}))).toContain(firstAddr);

    const replaced = await t.call("create_wallet", { name: "dup", overwrite: true });
    expect(replaced.isError).toBeFalsy();
    expect(JSON.parse(t.text(replaced)).address).not.toBe(firstAddr);
    await t.cleanup();
  });

  it("import_wallet (keyfile + mnemonic paths) honours overwrite", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const keyfileJson = JSON.stringify(Array.from(Keypair.generate().secretKey));

    const clashKeyfile = await t.call("import_wallet", { name: "w", keyfileJson });
    expect(clashKeyfile.isError).toBe(true);
    expect(t.text(clashKeyfile)).toContain("already exists");

    const clashMnemonic = await t.call("import_wallet", { name: "w", mnemonic: TEST_MNEMONIC });
    expect(clashMnemonic.isError).toBe(true);
    expect(t.text(clashMnemonic)).toContain("already exists");

    const ok = await t.call("import_wallet", { name: "w", mnemonic: TEST_MNEMONIC, overwrite: true });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(t.text(ok)).origin).toBe("mnemonic");
    await t.cleanup();
  });
});

describe("in-band failures flag isError (fix 3)", () => {
  it("transfer dryRun with a failing simulation → ok:false + isError:true", async () => {
    const t = await setup();
    t.rpc.fake.simulateTransaction.mockResolvedValueOnce({
      value: { err: { InstructionError: [0, "Custom"] }, logs: ["Program log: boom"], unitsConsumed: 1 },
    });
    await t.call("create_wallet", { name: "w" });
    const res = await t.call("transfer", {
      walletName: "w",
      to: Keypair.generate().publicKey.toBase58(),
      amount: "100000000",
      dryRun: true,
    });
    expect(res.isError).toBe(true);
    const body = JSON.parse(t.text(res));
    expect(body.ok).toBe(false); // content passed through unchanged
    expect(body.logs).toContain("Program log: boom");
    await t.cleanup();
  });

  it("create_token dryRun with a failing simulation → error field + isError:true", async () => {
    const t = await setup();
    t.rpc.fake.simulateTransaction.mockResolvedValueOnce({
      value: { err: { InstructionError: [0, "Custom"] }, logs: ["Program log: nope"], unitsConsumed: 1 },
    });
    await t.call("create_wallet", { name: "w" });
    const res = await t.call("create_token", { walletName: "w", decimals: 6, dryRun: true });
    expect(res.isError).toBe(true);
    const body = JSON.parse(t.text(res));
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe("SIMULATION_FAILED");
    expect(body.simulatedOnly).toBe(true);
    await t.cleanup();
  });

  it("successful dry run keeps isError unset", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const res = await t.call("transfer", {
      walletName: "w",
      to: Keypair.generate().publicKey.toBase58(),
      amount: "100000000",
      dryRun: true,
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(t.text(res)).ok).toBe(true);
    await t.cleanup();
  });
});

describe("input mistakes map to INVALID_INPUT, not UNKNOWN (fix 4)", () => {
  it("unknown wallet", async () => {
    const t = await setup();
    const res = await t.call("get_balances", { walletName: "ghost" });
    expect(res.isError).toBe(true);
    const err = JSON.parse(t.text(res)).error;
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.suggestion).not.toMatch(/explorer/i);
    expect(err.suggestion).toMatch(/arguments|parameter/i);
    await t.cleanup();
  });

  it("non-base58 address", async () => {
    const t = await setup();
    const res = await t.call("request_airdrop", { address: "0xNotBase58!!", lamports: "1000000000" });
    expect(res.isError).toBe(true);
    const err = JSON.parse(t.text(res)).error;
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.suggestion).not.toMatch(/explorer/i);
    await t.cleanup();
  });

  it("decimals on a SOL transfer", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const res = await t.call("transfer", {
      walletName: "w",
      to: Keypair.generate().publicKey.toBase58(),
      amount: "1",
      decimals: 6,
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(t.text(res)).error.code).toBe("INVALID_INPUT");
    await t.cleanup();
  });

  it("zero amount passes the schema but is refused as INVALID_INPUT (base units > 0)", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const res = await t.call("transfer", {
      walletName: "w",
      to: Keypair.generate().publicKey.toBase58(),
      amount: "0",
    });
    expect(res.isError).toBe(true);
    const err = JSON.parse(t.text(res)).error;
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toMatch(/greater than 0/);
    expect(err.suggestion).toMatch(/base units/);
    await t.cleanup();
  });
});

describe("mixed_transfer leg validation (fix 5)", () => {
  it("token leg without mint → clear INVALID_INPUT, no '_bn' crash", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const res = await t.call("mixed_transfer", {
      walletName: "w",
      legs: [
        { kind: "sol", to: Keypair.generate().publicKey.toBase58(), amount: "100000000" },
        { kind: "token", to: Keypair.generate().publicKey.toBase58(), amount: "5000000", decimals: 6 },
      ],
    });
    expect(res.isError).toBe(true);
    const err = JSON.parse(t.text(res)).error;
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toMatch(/legs\[1\].*mint/);
    expect(err.message).not.toContain("_bn");
    await t.cleanup();
  });

  it("token leg without decimals → decimals resolved from the mint; legs echo base units + display", async () => {
    const t = await setup();
    const owner = new PublicKey(JSON.parse(t.text(await t.call("create_wallet", { name: "w" }))).address);
    const mint = Keypair.generate().publicKey;
    const ownerAta = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
    t.rpc.fake.getAccountInfo.mockImplementation((addr: PublicKey) =>
      Promise.resolve(
        addr.equals(mint)
          ? token2022MintInfo(mintBase({ decimals: 6 }), [])
          : addr.equals(ownerAta)
            ? token2022AccountInfo(accountBase({ mint, owner, amount: 50_000_000n }), [ext.immutableOwner()])
            : null,
      ),
    );
    const res = await t.call("mixed_transfer", {
      walletName: "w",
      dryRun: true,
      legs: [
        { kind: "sol", to: Keypair.generate().publicKey.toBase58(), amount: "100000000" },
        { kind: "token", to: Keypair.generate().publicKey.toBase58(), amount: "5000000", mint: mint.toBase58() },
      ],
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(t.text(res));
    expect(body.legs[0]).toMatchObject({ amount: "100000000", amountBaseUnits: "100000000", amountDisplay: "0.1 SOL", decimals: null });
    expect(body.legs[1]).toMatchObject({ amount: "5000000", amountBaseUnits: "5000000", amountDisplay: "5 (6 dp)", decimals: 6 });
    expect(body.feeDisplay).toMatch(/SOL$/);
    expect(t.text(res)).not.toContain("uiAmount");
    await t.cleanup();
  });

  it("decimals on a sol leg → INVALID_INPUT", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const res = await t.call("mixed_transfer", {
      walletName: "w",
      legs: [
        { kind: "sol", to: Keypair.generate().publicKey.toBase58(), amount: "100000000", decimals: 9 },
        { kind: "sol", to: Keypair.generate().publicKey.toBase58(), amount: "100000000" },
      ],
    });
    expect(res.isError).toBe(true);
    const err = JSON.parse(t.text(res)).error;
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toMatch(/legs\[0\].*only valid for token/);
    await t.cleanup();
  });
});

describe("base-unit fields reject human-readable amounts (fix 6)", () => {
  it("manage_token2022 mintTokens amount \"1.5\" → INVALID_INPUT explaining base units", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const res = await t.call("manage_token2022", {
      walletName: "w",
      mint: t.rpc.mint.toBase58(),
      action: "mintTokens",
      params: { destinationOwner: Keypair.generate().publicKey.toBase58(), amount: "1.5" },
    });
    expect(res.isError).toBe(true);
    const err = JSON.parse(t.text(res)).error;
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toMatch(/base units/);
    expect(err.message).not.toMatch(/Cannot convert/); // no raw BigInt error
    await t.cleanup();
  });

  it("manage_token2022 setTransferFee maximumFee \"1.5\" → INVALID_INPUT", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const res = await t.call("manage_token2022", {
      walletName: "w",
      mint: t.rpc.mint.toBase58(),
      action: "setTransferFee",
      params: { transferFeeBasisPoints: 100, maximumFee: "1.5" },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(t.text(res)).error.message).toMatch(/maximumFee.*base units/);
    await t.cleanup();
  });

  it("create_token maximumFee \"1.5\" is rejected by the schema", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const res = await t.call("create_token", {
      walletName: "w",
      decimals: 6,
      tokenProgram: "token-2022",
      extensions: { transferFeeConfig: { transferFeeBasisPoints: 100, maximumFee: "1.5" } },
    });
    expect(res.isError).toBe(true);
    expect(t.text(res)).toMatch(/maximumFee must be an integer string in base units/);
    await t.cleanup();
  });

  it("schema descriptions spell out base units for the integer-string fields", async () => {
    const t = await setup();
    const { tools } = await t.client.listTools();
    const createToken = tools.find((x) => x.name === "create_token")!;
    const manage = tools.find((x) => x.name === "manage_token2022")!;
    expect(JSON.stringify(createToken.inputSchema)).toMatch(/base units \(integer string, NOT human-readable/);
    expect(JSON.stringify(manage.inputSchema)).toMatch(/base units \(integer string, NOT human-readable/);
    await t.cleanup();
  });
});

// ---------------------------------------------------------------------------
// PRD T-B (build_transfer + transfer knobs) and T-D (raw transaction tools)
// ---------------------------------------------------------------------------

describe("build_transfer + transfer knobs (task 16)", () => {
  it("build_transfer returns a plan and never sends", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const res = await t.call("build_transfer", {
      walletName: "w",
      to: Keypair.generate().publicKey.toBase58(),
      amount: "500000000",
      computeUnitLimit: 50_000,
      computeUnitPrice: 10,
      memo: "plan-only",
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(t.text(res));
    expect(body.program).toBe("system");
    expect(body.amountBaseUnits).toBe("500000000");
    expect(body.labels).toEqual(["setComputeUnitLimit", "setComputeUnitPrice", "memo", "systemTransfer"]);
    expect(body.plan.instructions).toHaveLength(4);
    expect(body.plan.instructions[2]).toMatchObject({
      index: 2,
      label: "memo",
      programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
      dataHex: Buffer.from("plan-only").toString("hex"),
    });
    expect(body.plan.messageHex).toMatch(/^[0-9a-f]+$/);
    expect(body.plan.estimatedBytes).toBeGreaterThan(100);
    expect(body.plan.signers).toHaveLength(1);
    expect(body.plan.feePayer).toBe(body.plan.signers[0]);
    expect(body.plan.blockhash).toBeTypeOf("string");
    expect(t.rpc.fake.sendRawTransaction).not.toHaveBeenCalled();
    expect(t.rpc.fake.simulateTransaction).not.toHaveBeenCalled();
    await t.cleanup();
  });

  it("build_transfer token knobs: ataMode none + instruction transfer; fee validation", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    // The payer has no source ATA in the fake registry → structured error, nothing sent.
    const missing = await t.call("build_transfer", {
      walletName: "w",
      to: Keypair.generate().publicKey.toBase58(),
      amount: "1000000",
      mint: t.rpc.mint.toBase58(),
      decimals: 6,
      ataMode: "none",
      instruction: "transfer",
    });
    expect(missing.isError).toBe(true);
    expect(t.text(missing)).toContain("SOURCE_ATA_MISSING");

    const badFee = await t.call("build_transfer", {
      walletName: "w",
      to: Keypair.generate().publicKey.toBase58(),
      amount: "1000000",
      mint: t.rpc.mint.toBase58(),
      decimals: 6,
      instruction: "transferCheckedWithFee",
      fee: "1.5",
    });
    expect(badFee.isError).toBe(true);
    expect(t.text(badFee)).toContain("integer base-unit");
    await t.cleanup();
  });

  it("transfer returns plan and accepts knobs (dryRun)", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const res = await t.call("transfer", {
      walletName: "w",
      to: Keypair.generate().publicKey.toBase58(),
      amount: "100000000",
      memo: "hi",
      computeUnitPrice: 5,
      dryRun: true,
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(t.text(res));
    expect(body.simulatedOnly).toBe(true);
    expect(body.plan.instructions.map((i: { label: string }) => i.label)).toEqual([
      "setComputeUnitPrice",
      "memo",
      "systemTransfer",
    ]);
    await t.cleanup();
  });

  it("transfer with an unknown authorityWallet → INVALID_INPUT", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const res = await t.call("transfer", {
      walletName: "w",
      to: Keypair.generate().publicKey.toBase58(),
      amount: "1000000",
      mint: t.rpc.mint.toBase58(),
      decimals: 6,
      authorityWallet: "ghost",
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(t.text(res)).error.code).toBe("INVALID_INPUT");
    await t.cleanup();
  });
});

describe("raw transaction tools (task 18)", () => {
  it("build_transfer → sign_transaction → simulate_transaction → send_transaction", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const built = JSON.parse(
      t.text(
        await t.call("build_transfer", {
          walletName: "w",
          to: Keypair.generate().publicKey.toBase58(),
          amount: "250000000",
        }),
      ),
    );
    // Unsigned wire bytes: 1 (count) + 64 (zero sig) + message.
    const unsignedHex = "01" + "00".repeat(64) + built.plan.messageHex;

    const unsignedSend = await t.call("send_transaction", { transaction: unsignedHex });
    expect(unsignedSend.isError).toBe(true);
    expect(t.text(unsignedSend)).toContain("TX_NOT_FULLY_SIGNED");

    const signed = await t.call("sign_transaction", { transaction: unsignedHex, walletNames: ["w"] });
    expect(signed.isError).toBeFalsy();
    const sig = JSON.parse(t.text(signed));
    expect(sig.fullySigned).toBe(true);
    expect(sig.kind).toBe("v0");
    expect(sig.encoding).toBe("hex");
    expect(sig.signatures).toHaveLength(1);
    expect(sig.signatures[0].signatureHex).not.toBe("0".repeat(128));
    expect(sig.txHex.endsWith(built.plan.messageHex)).toBe(true);

    const sim = await t.call("simulate_transaction", { transaction: sig.txBase64 });
    expect(sim.isError).toBeFalsy();
    expect(JSON.parse(t.text(sim))).toMatchObject({ ok: true, encoding: "base64", kind: "v0" });

    const sent = await t.call("send_transaction", { transaction: sig.txHex });
    expect(sent.isError).toBeFalsy();
    expect(JSON.parse(t.text(sent))).toMatchObject({ ok: true, signature: "SIG_TX", kind: "v0" });
    expect(t.rpc.fake.sendRawTransaction).toHaveBeenCalledOnce();
    await t.cleanup();
  });

  it("sign_transaction with a non-required wallet / garbage payload → structured errors", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    await t.call("create_wallet", { name: "other" });
    const built = JSON.parse(
      t.text(await t.call("build_transfer", { walletName: "w", to: Keypair.generate().publicKey.toBase58(), amount: "1000000000" })),
    );
    const unsignedHex = "01" + "00".repeat(64) + built.plan.messageHex;
    const wrong = await t.call("sign_transaction", { transaction: unsignedHex, walletNames: ["other"] });
    expect(wrong.isError).toBe(true);
    expect(t.text(wrong)).toContain("SIGNER_NOT_REQUIRED");

    const garbage = await t.call("simulate_transaction", { transaction: "not-a-tx!!" });
    expect(garbage.isError).toBe(true);
    expect(t.text(garbage)).toContain("RAW_TX_INVALID");
    await t.cleanup();
  });

  it("send_transaction on mainnet-beta requires allowMainnet", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const built = JSON.parse(
      t.text(
        await t.call("build_transfer", {
          walletName: "w",
          to: Keypair.generate().publicKey.toBase58(),
          amount: "1000000000",
          cluster: "mainnet-beta",
        }),
      ),
    );
    const signed = JSON.parse(
      t.text(
        await t.call("sign_transaction", {
          transaction: "01" + "00".repeat(64) + built.plan.messageHex,
          walletNames: ["w"],
        }),
      ),
    );
    const refused = await t.call("send_transaction", { transaction: signed.txHex, cluster: "mainnet-beta" });
    expect(refused.isError).toBe(true);
    expect(t.text(refused)).toContain("MAINNET_NOT_ALLOWED");
    expect(t.rpc.fake.sendRawTransaction).not.toHaveBeenCalled();
    await t.cleanup();
  });
});

// ---------------------------------------------------------------------------
// PRD T-C (task 17): preflight_transfer + transfer gating / force
// ---------------------------------------------------------------------------

describe("preflight_transfer + transfer gating (task 17)", () => {
  const T22 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

  /** Seed the fake RPC with a Token-2022 mint, a funded source ATA and (optionally) a dest ATA. */
  async function seed(
    t: Awaited<ReturnType<typeof setup>>,
    o: { mintExt?: TlvEntry[]; destExt?: TlvEntry[] | null },
  ) {
    const body = JSON.parse(t.text(await t.call("create_wallet", { name: "w" })));
    const owner = new PublicKey(body.address ?? body.publicKey);
    const mint = Keypair.generate().publicKey;
    const to = Keypair.generate().publicKey;
    const reg = new Map<string, unknown>();
    reg.set(mint.toBase58(), token2022MintInfo(mintBase({ decimals: 6 }), o.mintExt ?? []));
    reg.set(
      getAssociatedTokenAddressSync(mint, owner, true, T22).toBase58(),
      token2022AccountInfo(accountBase({ mint, owner, amount: 5_000_000n }), [ext.immutableOwner()]),
    );
    if (o.destExt !== null) {
      reg.set(
        getAssociatedTokenAddressSync(mint, to, true, T22).toBase58(),
        token2022AccountInfo(accountBase({ mint, owner: to }), [ext.immutableOwner(), ...(o.destExt ?? [])]),
      );
    }
    t.rpc.fake.getAccountInfo.mockImplementation((addr: PublicKey) => Promise.resolve(reg.get(addr.toBase58()) ?? null));
    return { mint: mint.toBase58(), to: to.toBase58() };
  }

  it("blocked by a transfer hook → ok:false, isError, TRANSFER_HOOK_PRESENT with the hook program", async () => {
    const t = await setup();
    const hook = Keypair.generate().publicKey;
    const { mint, to } = await seed(t, { mintExt: [ext.transferHook(Keypair.generate().publicKey, hook)] });
    const res = await t.call("preflight_transfer", { walletName: "w", to, amount: "1000000", mint, decimals: 6 });
    expect(res.isError).toBe(true);
    const body = JSON.parse(t.text(res));
    expect(body.ok).toBe(false);
    expect(body.blocking).toEqual(["TRANSFER_HOOK_PRESENT"]);
    expect(body.findings[0]).toMatchObject({ severity: "block", data: { programId: hook.toBase58() } });
    expect(body.program).toBe("token-2022");
    expect(body.amountBaseUnits).toBe("1000000");
    expect(body.destinationAta).toBe(getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(to), true, T22).toBase58());
    expect(t.rpc.fake.sendRawTransaction).not.toHaveBeenCalled();
    await t.cleanup();
  });

  it("blocked by MemoTransfer on the destination; a memo clears it", async () => {
    const t = await setup();
    const { mint, to } = await seed(t, { destExt: [ext.memoTransfer(true)] });
    const blocked = JSON.parse(t.text(await t.call("preflight_transfer", { walletName: "w", to, amount: "1000000", mint, decimals: 6 })));
    expect(blocked.ok).toBe(false);
    expect(blocked.blocking).toEqual(["MEMO_REQUIRED"]);
    const ok = await t.call("preflight_transfer", { walletName: "w", to, amount: "1000000", mint, decimals: 6, memo: "invoice 1" });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(t.text(ok))).toMatchObject({ ok: true, findings: [], blocking: [] });
    await t.cleanup();
  });

  it("ok with info findings (dest ATA missing) and SOL is always ok", async () => {
    const t = await setup();
    const { mint, to } = await seed(t, { destExt: null });
    const body = JSON.parse(t.text(await t.call("preflight_transfer", { walletName: "w", to, amount: "1000000", mint, decimals: 6 })));
    expect(body.ok).toBe(true);
    expect(body.findings.map((f: { code: string }) => f.code)).toEqual(["DEST_ATA_MISSING"]);
    const sol = JSON.parse(t.text(await t.call("preflight_transfer", { walletName: "w", to, amount: "100000000" })));
    expect(sol).toMatchObject({ ok: true, findings: [], program: "system", mint: null });
    await t.cleanup();
  });

  it("transfer: blocked → PREFLIGHT_BLOCKED + isError, nothing sent; force sends; skipPreflight omits findings", async () => {
    const t = await setup();
    const { mint, to } = await seed(t, { mintExt: [ext.nonTransferable()] });
    const args = { walletName: "w", to, amount: "1000000", mint, decimals: 6 };

    const blocked = await t.call("transfer", args);
    expect(blocked.isError).toBe(true);
    const b = JSON.parse(t.text(blocked));
    expect(b.error.code).toBe("PREFLIGHT_BLOCKED");
    expect(b.error.message).toContain("NON_TRANSFERABLE");
    expect(b.preflight.ok).toBe(false);
    expect(b.plan.instructions.at(-1).label).toBe("transferChecked");
    expect(t.rpc.fake.sendRawTransaction).not.toHaveBeenCalled();

    const forced = await t.call("transfer", { ...args, force: true });
    expect(forced.isError).toBeFalsy();
    const f = JSON.parse(t.text(forced));
    expect(f.signature).toBe("SIG_TX");
    expect(f.preflight.ok).toBe(false);
    expect(t.rpc.fake.sendRawTransaction).toHaveBeenCalledTimes(1);

    const skipped = JSON.parse(t.text(await t.call("transfer", { ...args, skipPreflight: true, dryRun: true })));
    expect(skipped.preflight).toBeUndefined();
    expect(skipped.simulatedOnly).toBe(true);
    await t.cleanup();
  });

  it("forced send rejected on chain → in-band error with decoded custom (36 NoMemo), plan and preflight kept", async () => {
    const t = await setup();
    const { mint, to } = await seed(t, { destExt: [ext.memoTransfer(true)] });
    // What the RPC says when the validator's own preflight rejects the Token-2022 transfer.
    t.rpc.fake.sendRawTransaction.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "failed to send transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x24",
        ),
        {
          logs: [
            `Program ${T22.toBase58()} invoke [1]`,
            "Program log: Instruction: TransferChecked",
            "Program log: Error: No memo in previous instruction; required for recipient to receive a transfer",
            `Program ${T22.toBase58()} failed: custom program error: 0x24`,
          ],
        },
      ),
    );
    const res = await t.call("transfer", { walletName: "w", to, amount: "1000000", mint, decimals: 6, force: true });
    expect(res.isError).toBe(true);
    const body = JSON.parse(t.text(res));
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("SIMULATION_FAILED");
    expect(body.error.custom).toMatchObject({ code: 36, name: "NoMemo", programId: T22.toBase58() });
    expect(body.error.message).toContain("custom program error: 0x24");
    expect(body.preflight.findings.map((f: { code: string }) => f.code)).toContain("MEMO_REQUIRED");
    expect(body.plan.instructions.at(-1).label).toBe("transferChecked");
    expect(body.signature).toBe("");
    await t.cleanup();
  });

  it("instruction \"transfer\" on a transfer-fee mint → UNCHECKED_TRANSFER_REJECTED block (custom 31 on chain)", async () => {
    const t = await setup();
    const auth = Keypair.generate().publicKey;
    const { mint, to } = await seed(t, {
      mintExt: [
        ext.transferFeeConfig({
          configAuthority: auth, withdrawAuthority: auth, withheld: 0n,
          older: { epoch: 0n, bps: 100, maxFee: 1_000n }, newer: { epoch: 0n, bps: 100, maxFee: 1_000n },
        }),
      ],
    });
    const pf = JSON.parse(t.text(await t.call("preflight_transfer", { walletName: "w", to, amount: "1000000", mint, decimals: 6, instruction: "transfer" })));
    expect(pf.ok).toBe(false);
    expect(pf.blocking).toContain("UNCHECKED_TRANSFER_REJECTED");
    const finding = pf.findings.find((f: { code: string }) => f.code === "UNCHECKED_TRANSFER_REJECTED");
    expect(finding.data.extension).toBe("TransferFeeConfig");
    expect(finding.message).toContain("custom error 31");
    // FEE_MISMATCH is a block too now.
    const bad = JSON.parse(t.text(await t.call("preflight_transfer", { walletName: "w", to, amount: "1000000", mint, decimals: 6, instruction: "transferCheckedWithFee", fee: "1" })));
    expect(bad.blocking).toContain("FEE_MISMATCH");
    await t.cleanup();
  });
});

// ---------------------------------------------------------------------------
// PRD T-F (presets + mintTo) and T-G (account-level extension actions)
// ---------------------------------------------------------------------------

describe("create_token presets + manage_token2022 T-G actions (tasks 20, 21)", () => {
  it("create_token with preset scaled-ui → Token-2022 mint, preset echoed, notes present", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const res = await t.call("create_token", { walletName: "w", preset: "scaled-ui" });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(t.text(res));
    expect(body.preset).toBe("scaled-ui");
    expect(body.tokenProgram).toBe("token-2022");
    expect(body.extensions).toEqual(["scaledUiAmount"]);
    expect(body.signature).toBe("SIG_TX");
    expect(body.notes.join(" ")).toMatch(/Display-only/);
    expect(body.mintTo).toBeUndefined();
    await t.cleanup();
  });

  it("create_token preset legacy-spl + explicit decimals override + mintTo → two transactions", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    // The follow-up mintTo needs the fresh mint to resolve to a token program:
    // answer every unknown account as an SPL-owned mint.
    t.rpc.fake.getAccountInfo.mockImplementation(() =>
      Promise.resolve({ owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(0) }),
    );
    const owner = Keypair.generate().publicKey.toBase58();
    const res = await t.call("create_token", {
      walletName: "w",
      preset: "legacy-spl",
      decimals: 2,
      mintTo: { owner, amount: "12345" },
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(t.text(res));
    expect(body.tokenProgram).toBe("spl-token");
    expect(body.mintTo).toMatchObject({ owner, amount: "12345", signature: "SIG_TX" });
    expect(body.mintTo.amountDisplay).toBe("123.45 (2 dp)");
    expect(body.decimals).toBe(2);
    expect(body.feeDisplay).toMatch(/SOL$/);
    expect(t.rpc.fake.sendRawTransaction).toHaveBeenCalledTimes(2);
    await t.cleanup();
  });

  it("create_token without preset still requires decimals; mintTo amount must be base units", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const missing = await t.call("create_token", { walletName: "w" });
    expect(missing.isError).toBe(true);
    expect(t.text(missing)).toMatch(/decimals/);
    const bad = await t.call("create_token", {
      walletName: "w",
      preset: "plain-2022",
      mintTo: { owner: Keypair.generate().publicKey.toBase58(), amount: "1.5" },
    });
    expect(bad.isError).toBe(true);
    expect(t.text(bad)).toMatch(/base units/);
    await t.cleanup();
  });

  it("manage_token2022 enableMemoTransfer → createATA + realloc + enable on this wallet's ATA", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    t.rpc.fake.getAccountInfo.mockImplementation((addr: PublicKey) =>
      Promise.resolve(addr.equals(t.rpc.mint) ? { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(0) } : null),
    );
    const res = await t.call("manage_token2022", {
      walletName: "w",
      mint: t.rpc.mint.toBase58(),
      action: "enableMemoTransfer",
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(t.text(res));
    expect(body.action).toBe("enableMemoTransfer");
    expect(body.signature).toBe("SIG_TX");
    expect(typeof body.tokenAccount).toBe("string");
    const raw = t.rpc.fake.sendRawTransaction.mock.calls[0]![0] as Uint8Array;
    const tx = VersionedTransaction.deserialize(raw);
    const ixData = tx.message.compiledInstructions.map((ci) => Buffer.from(ci.data));
    expect(ixData).toHaveLength(3);
    expect(ixData[1]![0]).toBe(29); // Reallocate
    expect(ixData[2]![0]).toBe(30); // MemoTransferExtension
    expect(ixData[2]![1]).toBe(0); // Enable
    await t.cleanup();
  });

  it("manage_token2022 harvestWithheldToMint / updateScaledUiMultiplier / withdrawWithheldFromAccounts param validation", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    t.rpc.fake.getAccountInfo.mockImplementation((addr: PublicKey) =>
      Promise.resolve(addr.equals(t.rpc.mint) ? { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(0) } : null),
    );
    const mint = t.rpc.mint.toBase58();

    const harvest = await t.call("manage_token2022", {
      walletName: "w",
      mint,
      action: "harvestWithheldToMint",
      params: { sources: [t.rpc.holderAta.toBase58()] },
    });
    expect(harvest.isError).toBeFalsy();
    expect(JSON.parse(t.text(harvest))).toMatchObject({ action: "harvestWithheldToMint", signature: "SIG_TX" });
    const tx = VersionedTransaction.deserialize(t.rpc.fake.sendRawTransaction.mock.calls[0]![0] as Uint8Array);
    const data = Buffer.from(tx.message.compiledInstructions[0]!.data);
    expect([data[0], data[1]]).toEqual([26, 4]); // TransferFeeExtension / HarvestWithheldTokensToMint

    const scaled = await t.call("manage_token2022", {
      walletName: "w",
      mint,
      action: "updateScaledUiMultiplier",
      params: { multiplier: 2 },
    });
    expect(scaled.isError).toBeFalsy();
    expect(JSON.parse(t.text(scaled)).note).toMatch(/display/);

    const noSources = await t.call("manage_token2022", {
      walletName: "w",
      mint,
      action: "withdrawWithheldFromAccounts",
      params: {},
    });
    expect(noSources.isError).toBe(true);
    expect(t.text(noSources)).toMatch(/params\.sources/);

    const badMultiplier = await t.call("manage_token2022", {
      walletName: "w",
      mint,
      action: "updateScaledUiMultiplier",
      params: { multiplier: 0 },
    });
    expect(badMultiplier.isError).toBe(true);
    expect(t.text(badMultiplier)).toMatch(/multiplier/);
    await t.cleanup();
  });
});

describe("approve_delegate / revoke_delegate + delegate transfer (task 22)", () => {
  const T22 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

  /** Two wallets (owner, delegate) and a Token-2022 mint; `approve(true)` re-seeds the owner ATA naming the delegate. */
  async function seed(t: Awaited<ReturnType<typeof setup>>) {
    const owner = new PublicKey(JSON.parse(t.text(await t.call("create_wallet", { name: "owner" }))).address);
    const del = new PublicKey(JSON.parse(t.text(await t.call("create_wallet", { name: "del" }))).address);
    const mint = Keypair.generate().publicKey;
    const to = Keypair.generate().publicKey;
    const approve = (approved: boolean) => {
      const reg = new Map<string, unknown>();
      reg.set(mint.toBase58(), token2022MintInfo(mintBase({ decimals: 6 }), []));
      reg.set(
        getAssociatedTokenAddressSync(mint, owner, true, T22).toBase58(),
        token2022AccountInfo(
          accountBase({ mint, owner, amount: 5_000_000n, delegate: approved ? del : null, delegatedAmount: approved ? 2_000_000n : 0n }),
          [ext.immutableOwner()],
        ),
      );
      reg.set(
        getAssociatedTokenAddressSync(mint, to, true, T22).toBase58(),
        token2022AccountInfo(accountBase({ mint, owner: to }), [ext.immutableOwner()]),
      );
      t.rpc.fake.getAccountInfo.mockImplementation((addr: PublicKey) => Promise.resolve(reg.get(addr.toBase58()) ?? null));
    };
    approve(false);
    return { owner, del, mint: mint.toBase58(), to: to.toBase58(), approve };
  }
  const sentData = (t: Awaited<ReturnType<typeof setup>>, call = 0) => {
    const raw = t.rpc.fake.sendRawTransaction.mock.calls[call]![0] as Uint8Array;
    const msg = VersionedTransaction.deserialize(raw).message;
    return [...msg.compiledInstructions[0]!.data];
  };

  it("approve_delegate sends ApproveChecked; then a delegate transfer plan shows the delegate as sole signer/authority", async () => {
    const t = await setup();
    const { owner, del, mint, to, approve: chainApprove } = await seed(t);
    const approve = await t.call("approve_delegate", { walletName: "owner", mint, delegate: del.toBase58(), amount: "2000000", decimals: 6 });
    expect(approve.isError).toBeFalsy();
    const a = JSON.parse(t.text(approve));
    expect(a).toMatchObject({ ok: true, signature: "SIG_TX", program: "token-2022", owner: owner.toBase58(), delegate: del.toBase58(), amountBaseUnits: "2000000" });
    expect(a.tokenAccount).toBe(getAssociatedTokenAddressSync(new PublicKey(mint), owner, true, T22).toBase58());
    const data = sentData(t);
    expect(data[0]).toBe(13);
    expect(Buffer.from(data.slice(1, 9)).readBigUInt64LE()).toBe(2_000_000n);
    expect(data[9]).toBe(6);

    // The chain state now (fixture) names `del` as delegate with 2_000_000 allowance.
    chainApprove(true);
    const plan = JSON.parse(t.text(await t.call("build_transfer", { walletName: "del", sourceOwner: owner.toBase58(), to, amount: "1000000", mint, decimals: 6 })));
    expect(plan.labels).toEqual(["transferChecked"]);
    expect(plan.plan.signers).toEqual([del.toBase58()]);
    const xfer = plan.plan.instructions[0];
    expect(xfer.accounts[0].pubkey).toBe(getAssociatedTokenAddressSync(new PublicKey(mint), owner, true, T22).toBase58());
    expect(xfer.accounts[3]).toMatchObject({ pubkey: del.toBase58(), isSigner: true });

    const sent = JSON.parse(t.text(await t.call("transfer", { walletName: "del", sourceOwner: owner.toBase58(), to, amount: "1000000", mint, decimals: 6, dryRun: true })));
    expect(sent.ok).toBe(true);
    expect(sent.preflight.findings.map((f: { code: string }) => f.code)).toContain("DELEGATE_TRANSFER");
    const over = await t.call("transfer", { walletName: "del", sourceOwner: owner.toBase58(), to, amount: "3000000", mint, decimals: 6, dryRun: true });
    expect(over.isError).toBe(true);
    expect(JSON.parse(t.text(over)).preflight.findings.map((f: { code: string }) => f.code)).toContain("INSUFFICIENT_DELEGATED_AMOUNT");
    await t.cleanup();
  });

  it("revoke_delegate sends Revoke [5] on the owner's ATA; unknown wallet → INVALID_INPUT", async () => {
    const t = await setup();
    const { owner, mint, approve } = await seed(t);
    approve(true);
    const res = await t.call("revoke_delegate", { walletName: "owner", mint });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(t.text(res))).toMatchObject({ ok: true, signature: "SIG_TX", owner: owner.toBase58() });
    expect(sentData(t)).toEqual([5]);
    const ghost = await t.call("revoke_delegate", { walletName: "ghost", mint });
    expect(ghost.isError).toBe(true);
    expect(JSON.parse(t.text(ghost)).error.code).toBe("INVALID_INPUT");
    await t.cleanup();
  });
});

describe("cpi_token_transfer (PRD T-I, task 23)", () => {
  it("dryRun through the forwarder: plan has ATA create + forwarder ix, nothing sent", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const programId = Keypair.generate().publicKey.toBase58();
    const res = await t.call("cpi_token_transfer", {
      walletName: "w",
      programId,
      destination: Keypair.generate().publicKey.toBase58(),
      mint: t.rpc.mint.toBase58(), // fake RPC reports this mint as SPL Token-owned
      amount: "1500000",
      decimals: 6,
      dryRun: true,
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(t.text(res));
    expect(body.ok).toBe(true);
    expect(body.simulatedOnly).toBe(true);
    expect(body.signature).toBe("");
    expect(body.program).toBe("spl-token");
    expect(body.amountBaseUnits).toBe("1500000");
    expect(body.destinationAtaCreated).toBe(true);
    expect(body.plan.instructions.map((i: { label: string }) => i.label)).toEqual([
      "createAssociatedTokenAccountIdempotent",
      "cpiForwardTransferChecked",
    ]);
    expect(body.plan.instructions[1].programId).toBe(programId);
    expect(body.plan.instructions[1].accounts[4].pubkey).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(t.text(res)).not.toContain("uiAmount");
    expect(t.rpc.fake.sendRawTransaction).not.toHaveBeenCalled();
    await t.cleanup();
  });

  it("non-base58 programId → INVALID_INPUT, not a crash", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const res = await t.call("cpi_token_transfer", {
      walletName: "w",
      programId: "0xNotBase58!!",
      destination: Keypair.generate().publicKey.toBase58(),
      mint: t.rpc.mint.toBase58(),
      amount: "1",
      decimals: 0,
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(t.text(res)).error.code).toBe("INVALID_INPUT");
    await t.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Base-unit inputs everywhere + *Display output hints + decimals auto-resolution
// ---------------------------------------------------------------------------

describe("base-unit inputs, *Display hints and optional decimals", () => {
  const T22 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

  /** Wallet "w" + a 6-decimal Token-2022 mint (optionally with a transfer fee) and a funded source ATA. */
  async function seed(t: Awaited<ReturnType<typeof setup>>, o: { mintExt?: TlvEntry[] } = {}) {
    const owner = new PublicKey(JSON.parse(t.text(await t.call("create_wallet", { name: "w" }))).address);
    const mint = Keypair.generate().publicKey;
    const to = Keypair.generate().publicKey;
    const reg = new Map<string, unknown>();
    reg.set(mint.toBase58(), token2022MintInfo(mintBase({ decimals: 6 }), o.mintExt ?? []));
    reg.set(
      getAssociatedTokenAddressSync(mint, owner, true, T22).toBase58(),
      token2022AccountInfo(accountBase({ mint, owner, amount: 50_000_000n }), [ext.immutableOwner()]),
    );
    reg.set(
      getAssociatedTokenAddressSync(mint, to, true, T22).toBase58(),
      token2022AccountInfo(accountBase({ mint, owner: to }), [ext.immutableOwner()]),
    );
    t.rpc.fake.getAccountInfo.mockImplementation((addr: PublicKey) => Promise.resolve(reg.get(addr.toBase58()) ?? null));
    return { owner, mint: mint.toBase58(), to: to.toBase58() };
  }

  it("request_airdrop takes lamports and echoes lamports + solDisplay; the old `sol` field is refused", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const ok = JSON.parse(t.text(await t.call("request_airdrop", { walletName: "w", lamports: "1500000000" })));
    expect(ok).toMatchObject({ signature: "SIG_AIRDROP", lamports: "1500000000", solDisplay: "1.5 SOL" });
    expect(t.rpc.fake.requestAirdrop).toHaveBeenCalledWith(expect.anything(), 1_500_000_000);
    const legacy = await t.call("request_airdrop", { walletName: "w", sol: "1.5" });
    expect(legacy.isError).toBe(true);
    expect(t.text(legacy)).toMatch(/lamports/);
    const human = await t.call("request_airdrop", { walletName: "w", lamports: "1.5" });
    expect(human.isError).toBe(true);
    expect(t.text(human)).toMatch(/base units/);
    await t.cleanup();
  });

  it("get_balances returns solLamports + solDisplay and raw token amount + display (no uiAmount)", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const mint = Keypair.generate().publicKey.toBase58();
    t.rpc.fake.getParsedTokenAccountsByOwner.mockImplementation((_o: unknown, f: { programId: PublicKey }) =>
      Promise.resolve({
        value: f.programId.equals(TOKEN_PROGRAM_ID)
          ? [{ pubkey: Keypair.generate().publicKey, account: { data: { parsed: { info: { mint, tokenAmount: { amount: "2500000", decimals: 6, uiAmount: 2.5 } } } } } }]
          : [],
      }),
    );
    const body = JSON.parse(t.text(await t.call("get_balances", { walletName: "w" })));
    expect(body.solLamports).toBe(1_500_000_000);
    expect(body.solDisplay).toBe("1.5 SOL");
    expect(body.tokens[0]).toMatchObject({ mint, amount: "2500000", decimals: 6, display: "2.5 (6 dp)", program: "spl-token" });
    expect(JSON.stringify(body)).not.toContain("uiAmount");
    await t.cleanup();
  });

  it("SOL transfer: amount is lamports; output carries amountDisplay / feeDisplay", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const body = JSON.parse(t.text(await t.call("transfer", { walletName: "w", to: Keypair.generate().publicKey.toBase58(), amount: "250000000", dryRun: true })));
    expect(body).toMatchObject({ ok: true, amountBaseUnits: "250000000", amountDisplay: "0.25 SOL", decimals: null });
    expect(body.feeDisplay).toMatch(/ SOL$/);
    await t.cleanup();
  });

  it("token transfer / preflight / build without decimals → resolved from the mint (one extra read); with decimals → no mint read before preflight", async () => {
    const t = await setup();
    const { mint, to } = await seed(t);
    const build = JSON.parse(t.text(await t.call("build_transfer", { walletName: "w", to, amount: "1500000", mint })));
    expect(build).toMatchObject({ program: "token-2022", amountBaseUnits: "1500000", amountDisplay: "1.5 (6 dp)", decimals: 6 });
    // transferChecked carries the resolved decimals byte (ix data: [12, amount u64, decimals u8]).
    const ix = build.plan.instructions.at(-1);
    expect(ix.label).toBe("transferChecked");
    expect(Buffer.from(ix.dataHex, "hex")[9]).toBe(6);

    const pf = JSON.parse(t.text(await t.call("preflight_transfer", { walletName: "w", to, amount: "1500000", mint })));
    expect(pf).toMatchObject({ ok: true, amountBaseUnits: "1500000", amountDisplay: "1.5 (6 dp)", decimals: 6 });

    const sent = JSON.parse(t.text(await t.call("transfer", { walletName: "w", to, amount: "1500000", mint, dryRun: true })));
    expect(sent).toMatchObject({ ok: true, amountBaseUnits: "1500000", amountDisplay: "1.5 (6 dp)", decimals: 6 });

    // Wrong explicit decimals are honoured as given (transferChecked will fail on chain) — never silently corrected.
    const wrong = JSON.parse(t.text(await t.call("build_transfer", { walletName: "w", to, amount: "1500000", mint, decimals: 2 })));
    expect(wrong.decimals).toBe(2);
    expect(wrong.amountDisplay).toBe("15000 (2 dp)");
    await t.cleanup();
  });

  it("preflight TRANSFER_FEE finding carries expectedFeeDisplay / netDisplay next to the raw figures", async () => {
    const t = await setup();
    const auth = Keypair.generate().publicKey;
    const { mint, to } = await seed(t, {
      mintExt: [
        ext.transferFeeConfig({
          configAuthority: auth, withdrawAuthority: auth, withheld: 0n,
          older: { epoch: 0n, bps: 100, maxFee: 1_000_000n }, newer: { epoch: 0n, bps: 100, maxFee: 1_000_000n },
        }),
      ],
    });
    const pf = JSON.parse(t.text(await t.call("preflight_transfer", { walletName: "w", to, amount: "1000000", mint })));
    const fee = pf.findings.find((f: { code: string }) => f.code === "TRANSFER_FEE");
    expect(fee.data).toMatchObject({
      amount: "1000000", expectedFee: "10000", net: "990000",
      amountDisplay: "1 (6 dp)", expectedFeeDisplay: "0.01 (6 dp)", netDisplay: "0.99 (6 dp)",
    });
    const sent = JSON.parse(t.text(await t.call("transfer", { walletName: "w", to, amount: "1000000", mint, dryRun: true })));
    const fee2 = sent.preflight.findings.find((f: { code: string }) => f.code === "TRANSFER_FEE");
    expect(fee2.data.netDisplay).toBe("0.99 (6 dp)");
    await t.cleanup();
  });

  it("approve_delegate: base-unit allowance, decimals optional (resolved), amountDisplay in the result", async () => {
    const t = await setup();
    const { mint } = await seed(t);
    const res = JSON.parse(t.text(await t.call("approve_delegate", { walletName: "w", mint, delegate: Keypair.generate().publicKey.toBase58(), amount: "2000000" })));
    expect(res).toMatchObject({ ok: true, amountBaseUnits: "2000000", amountDisplay: "2 (6 dp)", decimals: 6 });
    const human = await t.call("approve_delegate", { walletName: "w", mint, delegate: Keypair.generate().publicKey.toBase58(), amount: "2" , decimals: 6 });
    expect(JSON.parse(t.text(human)).amountDisplay).toBe("0.000002 (6 dp)"); // "2" means 2 base units now
    await t.cleanup();
  });

  it("batch_transfer: recipient amounts are base units; per-recipient amount + amountDisplay, chunk feeDisplay", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "w" });
    const a = Keypair.generate().publicKey.toBase58();
    const b = Keypair.generate().publicKey.toBase58();
    const body = JSON.parse(t.text(await t.call("batch_transfer", {
      walletName: "w",
      recipients: [{ to: a, amount: "10000000" }, { to: b, amount: "20000000" }],
      dryRun: true,
    })));
    expect(body.mint).toBeNull();
    expect(body.chunks[0].results).toEqual([
      expect.objectContaining({ to: a, status: "success", amount: "10000000", amountDisplay: "0.01 SOL" }),
      expect.objectContaining({ to: b, status: "success", amount: "20000000", amountDisplay: "0.02 SOL" }),
    ]);
    // dryRun batches carry no fee; the display hint mirrors that (null) instead of inventing "0 SOL".
    expect(body.chunks[0].feeDisplay).toBe(body.chunks[0].feeLamports == null ? null : expect.stringMatching(/SOL$/));
    const bad = await t.call("batch_transfer", { walletName: "w", recipients: [{ to: a, amount: "0.01" }], dryRun: true });
    expect(bad.isError).toBe(true);
    expect(t.text(bad)).toMatch(/base units/);
    await t.cleanup();
  });

  it("cpi_token_transfer: decimals optional, resolved from the mint", async () => {
    const t = await setup();
    const { mint, to } = await seed(t);
    const body = JSON.parse(t.text(await t.call("cpi_token_transfer", {
      walletName: "w", programId: Keypair.generate().publicKey.toBase58(), destination: to, mint, amount: "200000", dryRun: true,
    })));
    expect(body).toMatchObject({ ok: true, program: "token-2022", amountBaseUnits: "200000", amountDisplay: "0.2 (6 dp)", decimals: 6 });
    await t.cleanup();
  });

  it("server instructions and tool descriptions state the base-unit rule", async () => {
    const t = await setup();
    const { tools } = await t.client.listTools();
    for (const name of ["transfer", "batch_transfer", "mixed_transfer", "approve_delegate", "propose_multisig", "cpi_token_transfer", "request_airdrop"]) {
      const schema = JSON.stringify(tools.find((x) => x.name === name)!.inputSchema);
      expect(schema, name).toMatch(/BASE UNITS/);
      expect(schema, name).not.toMatch(/[Hh]uman-readable amount/);
    }
    await t.cleanup();
  });
});

describe("web ↔ MCP parity tools", () => {
  it("remove_wallet: requires confirmName, then forgets the wallet", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "tmp" });
    const refused = await t.call("remove_wallet", { walletName: "tmp", confirmName: "nope" });
    expect(refused.isError).toBe(true);
    expect(t.text(refused)).toMatch(/confirmName/);
    const ok = JSON.parse(t.text(await t.call("remove_wallet", { walletName: "tmp", confirmName: "tmp" })));
    expect(ok).toMatchObject({ removed: "tmp", remaining: 0 });
    expect(JSON.parse(t.text(await t.call("list_wallets", {}))).wallets).toEqual([]);
    const gone = await t.call("remove_wallet", { walletName: "tmp", confirmName: "tmp" });
    expect(gone.isError).toBe(true);
    await t.cleanup();
  });

  it("manage_token2022 new actions validate their params before touching the chain", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "auth" });
    const mint = Keypair.generate().publicKey.toBase58();
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["closeMint", {}, /IRREVERSIBLE|confirmClose/],
      ["updateInterestRate", {}, /params\.rate/],
      ["updateDefaultAccountState", { state: "open" }, /params\.state/],
      ["setExtensionAuthority", { kind: "bogus", newAuthority: null }, /params\.kind/],
      ["setExtensionAuthority", { kind: "pausable" }, /params\.newAuthority/],
    ];
    for (const [action, params, re] of cases) {
      const res = await t.call("manage_token2022", { walletName: "auth", mint, action, params });
      expect(res.isError, action).toBe(true);
      expect(t.text(res), action).toMatch(re);
    }
    await t.cleanup();
  });

  it("create_token rejects Metaplex metadata on a token-2022 mint", async () => {
    const t = await setup();
    await t.call("create_wallet", { name: "auth" });
    const res = await t.call("create_token", {
      walletName: "auth",
      decimals: 6,
      tokenProgram: "token-2022",
      metadata: { name: "X", symbol: "X" },
      dryRun: true,
    });
    expect(res.isError).toBe(true);
    expect(t.text(res)).toMatch(/extensions\.tokenMetadata/);
    await t.cleanup();
  });
});
