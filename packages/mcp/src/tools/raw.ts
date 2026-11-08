/**
 * Raw transaction tools (PRD T-D): sign / simulate / send a serialized
 * transaction supplied as hex or base64. Lets an external service build a
 * payload for us to sign, or lets us build one (build_transfer) for an
 * external submitter. All logic lives in @solwallet/core (raw.ts).
 */
import { sendRaw, signTransactionHex, simulateRaw } from "@solwallet/core";

import type { ToolDeps } from "../types.js";

type McpServer = import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

const TX_PARAM_DESCRIPTION =
  "Serialized transaction (signatures + message) as a hex string; base64 is also accepted and auto-detected. Legacy and v0 formats both work. The response reports which encoding was used.";

export function registerRawTools(
  server: McpServer,
  deps: ToolDeps,
  z: typeof import("zod").z,
): void {
  const { connections, run, store } = deps;

  server.registerTool(
    "sign_transaction",
    {
      description:
        "Partially sign a serialized transaction with one or more loaded wallets and return the re-serialized transaction (hex + base64) plus every signature slot. Nothing is sent. Wallets that the transaction does not require are rejected (SIGNER_NOT_REQUIRED). Use fullySigned to know whether send_transaction can proceed.",
      inputSchema: {
        transaction: z.string().describe(TX_PARAM_DESCRIPTION),
        walletNames: z
          .array(z.string())
          .min(1)
          .describe("Loaded wallet names whose keypairs sign. Each must be a required signer of the message."),
      },
    },
    run(async (args: { transaction: string; walletNames: string[] }) => {
      const signers = args.walletNames.map((name) => store.require(name).keypair);
      return signTransactionHex(args.transaction, signers);
    }),
  );

  server.registerTool(
    "simulate_transaction",
    {
      description:
        "Simulate a serialized transaction against the cluster (signatures are not verified, blockhash is replaced) and return ok/logs/unitsConsumed/err. Never sends.",
      inputSchema: {
        transaction: z.string().describe(TX_PARAM_DESCRIPTION),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { transaction: string; cluster?: string }) => {
      const conn = connections.get(args.cluster);
      return simulateRaw(conn, args.transaction);
    }),
  );

  server.registerTool(
    "send_transaction",
    {
      description:
        "Send a FULLY signed serialized transaction through the retry/confirm policy and return signature/slot/fee. Refuses unsigned slots (TX_NOT_FULLY_SIGNED). mainnet-beta requires allowMainnet: true (literal).",
      inputSchema: {
        transaction: z.string().describe(TX_PARAM_DESCRIPTION),
        allowMainnet: z.literal(true).optional().describe("Required literal true to send on mainnet-beta."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { transaction: string; allowMainnet?: boolean; cluster?: string }) => {
      const conn = connections.get(args.cluster);
      const sent = await sendRaw(conn, args.transaction, { allowMainnet: args.allowMainnet });
      return { ok: true, ...sent };
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
