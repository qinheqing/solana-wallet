/**
 * Address lookup table tools: create / manage (extend, deactivate, close) /
 * inspect. Compile transfers against a table with the `lookupTables` param
 * of transfer / build_transfer. All logic lives in @sol-wallet/core.
 */
import {
  closeLookupTable,
  createLookupTable,
  deactivateLookupTable,
  extendLookupTable,
  inspectLookupTable,
  LOOKUP_TABLE_EXTEND_CHUNK,
  type LookupTableResult,
} from "@sol-wallet/core";

import { solDisplay } from "../amounts.js";
import type { ToolDeps } from "../types.js";

type McpServer = import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

export function registerLookupTableTools(
  server: McpServer,
  deps: ToolDeps,
  z: typeof import("zod").z,
): void {
  const { connections, run, store } = deps;

  const shape = (res: LookupTableResult) => {
    const fee = res.transactions.reduce((sum, t) => sum + t.feeLamports, 0);
    return {
      ok: !res.error,
      ...res,
      totalFeeLamports: fee,
      totalFeeDisplay: solDisplay(fee),
    };
  };

  server.registerTool(
    "create_lookup_table",
    {
      description: `Create an address lookup table (ALT) with walletName as authority and payer, optionally seeded with addresses (${LOOKUP_TABLE_EXTEND_CHUNK} per transaction; the first chunk rides in the create transaction). The table address derives from the current finalized slot. Returns {table, transactions[{step, signature, …}]}; stops at the first failure (in-band \`error\`). Addresses added in a slot are usable from the NEXT slot. Use the table via transfer / build_transfer \`lookupTables\`. dryRun simulates only the create transaction.`,
      inputSchema: {
        walletName: z.string().describe("Loaded wallet: table authority and fee/rent payer."),
        addresses: z.array(z.string()).optional().describe("Addresses (base58) to put in the table."),
        dryRun: z.boolean().optional().describe("Simulate the create transaction only."),
        allowMainnet: z.literal(true).optional().describe("Required literal true for mainnet-beta."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { walletName: string; addresses?: string[]; dryRun?: boolean; allowMainnet?: boolean; cluster?: string }) => {
      const conn = connections.get(args.cluster);
      const authority = store.require(args.walletName).keypair;
      return shape(
        await createLookupTable(conn, authority, {
          addresses: args.addresses,
          dryRun: args.dryRun,
          allowMainnet: args.allowMainnet,
        }),
      );
    }),
  );

  server.registerTool(
    "manage_lookup_table",
    {
      description: `Manage an address lookup table owned by walletName (its authority): extend {addresses} (${LOOKUP_TABLE_EXTEND_CHUNK} per transaction), deactivate {} (stays usable until the cooldown ends), close {recipient? (rent destination; default walletName)} — close only succeeds after deactivation plus a ~513-slot cooldown, otherwise the on-chain error comes back in-band. Returns {table, transactions, error?}.`,
      inputSchema: {
        walletName: z.string().describe("Loaded wallet that is the table authority (pays fees)."),
        table: z.string().describe("Lookup table address."),
        action: z.enum(["extend", "deactivate", "close"]).describe("Operation."),
        addresses: z.array(z.string()).optional().describe("extend: addresses (base58) to append."),
        recipient: z.string().optional().describe("close: rent recipient. Default walletName."),
        dryRun: z.boolean().optional().describe("Simulate without sending."),
        allowMainnet: z.literal(true).optional().describe("Required literal true for mainnet-beta."),
        cluster: clusterParam(z, deps),
      },
    },
    run(
      async (args: {
        walletName: string;
        table: string;
        action: "extend" | "deactivate" | "close";
        addresses?: string[];
        recipient?: string;
        dryRun?: boolean;
        allowMainnet?: boolean;
        cluster?: string;
      }) => {
        const conn = connections.get(args.cluster);
        const authority = store.require(args.walletName).keypair;
        const opts = { dryRun: args.dryRun, allowMainnet: args.allowMainnet };
        switch (args.action) {
          case "extend":
            return shape(await extendLookupTable(conn, authority, args.table, args.addresses ?? [], opts));
          case "deactivate":
            return shape(await deactivateLookupTable(conn, authority, args.table, opts));
          case "close":
            return shape(await closeLookupTable(conn, authority, args.table, { ...opts, recipient: args.recipient }));
        }
      },
    ),
  );

  server.registerTool(
    "inspect_lookup_table",
    {
      description:
        "Read an address lookup table: authority (null = frozen), addresses (with index), active, deactivationSlot, lastExtendedSlot (addresses appended in that slot become usable from the next one). Missing → ALT_NOT_FOUND. Read-only.",
      inputSchema: {
        table: z.string().describe("Lookup table address."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { table: string; cluster?: string }) => {
      const conn = connections.get(args.cluster);
      const info = await inspectLookupTable(conn, args.table);
      return { cluster: conn.cluster, ...info, count: info.addresses.length };
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
