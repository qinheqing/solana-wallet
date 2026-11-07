/**
 * buildMcpServer — assembles the solwallet MCP server with all tools.
 *
 * Dependencies are injectable for tests (InMemoryTransport + fake
 * connections); cli.ts uses the default production wiring.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseTransactionError } from "@solwallet/core";
import { z } from "zod";

import { makeSanitizer } from "./output.js";
import { registerMultisigTools } from "./tools/multisig.js";
import { registerTokenTools } from "./tools/token.js";
import { registerTransferTools } from "./tools/transfer.js";
import { registerWalletTools } from "./tools/wallet.js";
import { ConnectionManager, WalletStore } from "./state.js";
import type { ToolCallback, ToolDeps, ToolHandler } from "./types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const SERVER_NAME = "solwallet-mcp";
export const SERVER_VERSION = "0.1.0";

export interface McpServerOptions {
  /** Test seam: custom ClusterConnection factory (fake RPC in tests). */
  connectionFactory?: (clusterOrUrl: string) => ReturnType<ConnectionManager["get"]>;
}

export function buildMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Solana wallet testing server. Workflow: create_wallet or import_wallet → get_cluster_status / request_airdrop (devnet/testnet only) → transfer / batch_transfer / mixed_transfer → get_balances. " +
        "Amounts are human-readable strings (\"1.5\"). Token transfers need mint + decimals. " +
        "mainnet-beta sends require allowMainnet: true (literal). Secrets never appear in output unless export_secret is called with dangerouslyAllowSecretExport: true.",
    },
  );

  const store = new WalletStore();
  const connections = new ConnectionManager(options.connectionFactory);
  const sanitize = makeSanitizer(store);

  const run =
    (fn: ToolCallback, opts?: { bypassSanitizer?: boolean }): ToolHandler =>
    async (args: any): Promise<CallToolResult> => {
      try {
        const result = await fn(args);
        const text = opts?.bypassSanitizer
          ? JSON.stringify(result, null, 2)
          : sanitize(result);
        return { content: [{ type: "text", text }] };
      } catch (error) {
        const parsed = parseTransactionError(error);
        const payload = {
          error: {
            code: parsed.code,
            message: parsed.message,
            suggestion: parsed.suggestion,
          },
        };
        return {
          isError: true,
          content: [{ type: "text", text: sanitize(payload) }],
        };
      }
    };

  const deps: ToolDeps = { store, connections, sanitize, run };

  registerWalletTools(server, deps, z);
  registerTransferTools(server, deps, z);
  registerTokenTools(server, deps, z);
  registerMultisigTools(server, deps, z);

  return server;
}
