/**
 * Observation tools (T-A / T-E): address derivation, mint / token-account
 * inspection and transaction decoding. All read-only; amounts are raw base
 * units as strings — never uiAmount — with `*Display` hints where the
 * decimals are known.
 */
import {
  deriveTokenAddresses,
  inspectMint,
  inspectTokenAccount,
  inspectTransaction,
  type TransactionInspection,
} from "@solwallet/core";

import { display, solDisplay } from "../amounts.js";
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
        "Read a mint: program (spl-token | token-2022), decimals, supply (raw + supplyDisplay), authorities and every Token-2022 extension decoded (TransferFeeConfig older/newer bps + maxFee + withheld, PermanentDelegate, TransferHook, ScaledUiAmount, MetadataPointer, TokenMetadata, InterestBearingConfig, DefaultAccountState, NonTransferable, ConfidentialTransferMint…), plus accountLen = expected ATA byte length.",
      inputSchema: {
        mint: z.string().describe("Mint address (base58)."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { mint: string; cluster?: string }) => {
      const conn = connections.get(args.cluster);
      const mint = await inspectMint(conn, args.mint);
      return { cluster: conn.cluster, ...mint, supplyDisplay: display(mint.supply, mint.decimals) };
    }),
  );

  server.registerTool(
    "inspect_token_account",
    {
      description:
        "Read a token account (ATA): owner, mint, decimals, amount (raw + amountDisplay), delegate, state, closeAuthority and account-level Token-2022 extensions (MemoTransfer, ImmutableOwner, CpiGuard, TransferFeeAmount withheld, NonTransferableAccount, TransferHookAccount), plus dataLength.",
      inputSchema: {
        address: z.string().describe("Token account address (base58) — not the wallet; use derive_address first."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { address: string; cluster?: string }) => {
      const conn = connections.get(args.cluster);
      const account = await inspectTokenAccount(conn, args.address);
      let decimals: number | null = null;
      try {
        decimals = (await inspectMint(conn, account.mint)).decimals;
      } catch {
        decimals = null; // display hints are best-effort; the raw amount is authoritative
      }
      return {
        cluster: conn.cluster,
        ...account,
        decimals,
        amountDisplay: display(account.amount, decimals),
        delegatedAmountDisplay: display(account.delegatedAmount, decimals),
      };
    }),
  );

  server.registerTool(
    "inspect_transaction",
    {
      description:
        "Decode a transaction into token movements (program, instructionType, isInner, source/dest + owners, authority, mint, declared amount (+ amountDisplay), fee {amount, source: instruction | balance-delta}, balanceDelta (+ balanceDeltaDisplay)), per-account balanceChanges, native SOL solMovements (System Program transfer / createAccount / …, lamports + lamportsDisplay) and solBalanceChanges (lamport pre/post/delta from meta; the fee payer's delta includes the fee), decoded InstructionError (Token / Token-2022 enum name) and warnings. Pass a signature (fetched with jsonParsed, maxSupportedTransactionVersion 0) or a getTransaction JSON string (fully offline).",
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
        return { cluster: conn.cluster, ...withDisplays(await inspectTransaction({ json: parsed, cluster: conn.cluster, rpcUrl: conn.rpcUrl })) };
      }
      return { cluster: conn.cluster, ...withDisplays(await inspectTransaction({ conn, signature: args.signature! })) };
    }),
  );
}

/** Add display hints next to the raw movement / balance-change figures (decimals known from the parsed tx). */
function withDisplays(tx: TransactionInspection) {
  return {
    ...tx,
    feeDisplay: solDisplay(tx.fee),
    movements: tx.movements.map((m) => ({
      ...m,
      amountDisplay: display(m.amount, m.decimals),
      feeDisplay: display(m.fee?.amount ?? null, m.decimals),
      balanceDeltaDisplay: display(m.balanceDelta, m.decimals),
    })),
    balanceChanges: tx.balanceChanges.map((c) => ({ ...c, deltaDisplay: display(c.delta, c.decimals) })),
    solMovements: tx.solMovements.map((m) => ({ ...m, lamportsDisplay: solDisplay(m.lamports) })),
    solBalanceChanges: tx.solBalanceChanges.map((c) => ({ ...c, deltaDisplay: solDisplay(c.delta) })),
  };
}

function clusterParam(z: typeof import("zod").z, deps: ToolDeps) {
  return z
    .string()
    .optional()
    .describe(
      `Cluster name (devnet | testnet | mainnet-beta) or RPC URL. Default: ${deps.connections.defaultCluster()} (env SOLWALLET_CLUSTER).`,
    );
}
