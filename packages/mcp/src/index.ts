/**
 * @solwallet/mcp — MCP server exposing Solana wallet testing tools.
 * See cli.ts for the stdio entry; server.ts for tool registration.
 */
export { buildMcpServer, SERVER_NAME, SERVER_VERSION, type McpServerOptions } from "./server.js";
export { ConnectionManager, WalletStore, type StoredWallet } from "./state.js";
export { makeSanitizer } from "./output.js";
