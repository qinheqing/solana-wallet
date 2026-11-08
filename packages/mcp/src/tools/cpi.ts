/**
 * CPI forwarder tools (PRD T-I): move tokens through the `solwallet_cpi`
 * program so the TransferChecked lands as an *inner* instruction — the only
 * way to produce CPI-originated token movements on demand for exercising
 * inspect_transaction. All logic lives in @solwallet/core (transfer/cpi.ts).
 */
import { cpiTokenTransfer, parseAmount } from "@solwallet/core";
import { PublicKey } from "@solana/web3.js";

import type { ToolDeps } from "../types.js";

type McpServer = import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

export function registerCpiTools(
  server: McpServer,
  deps: ToolDeps,
  z: typeof import("zod").z,
): void {
  const { connections, run, store } = deps;

  server.registerTool(
    "cpi_token_transfer",
    {
      description:
        "Send SPL / Token-2022 tokens THROUGH the solwallet_cpi forwarder program (instruction forward_transfer_checked) so the TransferChecked executes as an inner (CPI) instruction — use this to produce CPI-originated token movements for inspect_transaction. The wallet signs as source authority; no PDA custody is involved. The program must already be deployed on the target cluster (core `deployCpiProgram`, packages/cpi-program) — pass its id as programId. Auto-creates the destination ATA (idempotent) unless allowAtaCreation=false. Returns signature, slot, fee, program kind, both ATAs, amountBaseUnits and the compiled plan; failures come back in-band as `error`.",
      inputSchema: {
        walletName: z.string().describe("Loaded wallet that owns the source token account, signs and pays fees."),
        programId: z.string().describe("Deployed solwallet_cpi program id (base58)."),
        destination: z.string().describe("Destination OWNER wallet address (base58); its ATA is derived."),
        mint: z.string().describe("Token mint address (base58). SPL Token or Token-2022 is detected on chain."),
        amount: z.string().describe("Human-readable token amount matching decimals, e.g. \"1.5\"."),
        decimals: z.number().int().min(0).max(18).describe("Mint decimals (transferChecked validates them on chain)."),
        allowAtaCreation: z.boolean().optional().describe("Create the destination ATA when missing. Default true."),
        cluster: clusterParam(z, deps),
        dryRun: z.boolean().optional().describe("Simulate only; nothing is sent."),
        allowMainnet: z.literal(true).optional().describe("Required literal true to send on mainnet-beta."),
      },
    },
    run(
      async (args: {
        walletName: string;
        programId: string;
        destination: string;
        mint: string;
        amount: string;
        decimals: number;
        allowAtaCreation?: boolean;
        cluster?: string;
        dryRun?: boolean;
        allowMainnet?: boolean;
      }) => {
        const conn = connections.get(args.cluster);
        const from = store.require(args.walletName).keypair;
        const amount = parseAmount(args.amount, args.decimals);
        const result = await cpiTokenTransfer(conn, {
          programId: new PublicKey(args.programId),
          from,
          destination: new PublicKey(args.destination),
          mint: new PublicKey(args.mint),
          amount,
          decimals: args.decimals,
          allowAtaCreation: args.allowAtaCreation,
          allowMainnet: args.allowMainnet,
          dryRun: args.dryRun,
        });
        const { amount: _raw, ...rest } = result;
        return { ok: !result.error, ...rest, amountBaseUnits: amount.toString() };
      },
    ),
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
