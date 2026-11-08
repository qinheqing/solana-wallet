/**
 * buildMcpServer — assembles the solwallet MCP server with all tools.
 *
 * Dependencies are injectable for tests (InMemoryTransport + fake
 * connections); cli.ts uses the default production wiring.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseTransactionError, type ParsedProgramError } from "@solwallet/core";
import { z, ZodError } from "zod";

import { makeSanitizer } from "./output.js";
import { registerCpiTools } from "./tools/cpi.js";
import { registerInspectTools } from "./tools/inspect.js";
import { registerMultisigTools } from "./tools/multisig.js";
import { registerRawTools } from "./tools/raw.js";
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
        "ALL amounts are integer strings in BASE UNITS, like a block explorer: lamports for SOL (1 SOL = \"1000000000\") and token base units for mints (1.5 tokens at 6 decimals = \"1500000\"); human-readable amounts such as \"1.5\" are rejected. Outputs keep the raw value and add *Display hints (amountDisplay, solDisplay, feeDisplay). Token transfers need mint; decimals is optional (read from the mint when omitted). " +
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
        // Tools that report failure in-band (core result objects with an
        // `error`, or `ok: false`) must flag isError so clients don't treat
        // the payload as success. Content is passed through unchanged.
        return { content: [{ type: "text", text }], ...(isFailureResult(result) ? { isError: true } : {}) };
      } catch (error) {
        // Spread the whole ParsedProgramError: `custom` (decoded on-chain
        // code / Token enum name) and any future structured field must
        // survive, not just the three headline strings.
        const payload = { error: { ...classifyError(error) } };
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
  // PRD T-D: raw transaction channel (sign / simulate / send hex payloads).
  registerRawTools(server, deps, z);
  // PRD T-A / T-E: derive_address, inspect_mint, inspect_token_account, inspect_transaction.
  registerInspectTools(server, deps, z);
  // PRD T-I: cpi_token_transfer (TransferChecked as an inner instruction via solwallet_cpi).
  registerCpiTools(server, deps, z);

  return server;
}

/** A tool result whose shape says "this failed" even though nothing threw. */
function isFailureResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as { error?: unknown; ok?: unknown };
  return r.error !== undefined || r.ok === false;
}

/**
 * Caller-input mistakes (bad address, unknown wallet, malformed amount,
 * schema violations…) are not transaction failures: parseTransactionError
 * would file them under UNKNOWN with an "inspect the explorer" suggestion,
 * which sends the client in the wrong direction. Map them to INVALID_INPUT
 * with a parameter-oriented suggestion instead; everything else keeps the
 * core classification (and its suggestion).
 */
const INPUT_ERROR_PATTERNS: RegExp[] = [
  /Unknown wallet/i,
  /already exists/i,
  /Invalid public key/i,
  /Non-base58/i,
  /^Invalid amount/i,
  /decimals/i,
  /BigInt/i,
  /base[- ]unit/i,
  /^Missing params\./i,
  /^Provide exactly one of/i,
  /is required for token/i,
  /only valid for token/i,
  /token legs? (must|require)/i,
];

function classifyError(error: unknown): ParsedProgramError {
  if (error instanceof ZodError) {
    return {
      code: "INVALID_INPUT",
      message: error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
      suggestion: INVALID_INPUT_SUGGESTION,
    };
  }
  const parsed = parseTransactionError(error);
  if (parsed.code !== "UNKNOWN") return parsed;
  const message = error instanceof Error ? error.message : String(error);
  if (INPUT_ERROR_PATTERNS.some((re) => re.test(message))) {
    return { code: "INVALID_INPUT", message, suggestion: INVALID_INPUT_SUGGESTION };
  }
  return parsed;
}

const INVALID_INPUT_SUGGESTION =
  "Check the tool arguments: wallet names (list_wallets), base58 addresses, mint for token legs, and amount formats — every amount is an integer string in base units (lamports: 1 SOL = \"1000000000\"; token base units = tokens × 10^decimals), never a decimal like \"1.5\". Nothing was sent on-chain.";
