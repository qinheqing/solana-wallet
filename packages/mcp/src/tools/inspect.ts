/**
 * Observation tools (T-A / T-E): address derivation, mint / token-account
 * inspection and transaction decoding. All read-only; amounts are raw base
 * units as strings — never uiAmount.
 */
import {
  deriveTokenAddresses,
  inspectMint,
  inspectTokenAccount,
  inspectTransaction,
} from "@solwallet/core";

import type { ToolDeps } from "../types.js";

export function registerInspectTools(
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
  deps: ToolDeps,
  z: typeof import("zod").z,
): void {
  const { connections, run } = deps;

  server.registerTool(
    "derive_address",
    {
      description:
        "Derive the associated token addresses (ATA) of an owner for a mint under BOTH token programs (legacy SPL Token and Token-2022), offline. Each result carries programId and isOffCurve. Off-curve owners (PDAs) are refused unless allowOwnerOffCurve is true.",
      inputSchema: {
        owner: z.string().describe("Owner wallet address (base58)."),
        mint: z.string().describe("Mint address (base58)."),
        allowOwnerOffCurve: z
          .boolean()
          .optional()
          .describe("Permit a PDA owner. Default false (OWNER_OFF_CURVE error)."),
      },
    },
    run((args: { owner: string; mint: string; allowOwnerOffCurve?: boolean }) =>
      deriveTokenAddresses(args),
    ),
  );

  server.registerTool(
    "inspect_mint",
    {
      description:
        "Read a mint: program (spl-token | token-2022), decimals, supply (raw), authorities and every Token-2022 extension decoded (TransferFeeConfig older/newer bps + maxFee + withheld, PermanentDelegate, TransferHook, ScaledUiAmount, MetadataPointer, TokenMetadata, InterestBearingConfig, DefaultAccountState, NonTransferable, ConfidentialTransferMint…), plus accountLen = expected ATA byte length.",
      inputSchema: {
        mint: z.string().describe("Mint address (base58)."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { mint: string; cluster?: string }) => {
      const conn = connections.get(args.cluster);
      return { cluster: conn.cluster, ...(await inspectMint(conn, args.mint)) };
    }),
  );

  server.registerTool(
    "inspect_token_account",
    {
      description:
        "Read a token account (ATA): owner, mint, amount (raw), delegate, state, closeAuthority and account-level Token-2022 extensions (MemoTransfer, ImmutableOwner, CpiGuard, TransferFeeAmount withheld, NonTransferableAccount, TransferHookAccount), plus dataLength.",
      inputSchema: {
        address: z.string().describe("Token account address (base58) — not the wallet; use derive_address first."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { address: string; cluster?: string }) => {
      const conn = connections.get(args.cluster);
      return { cluster: conn.cluster, ...(await inspectTokenAccount(conn, args.address)) };
    }),
  );

  server.registerTool(
    "inspect_transaction",
    {
      description:
        "Decode a transaction into token movements (program, instructionType, isInner, source/dest + owners, authority, mint, declared amount, fee {amount, source: instruction | balance-delta}, balanceDelta), per-account balanceChanges, decoded InstructionError (Token / Token-2022 enum name) and warnings. Pass a signature (fetched with jsonParsed, maxSupportedTransactionVersion 0) or a getTransaction JSON string (fully offline).",
      inputSchema: {
        signature: z.string().optional().describe("Transaction signature to fetch. Provide this or json."),
        json: z
          .string()
          .optional()
          .describe('Raw getTransaction(jsonParsed) response as a JSON string. Provide this or signature.'),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { signature?: string; json?: string; cluster?: string }) => {
      if (Boolean(args.signature) === Boolean(args.json)) {
        throw new Error("Provide exactly one of signature or json.");
      }
      const conn = connections.get(args.cluster);
      if (args.json) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(args.json);
        } catch {
          throw new Error("Invalid input: json is not valid JSON text.");
        }
        return { cluster: conn.cluster, ...(await inspectTransaction({ json: parsed, cluster: conn.cluster, rpcUrl: conn.rpcUrl })) };
      }
      return { cluster: conn.cluster, ...(await inspectTransaction({ conn, signature: args.signature! })) };
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
