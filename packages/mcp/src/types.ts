import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ConnectionManager, WalletStore } from "./state.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ToolCallback = (args: any) => unknown | Promise<unknown>;
export type ToolHandler = (args: any, extra?: unknown) => Promise<CallToolResult>;

export interface ToolDeps {
  store: WalletStore;
  connections: ConnectionManager;
  /** Sanitizer bound to the current wallet store. */
  sanitize: (value: unknown) => string;
  /**
   * Wrap a tool callback: uniform error handling (structured {code,
   * suggestion} output instead of thrown stack traces) + output sanitizer.
   */
  run: (fn: ToolCallback) => ToolHandler;
}

/** Shape of the sanitized error payload used by run(). */
export interface ToolErrorPayload {
  error: {
    code: string | number;
    message: string;
    suggestion?: string;
  };
}
