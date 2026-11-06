/**
 * Token & multisig tools — registered as structured NOT_IMPLEMENTED
 * placeholders. Their core capabilities arrive with tasks #8 (mint creation),
 * #9 (Token-2022 extension management) and #10 (Squads V4 multisig); the
 * tool schemas below already freeze the intended AI-facing contract.
 */
import type { ToolDeps } from "../types.js";

type McpServer = import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

function notImplemented(tool: string, task: number, description: string) {
  return async () => ({
    status: "NOT_IMPLEMENTED",
    tool,
    pendingTask: `#${task}`,
    description,
    note: "The underlying core capability is not built yet. This schema documents the planned contract.",
  });
}

export function registerTokenTools(
  server: McpServer,
  deps: ToolDeps,
  z: typeof import("zod").z,
): void {
  const { run } = deps;

  server.registerTool(
    "create_token",
    {
      description:
        "Create a new SPL Token or Token-2022 mint (decimals, authorities, optional Token-2022 extensions like transfer-fee or metadata). PENDING: wired in task #8.",
      inputSchema: {
        walletName: z.string().describe("Mint authority wallet (loaded)."),
        decimals: z.number().int().min(0).max(18).describe("Mint decimals."),
        tokenProgram: z
          .enum(["spl-token", "token-2022"])
          .optional()
          .describe("Default spl-token. Token-2022 enables `extensions`."),
        extensions: z
          .object({})
          .optional()
          .describe("Token-2022 extension config (transferFee, metadata, defaultFrozen, ...). PENDING task #8/#9."),
      },
    },
    run(notImplemented("create_token", 8, "Mint creation with optional Token-2022 extensions")),
  );

  server.registerTool(
    "manage_token2022",
    {
      description:
        "Runtime management of a Token-2022 mint: update transfer fee, freeze/thaw accounts, rotate authorities, update metadata. PENDING: wired in task #9.",
      inputSchema: {
        walletName: z.string().describe("Authority wallet (loaded)."),
        mint: z.string().describe("Token-2022 mint address."),
        action: z
          .enum([
            "setTransferFee",
            "freezeAccount",
            "thawAccount",
            "setMintAuthority",
            "setFreezeAuthority",
            "updateMetadata",
          ])
          .describe("Management action."),
        params: z.record(z.unknown()).optional().describe("Action-specific parameters."),
      },
    },
    run(notImplemented("manage_token2022", 9, "Token-2022 extension runtime management")),
  );

  server.registerTool(
    "create_multisig",
    {
      description:
        "Create an M-of-N multisig (Squads V4) and propose/approve/execute transactions. PENDING: wired in task #10.",
      inputSchema: {
        walletName: z.string().describe("Creating member wallet (loaded)."),
        members: z.array(z.string()).min(2).describe("Member public keys."),
        threshold: z.number().int().min(1).describe("Required approvals M."),
      },
    },
    run(notImplemented("create_multisig", 10, "Squads V4 multisig creation and proposal flow")),
  );
}
