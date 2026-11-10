/**
 * Observation tools (T-A / T-E): address derivation, mint / token-account
 * inspection and transaction decoding. All read-only; amounts are raw base
 * units as strings — never uiAmount — with `*Display` hints where the
 * decimals are known.
 */
import {
  decodeMetaplexMetadata,
  deriveTokenAddresses,
  inspectMint,
  inspectSignedTransaction,
  metaplexMetadataPda,
  inspectTokenAccount,
  inspectTransaction,
  type TransactionInspection,
} from "@sol-wallet/core";

import { PublicKey } from "@solana/web3.js";

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
        "Read a mint: program (spl-token | token-2022), decimals, supply (raw + supplyDisplay), authorities and every Token-2022 extension decoded (TransferFeeConfig older/newer bps + maxFee + withheld, PermanentDelegate, TransferHook, ScaledUiAmount, MetadataPointer, TokenMetadata, InterestBearingConfig, DefaultAccountState, NonTransferable, ConfidentialTransferMint…), plus accountLen = expected ATA byte length, and metaplexMetadata {name, symbol, uri, updateAuthority} when a Metaplex Token Metadata account exists (classic SPL tokens keep their name/symbol there; null otherwise).",
      inputSchema: {
        mint: z.string().describe("Mint address (base58)."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { mint: string; cluster?: string }) => {
      const conn = connections.get(args.cluster);
      const mint = await inspectMint(conn, args.mint);
      let metaplexMetadata: ReturnType<typeof decodeMetaplexMetadata> = null;
      try {
        const pda = await conn.connection.getAccountInfo(metaplexMetadataPda(new PublicKey(args.mint)));
        metaplexMetadata = pda ? decodeMetaplexMetadata(pda.data) : null;
      } catch {
        metaplexMetadata = null; // best effort: the mint itself was read fine
      }
      return { cluster: conn.cluster, ...mint, supplyDisplay: display(mint.supply, mint.decimals), metaplexMetadata };
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

  server.registerTool(
    "inspect_raw_transaction",
    {
      description:
        "Decode a serialized transaction (base58 / base64 / hex, auto-detected) — e.g. a signedTransaction that may never have landed. Offline: version, size, transaction id (first signature), fee payer, recentBlockhash, header, every signature ed25519-verified against the message (valid | invalid | missing), accounts with signer/writable flags (v0 lookup-table entries flagged), and every instruction with programName and a decoded {type, info} for System / Compute Budget / SPL Token / Token-2022 / Associated Token Account / Memo (others: raw dataHex). With checkChain (default true) it also resolves address lookup tables and reports `chain`: {status: processed | confirmed | finalized | not-found, slot, err, blockhashValid} — not-found + blockhashValid=false means expired or built for another cluster. When it landed, call inspect_transaction with the signature for execution results (balance changes, token movements).",
      inputSchema: {
        transaction: z.string().describe("Serialized transaction: base58, base64 or hex (0x optional)."),
        checkChain: z
          .boolean()
          .optional()
          .describe("Query the cluster for signature status, blockhash validity and lookup tables. Default true; false = fully offline."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { transaction: string; checkChain?: boolean; cluster?: string }) => {
      if (args.checkChain === false) {
        return { cluster: null, ...rawWithDisplays(await inspectSignedTransaction(args.transaction)) };
      }
      const conn = connections.get(args.cluster);
      return { cluster: conn.cluster, ...rawWithDisplays(await inspectSignedTransaction(args.transaction, conn)) };
    }),
  );
}

/** Lamport display hints for decoded raw-transaction instruction params. */
function rawWithDisplays(tx: Awaited<ReturnType<typeof inspectSignedTransaction>>) {
  return {
    ...tx,
    instructions: tx.instructions.map((ix) => {
      const lamports = ix.decoded?.info.lamports;
      return typeof lamports === "string" || typeof lamports === "number"
        ? { ...ix, lamportsDisplay: solDisplay(String(lamports)) }
        : ix;
    }),
  };
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
