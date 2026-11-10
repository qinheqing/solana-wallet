/**
 * buildMcpServer — assembles the solwallet MCP server with all tools.
 *
 * Dependencies are injectable for tests (InMemoryTransport + fake
 * connections); cli.ts uses the default production wiring.
 */
import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseTransactionError, type ParsedProgramError } from "@sol-wallet/core";
import { z, ZodError } from "zod";

import { makeSanitizer } from "./output.js";
import { registerCpiTools } from "./tools/cpi.js";
import { registerGuideTools } from "./tools/guide.js";
import { registerInspectTools } from "./tools/inspect.js";
import { registerLookupTableTools } from "./tools/lookup-table.js";
import { registerMultisigTools } from "./tools/multisig.js";
import { registerRawTools } from "./tools/raw.js";
import { registerTokenTools } from "./tools/token.js";
import { registerTransferTools } from "./tools/transfer.js";
import { registerWalletTools } from "./tools/wallet.js";
import { ConnectionManager, WalletStore } from "./state.js";
import type { ToolCallback, ToolDeps, ToolHandler } from "./types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const SERVER_NAME = "solwallet-mcp";
/** Same as package.json (src/ and dist/ both sit one level below it). */
export const SERVER_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

/**
 * Injected into the client's context on connect, so the model knows the
 * rules without a separately installed Skill. Details live in get_guide.
 */
export const SERVER_INSTRUCTIONS = [
  "solwallet: Solana wallet TESTING server (devnet / testnet / local validator; mainnet only with explicit consent). Wallets live in server memory only.",
  "",
  "Rules:",
  '- ALL amount inputs are integer strings in BASE UNITS (lamports; token base units). 1 SOL = "1000000000"; 1.5 tokens at 6 decimals = "1500000". "1.5" is rejected. Outputs keep raw values plus *Display hints.',
  "- Token tools need `mint`; `decimals` is optional (read from the mint). `to` is a WALLET address; ATAs are derived.",
  "- Errors: read error.suggestion (and error.custom for on-chain program errors) and act on it. Retry the same call at most once and only for RATE_LIMITED / BLOCKHASH_EXPIRED / network errors; otherwise fix the parameters.",
  "- PREFLIGHT_BLOCKED: read preflight.findings and fix the cause; use force: true only when the user explicitly wants to test the on-chain failure.",
  "- Never call export_secret unless the user asks to back up or export a key; never repeat exported secrets back.",
  "- mainnet-beta sends: restate amount and recipient, get the user's OK, then pass allowMainnet: true.",
  "- Ask before irreversible actions: revoking mint/freeze authority (null), closeMint, nonTransferable or permanent-delegate mints, overwrite: true on a wallet name clash.",
  "- request_airdrop on public devnet/testnet RPCs returns FAUCET_UNAVAILABLE: suggest faucet.solana.com, a paid RPC URL as `cluster`, or a local validator.",
  "",
  "Common flows: create_wallet → get_cluster_status → get_balances → transfer (dryRun: true to simulate). Inspect: inspect_transaction (signature or JSON), inspect_raw_transaction (serialized tx, may not have landed).",
  "",
  "Before an unfamiliar or multi-step task (Token-2022 extensions, multisig, delegate / PermanentDelegate, raw signing, preflight codes, error codes), call get_guide with a topic: tool-selection, parameters, amounts, preflight-codes, workflows, examples, errors, faucet, red-lines, overview.",
].join("\n");

export interface McpServerOptions {
  /** Test seam: custom ClusterConnection factory (fake RPC in tests). */
  connectionFactory?: (clusterOrUrl: string) => ReturnType<ConnectionManager["get"]>;
}

export function buildMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: SERVER_INSTRUCTIONS,
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
  // Usage guide (SKILL.md) as get_guide + solwallet://guide resources.
  registerGuideTools(server, z);
  registerTransferTools(server, deps, z);
  registerTokenTools(server, deps, z);
  registerMultisigTools(server, deps, z);
  // PRD T-D: raw transaction channel (sign / simulate / send hex payloads).
  registerRawTools(server, deps, z);
  registerLookupTableTools(server, deps, z);
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
