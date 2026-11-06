/**
 * Wallet & cluster status tools (F3/F2 surface).
 */
import {
  formatAmount,

  getWalletBalance,
  importFromMnemonic,
  newMnemonic,
  parseKeypairJson,
  serializeKeypairJson,
  solToLamports,
  toSafeWalletView,
  type ClusterConnection,
} from "@solwallet/core";
import { PublicKey } from "@solana/web3.js";

import type { ToolDeps } from "../types.js";

export function registerWalletTools(
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  deps: ToolDeps,
  z: typeof import("zod").z,
): void {
  const { store, connections, run } = deps;

  server.registerTool(
    "create_wallet",
    {
      description:
        "Generate a fresh Solana wallet from a new BIP39 mnemonic and load it into this server's memory. The mnemonic is NOT returned (use export_secret with dangerouslyAllowSecretExport=true to retrieve it). Wallets are lost when the server process exits.",
      inputSchema: {
        name: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/)
          .optional()
          .describe("Wallet identifier for later tools. Auto-generated when omitted."),
        strength: z
          .union([z.literal(128), z.literal(256)])
          .optional()
          .describe("Mnemonic entropy: 128 = 12 words (default), 256 = 24 words."),
      },
    },
    run(async (args: { name?: string; strength?: 128 | 256 }) => {
      const name = args.name ?? autoName(store, "wallet");
      const mnemonic = newMnemonic(args.strength ?? 128);
      const imported = await importFromMnemonic(mnemonic);
      store.put({
        name,
        keypair: imported.keypair,
        origin: "generated",
        mnemonic,
        derivationPath: imported.path,
      });
      return {
        walletName: name,
        address: imported.address.toBase58(),
        derivationPath: imported.path,
        words: (args.strength ?? 128) === 256 ? 24 : 12,
        note: "Mnemonic stored in memory only. Use export_secret to retrieve it (requires dangerouslyAllowSecretExport).",
      };
    }),
  );

  server.registerTool(
    "import_wallet",
    {
      description:
        "Import a wallet from a solana-keygen JSON keyfile or a BIP39 mnemonic and load it into memory. Returns only the public address.",
      inputSchema: {
        name: z.string().regex(/^[a-zA-Z0-9_-]+$/).describe("Wallet identifier for later tools."),
        keyfileJson: z
          .string()
          .optional()
          .describe("solana-keygen keyfile content: JSON array of 64 bytes, e.g. [17,168,...]."),
        mnemonic: z
          .string()
          .optional()
          .describe("BIP39 mnemonic, 12 or 24 English words. Case/whitespace tolerant."),
        derivationPath: z
          .string()
          .optional()
          .describe("SLIP-0010 path or preset (solana | phantom | solanaSecond). Default: solana (m/44'/501'/0'/0')."),
        passphrase: z.string().optional().describe("Optional BIP39 passphrase (25th word)."),
      },
    },
    run(
      async (
        args: {
          name: string;
          keyfileJson?: string;
          mnemonic?: string;
          derivationPath?: string;
          passphrase?: string;
        },
      ) => {
        if (Boolean(args.keyfileJson) === Boolean(args.mnemonic)) {
          throw new Error("Provide exactly one of keyfileJson or mnemonic.");
        }
        if (args.keyfileJson) {
          const keypair = parseKeypairJson(args.keyfileJson);
          store.put({ name: args.name, keypair, origin: "keyfile" });
          return {
            walletName: args.name,
            address: keypair.publicKey.toBase58(),
            origin: "keyfile" as const,
          };
        }
        const imported = await importFromMnemonic(args.mnemonic!, {
          path: args.derivationPath,
          passphrase: args.passphrase,
        });
        store.put({
          name: args.name,
          keypair: imported.keypair,
          origin: "mnemonic",
          mnemonic: args.mnemonic!,
          derivationPath: imported.path,
        });
        return {
          walletName: args.name,
          address: imported.address.toBase58(),
          origin: "mnemonic" as const,
          derivationPath: imported.path,
        };
      },
    ),
  );

  server.registerTool("list_wallets", {
    description:
      "List wallets currently loaded in this server's memory (name, address, origin). No secrets are included.",
    inputSchema: {},
  }, run(() => ({
    wallets: store.list().map((w) => ({
      name: w.name,
      address: w.keypair.publicKey.toBase58(),
      origin: w.origin,
    })),
  })));

  server.registerTool(
    "export_secret",
    {
      description:
        "Export a wallet's secret material (mnemonic or keyfile JSON). This prints REAL SECRET KEY MATERIAL to the chat/log — only use when the user explicitly asks to back up or export a key.",
      inputSchema: {
        walletName: z.string().describe("Wallet to export."),
        format: z
          .union([z.literal("mnemonic"), z.literal("keyfileJson")])
          .describe("mnemonic = BIP39 words (mnemonic-origin wallets only); keyfileJson = solana-keygen compatible JSON."),
        dangerouslyAllowSecretExport: z
          .literal(true)
          .describe("Must be exactly true — explicit confirmation that secret material will be printed."),
      },
    },
    run(
      (args: {
        walletName: string;
        format: "mnemonic" | "keyfileJson";
        dangerouslyAllowSecretExport: true;
      }) => {
        if (args.dangerouslyAllowSecretExport !== true) {
          throw new Error(
            "Refused: pass dangerouslyAllowSecretExport: true to confirm exporting secret material.",
          );
        }
        const w = store.require(args.walletName);
        if (args.format === "mnemonic") {
          if (!w.mnemonic) {
            throw new Error(
              `Wallet "${args.walletName}" was imported from a keyfile and has no mnemonic. Use format: "keyfileJson".`,
            );
          }
          return { walletName: w.name, mnemonic: w.mnemonic, warning: "Store safely; anyone with these words controls the funds." };
        }
        return {
          walletName: w.name,
          keyfileJson: serializeKeypairJson(w.keypair),
          warning: "Store safely; compatible with `solana-keygen pubkey <file>` usage.",
        };
      },
      // Escape hatch: the caller confirmed via dangerouslyAllowSecretExport.
      // The sanitizer would otherwise scrub the very payload being exported.
      { bypassSanitizer: true },
    ),
  );

  server.registerTool(
    "get_cluster_status",
    {
      description:
        "Health snapshot of a Solana cluster: current slot, node version, approximate TPS.",
      inputSchema: {
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { cluster?: string }) => {
      const conn = connections.get(args.cluster);
      return conn.getHealth();
    }),
  );

  server.registerTool(
    "request_airdrop",
    {
      description:
        "Request faucet SOL on devnet/testnet (refused on mainnet-beta and custom endpoints). Waits for confirmation.",
      inputSchema: {
        walletName: z.string().optional().describe("Loaded wallet to fund. Provide this or address."),
        address: z.string().optional().describe("Raw base58 address to fund. Provide this or walletName."),
        sol: z.string().describe("Amount in SOL, human-readable, e.g. \"1.5\". Devnet faucet caps at ~5 SOL per request."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { walletName?: string; address?: string; sol: string; cluster?: string }) => {
      const conn: ClusterConnection = connections.get(args.cluster);
      const address = args.address
        ? new PublicKey(args.address)
        : store.require(args.walletName ?? "").keypair.publicKey;
      const signature = await conn.requestAirdrop(address, Number(solToLamports(args.sol)));
      return {
        signature,
        address: address.toBase58(),
        sol: formatAmount(solToLamports(args.sol), 9),
      };
    }),
  );

  server.registerTool(
    "get_balances",
    {
      description:
        "Full balance snapshot: SOL plus every SPL Token and Token-2022 account (both programs queried).",
      inputSchema: {
        walletName: z.string().optional().describe("Loaded wallet. Provide this or address."),
        address: z.string().optional().describe("Raw base58 address. Provide this or walletName."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { walletName?: string; address?: string; cluster?: string }) => {
      const conn = connections.get(args.cluster);
      const address = args.address
        ? new PublicKey(args.address)
        : store.require(args.walletName ?? "").keypair.publicKey;
      const balance = await getWalletBalance(conn, address);
      return {
        cluster: conn.cluster,
        ...toSafeWalletView(balance),
        solLamports: balance.solLamports,
        tokens: balance.tokens,
      };
    }),
  );
}

function clusterParam(z: typeof import("zod").z, deps: ToolDeps) {
  return z
    .string()
    .optional()
    .describe(
      `Cluster name (devnet | testnet | mainnet-beta) or RPC URL. Default: ${deps.connections.defaultCluster()} (env SOLWALLET_CLUSTER).`,
    );
}

function autoName(store: { list(): Array<{ name: string }> }, prefix: string): string {
  let i = store.list().length + 1;
  while (store.list().some((w) => w.name === `${prefix}-${i}`)) i++;
  return `${prefix}-${i}`;
}
