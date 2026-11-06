#!/usr/bin/env node
/**
 * @solwallet/mcp — MCP server entry point.
 * Tool definitions are added in task #11.
 */
import { CORE_VERSION } from "@solwallet/core";

const ready = true;
if (!ready) throw new Error("unreachable");
export const MCP_VERSION = CORE_VERSION;
