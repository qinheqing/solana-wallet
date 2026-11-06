#!/usr/bin/env node
/**
 * solwallet-mcp CLI entry — stdio transport for MCP clients.
 *
 * stdout is reserved for the MCP protocol; diagnostics go to stderr only.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildMcpServer } from "./server.js";

async function main(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = (signal: string) => {
    process.stderr.write(`[solwallet-mcp] received ${signal}, shutting down\n`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.stderr.write(
    `[solwallet-mcp] ready (cluster=${process.env.SOLWALLET_CLUSTER ?? "devnet"})\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`[solwallet-mcp] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
