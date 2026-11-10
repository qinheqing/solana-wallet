/**
 * E2E for the T-A / T-E observation tools (derive_address, inspect_mint,
 * inspect_token_account, inspect_transaction) over InMemoryTransport with a
 * fake RPC. Mirrors e2e.test.ts' seam (connectionFactory).
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  AccountType,
  ExtensionType,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TransferFeeConfigLayout,
} from "@solana/spl-token";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClusterConnection, resolveClusterTarget } from "@solwallet/core";
import { buildMcpServer } from "./server.js";

const WITHDRAW_FIXTURE = new URL(
  "../../core/src/inspect/__fixtures__/withdraw-withheld-from-accounts.json",
  import.meta.url,
);

function tlv(type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(data.length, 2);
  return Buffer.concat([head, data]);
}

/** A Token-2022 mint with TransferFeeConfig and an ATA with TransferFeeAmount. */
function craftAccounts() {
  const mint = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;

  const mintBase = Buffer.alloc(ACCOUNT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority: authority,
      supply: 1_000_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    mintBase,
  );
  const fee = Buffer.alloc(TransferFeeConfigLayout.span);
  TransferFeeConfigLayout.encode(
    {
      transferFeeConfigAuthority: authority,
      withdrawWithheldAuthority: authority,
      withheldAmount: 7n,
      olderTransferFee: { epoch: 1n, maximumFee: 100n, transferFeeBasisPoints: 50 },
      newerTransferFee: { epoch: 2n, maximumFee: 200n, transferFeeBasisPoints: 75 },
    },
    fee,
  );
  const mintData = Buffer.concat([mintBase, Buffer.from([AccountType.Mint]), tlv(ExtensionType.TransferFeeConfig, fee)]);

  const acctBase = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount: 123n,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: AccountState.Initialized,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    acctBase,
  );
  const withheld = Buffer.alloc(8);
  withheld.writeBigUInt64LE(9n);
  const ata = Keypair.generate().publicKey;
  const ataData = Buffer.concat([
    acctBase,
    Buffer.from([AccountType.Account]),
    tlv(ExtensionType.ImmutableOwner, Buffer.alloc(0)),
    tlv(ExtensionType.TransferFeeAmount, withheld),
  ]);
  return { mint, owner, authority, ata, mintData, ataData };
}

async function setup() {
  const crafted = craftAccounts();
  const withdrawJson = JSON.parse(readFileSync(WITHDRAW_FIXTURE, "utf8"));
  const fake = {
    getAccountInfo: vi.fn((addr: PublicKey) => {
      if (addr.equals(crafted.mint)) {
        return Promise.resolve({ owner: TOKEN_2022_PROGRAM_ID, data: crafted.mintData, lamports: 1, executable: false });
      }
      if (addr.equals(crafted.ata)) {
        return Promise.resolve({ owner: TOKEN_2022_PROGRAM_ID, data: crafted.ataData, lamports: 1, executable: false });
      }
      return Promise.resolve(null);
    }),
    getProgramAccounts: vi.fn(() =>
      Promise.resolve([
        { pubkey: crafted.mint, account: { owner: TOKEN_2022_PROGRAM_ID, data: crafted.mintData, lamports: 1, executable: false } },
        { pubkey: crafted.ata, account: { owner: TOKEN_2022_PROGRAM_ID, data: crafted.ataData, lamports: 1, executable: false } },
      ]),
    ),
    getSignatureStatuses: vi.fn(() => Promise.resolve({ context: { slot: 1 }, value: [null] })),
    isBlockhashValid: vi.fn(() => Promise.resolve({ context: { slot: 1 }, value: false })),
    getParsedTransaction: vi.fn((sig: string) =>
      Promise.resolve(sig === withdrawJson.transaction.signatures[0] ? withdrawJson : null),
    ),
  };
  const factory = (clusterOrUrl: string) =>
    new ClusterConnection(resolveClusterTarget(clusterOrUrl), { connection: fake as unknown as Connection });
  const server = buildMcpServer({ connectionFactory: factory });
  const client = new Client({ name: "inspect-test", version: "0.0.1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(ct), client.connect(st)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  const body = (res: CallToolResult) => JSON.parse((res.content?.[0] as { text: string }).text);
  return { crafted, withdrawJson, fake, call, body, cleanup: async () => { await client.close(); await server.close(); } };
}

describe("inspect tools (T-A / T-E) e2e", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => { await cleanup?.(); cleanup = undefined; });

  it("derive_address returns both ATAs offline; PDA owner refused unless allowed", async () => {
    const t = await setup(); cleanup = t.cleanup;
    const owner = "EPdcT7VfA9GpkvM3YAx9TntdMHPnfhsJ7hPM7paVhxN9";
    const mint = "CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo";
    const ok = t.body(await t.call("derive_address", { owner, mint }));
    expect(ok.legacy.address).toBe("CfhmYTg6VQBUL4WrUkzKQx7Qhuxsrt5fpph6sMMu9wRX");
    expect(ok.token2022.address).toBe("5eciE3c7dzsZxU82GYcyurhDgtCLe9AghEeJBTsbkSDP");
    expect(ok.legacy.isOffCurve && ok.token2022.isOffCurve).toBe(true);

    const pda = "BDzjzqA9nScKiTuw7K9FiyVgAimskXf7stYvQ9M9438Q";
    const refused = await t.call("derive_address", { owner: pda, mint });
    expect(refused.isError).toBe(true);
    expect(t.body(refused).error.code).toBe("OWNER_OFF_CURVE");
    const allowed = t.body(await t.call("derive_address", { owner: pda, mint, allowOwnerOffCurve: true }));
    expect(allowed.ownerIsOffCurve).toBe(true);
  });

  it("inspect_mint decodes TransferFeeConfig and sizes the ATA; unknown mint → MINT_NOT_FOUND", async () => {
    const t = await setup(); cleanup = t.cleanup;
    const r = t.body(await t.call("inspect_mint", { mint: t.crafted.mint.toBase58() }));
    expect(r.cluster).toBe("devnet");
    expect(r.program).toBe("token-2022");
    expect(r.supply).toBe("1000000");
    expect(r.supplyDisplay).toBe("1 (6 dp)");
    expect(r.extensions).toEqual([
      expect.objectContaining({
        type: "TransferFeeConfig",
        withheldAmount: "7",
        newerTransferFee: { epoch: "2", transferFeeBasisPoints: 75, maximumFee: "200" },
      }),
    ]);
    expect(r.accountLen).toBe(182); // 165 + 1 + (4+0 ImmutableOwner) + (4+8 TransferFeeAmount)
    expect(JSON.stringify(r)).not.toContain("uiAmount");

    const missing = await t.call("inspect_mint", { mint: Keypair.generate().publicKey.toBase58() });
    expect(missing.isError).toBe(true);
    expect(t.body(missing).error.code).toBe("MINT_NOT_FOUND");
  });

  it("inspect_token_account returns raw amount + account extensions", async () => {
    const t = await setup(); cleanup = t.cleanup;
    const r = t.body(await t.call("inspect_token_account", { address: t.crafted.ata.toBase58() }));
    expect(r).toMatchObject({
      program: "token-2022",
      mint: t.crafted.mint.toBase58(),
      owner: t.crafted.owner.toBase58(),
      amount: "123",
      decimals: 6,
      amountDisplay: "0.000123 (6 dp)",
      delegatedAmountDisplay: "0 (6 dp)",
      state: "initialized",
      extensions: [{ type: "ImmutableOwner" }, { type: "TransferFeeAmount", withheldAmount: "9" }],
      dataLength: 182,
    });
  });

  it("inspect_transaction: by signature (fake RPC) and by offline json; exactly-one-of guard", async () => {
    const t = await setup(); cleanup = t.cleanup;
    const sig = t.withdrawJson.transaction.signatures[0];
    const bySig = t.body(await t.call("inspect_transaction", { signature: sig }));
    expect(bySig.explorerUrl).toBe(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    expect(bySig.movements[0]).toMatchObject({ instructionType: "withdrawWithheldTokensFromAccounts", balanceDelta: "242085167" });
    expect(bySig.feeDisplay).toMatch(/ SOL$/);
    expect(bySig.movements[0]).toHaveProperty("amountDisplay");
    expect(bySig.movements[0]).toHaveProperty("balanceDeltaDisplay");
    expect(typeof bySig.balanceChanges[0].deltaDisplay).toBe("string");
    expect(bySig.balanceChanges[0].deltaDisplay).toMatch(/\(\d+ dp\)$/);
    expect(t.fake.getParsedTransaction).toHaveBeenCalledWith(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });

    const byJson = t.body(await t.call("inspect_transaction", { json: JSON.stringify(t.withdrawJson), cluster: "mainnet-beta" }));
    expect(byJson.explorerUrl).toBe(`https://explorer.solana.com/tx/${sig}`);
    expect(byJson.balanceChanges.length).toBeGreaterThan(0);
    expect(JSON.stringify(byJson)).not.toContain("uiAmount");

    const neither = await t.call("inspect_transaction", {});
    expect(neither.isError).toBe(true);
    expect(t.body(neither).error.code).toBe("INVALID_INPUT");
    const unknown = await t.call("inspect_transaction", {
      signature: "dGu577XYHRcJRg763xnSBKgafeBwxHPWg9DxcGAexzWJ6DL8VtmnGmKqTTeAKjDszkiT6W2wCq45avs4sNC1be9",
    });
    expect(t.body(unknown).error.code).toBe("TRANSACTION_NOT_FOUND");
  });
});

const RAW_TX_B58 =
  "4HyFMSaVAQo5ZRVzZqJD5TNLk3tGxuv31AfonYmyHfQG2VUY7fuzM2LPZb7DYEd7ECneBgoSbQQq3fkuCMrXkLVCbBkKZjeuhnCokj9YFTDuhLtwdn9pYdVy6hjP9JgtjkbnjwF699riqBgca7vENPu2YfAxpNwxByHbDKTHzfonETwZ7RENFygGcUCABWpBeBJ4vE5fj1Jf33c5T9LYnTgDrfN2TTehgawcw9NBay9fFn6kNEiRsKoQzdAPSrwVF4D4xFbdm3r9M6qQpFfezi1Z9gbXCc6L5a8612KMRTDPVQ5Hv3cerFVxVVbshEdPEgSnbc4vPfqbsjG73KT5wUdbYNSEF9u8JQxmDEFqEvxF";

describe("web ↔ MCP parity: read-only tools", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => { await cleanup?.(); cleanup = undefined; });

  it("inspect_raw_transaction: offline decode, then chain status via RPC", async () => {
    const t = await setup(); cleanup = t.cleanup;
    const offline = t.body(await t.call("inspect_raw_transaction", { transaction: RAW_TX_B58, checkChain: false }));
    expect(offline).toMatchObject({
      cluster: null,
      encoding: "base58",
      signature: "dGu577XYHRcJRg763xnSBKgafeBwxHPWg9DxcGAexzWJ6DL8VtmnGmKqTTeAKjDszkiT6W2wCq45avs4sNC1be9",
      allSignaturesValid: true,
      chain: null,
    });
    expect(offline.instructions[2]).toMatchObject({
      programName: "System Program",
      decoded: { type: "transfer", info: { lamports: "5000000" } },
      lamportsDisplay: "0.005 SOL",
    });
    expect(t.fake.getSignatureStatuses).not.toHaveBeenCalled();

    const online = t.body(await t.call("inspect_raw_transaction", { transaction: RAW_TX_B58 }));
    expect(online.chain).toEqual({ status: "not-found", slot: null, err: null, blockhashValid: false });
    expect(online.warnings.join("\n")).toMatch(/not valid there/);

    const bad = await t.call("inspect_raw_transaction", { transaction: "nope", checkChain: false });
    expect(bad.isError).toBe(true);
    expect(t.body(bad).error.code).toBe("RAW_TX_INVALID");
  });

  it("find_withheld_accounts lists token accounts with withheld fees (mint itself skipped)", async () => {
    const t = await setup(); cleanup = t.cleanup;
    const r = t.body(await t.call("find_withheld_accounts", { mint: t.crafted.mint.toBase58() }));
    expect(r).toMatchObject({ decimals: 6, count: 1, totalWithheld: "9", totalWithheldDisplay: "0.000009 (6 dp)" });
    expect(r.accounts).toEqual([
      { address: t.crafted.ata.toBase58(), owner: t.crafted.owner.toBase58(), withheldAmount: "9", withheldDisplay: "0.000009 (6 dp)" },
    ]);
  });

  it("inspect_mint reports metaplexMetadata: null when there is no Metaplex account", async () => {
    const t = await setup(); cleanup = t.cleanup;
    const r = t.body(await t.call("inspect_mint", { mint: t.crafted.mint.toBase58() }));
    expect(r.metaplexMetadata).toBeNull();
    expect(r.program).toBe("token-2022");
  });
});
