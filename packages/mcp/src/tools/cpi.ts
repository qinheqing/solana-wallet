/**
 * CPI forwarder tools (PRD T-I): move tokens through the `solwallet_cpi`
 * program so the TransferChecked lands as an *inner* instruction — the only
 * way to produce CPI-originated token movements on demand for exercising
 * inspect_transaction. All logic lives in @solwallet/core (transfer/cpi.ts).
 */
import { cpiTokenTransfer } from "@solwallet/core";
import { PublicKey } from "@solana/web3.js";

import { baseUnitParam, DECIMALS_OPTIONAL_DESC, display, parseBaseUnits, resolveDecimals, solDisplay } from "../amounts.js";
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
        "Send SPL / Token-2022 tokens THROUGH the solwallet_cpi forwarder program (instruction forward_transfer_checked) so the TransferChecked executes as an inner (CPI) instruction — use this to produce CPI-originated token movements for inspect_transaction. The wallet signs as source authority; no PDA custody is involved. The program must already be deployed on the target cluster (core `deployCpiProgram`, packages/cpi-program) — pass its id as programId. Auto-creates the destination ATA (idempotent) unless allowAtaCreation=false. `amount` is token BASE UNITS (decimals optional, read from the mint when omitted). Returns signature, slot, fee, program kind, both ATAs, amountBaseUnits (+ amountDisplay) and the compiled plan; failures come back in-band as `error`.",
      inputSchema: {
        walletName: z.string().describe("Loaded wallet that owns the source token account, signs and pays fees."),
        programId: z.string().describe("Deployed solwallet_cpi program id (base58)."),
        destination: z.string().describe("Destination OWNER wallet address (base58); its ATA is derived."),
        mint: z.string().describe("Token mint address (base58). SPL Token or Token-2022 is detected on chain."),
        amount: baseUnitParam(z, "Token amount to forward"),
        decimals: z.number().int().min(0).max(18).optional().describe(DECIMALS_OPTIONAL_DESC),
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
        decimals?: number;
        allowAtaCreation?: boolean;
        cluster?: string;
        dryRun?: boolean;
        allowMainnet?: boolean;
      }) => {
        const conn = connections.get(args.cluster);
        const from = store.require(args.walletName).keypair;
        const amount = parseBaseUnits(args.amount, "amount", { decimals: args.decimals, kind: "token" });
        const decimals = (await resolveDecimals(conn, args.mint, args.decimals))!;
        const result = await cpiTokenTransfer(conn, {
          programId: new PublicKey(args.programId),
          from,
          destination: new PublicKey(args.destination),
          mint: new PublicKey(args.mint),
          amount,
          decimals,
          allowAtaCreation: args.allowAtaCreation,
          allowMainnet: args.allowMainnet,
          dryRun: args.dryRun,
        });
        const { amount: _raw, ...rest } = result;
        return {
          ok: !result.error,
          ...rest,
          feeDisplay: solDisplay(result.feeLamports),
          amountBaseUnits: amount.toString(),
          amountDisplay: display(amount, decimals),
          decimals,
        };
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
