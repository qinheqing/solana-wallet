/**
 * Transfer tools (F4 surface): single / batch / mixed transfers.
 * Amounts are human-readable strings converted by @solwallet/core exactly.
 */
import {
  buildTransferInstructions,
  parseAmount,
  parseTransactionError,
  solToLamports,
} from "@solwallet/core";
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import type { ToolDeps } from "../types.js";

type McpServer = import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

interface SendOptions {
  walletName: string;
  cluster?: string;
  dryRun?: boolean;
  allowMainnet?: boolean;
  feePriority?: string;
}

function resolveFrom(deps: ToolDeps, walletName: string): Keypair {
  return deps.store.require(walletName).keypair;
}

/** Build + optionally send one compiled transaction, dry-run aware. */
async function sendInstructions(
  conn: ReturnType<ToolDeps["connections"]["get"]>,
  from: Keypair,
  instructions: import("@solana/web3.js").TransactionInstruction[],
  opts: { dryRun?: boolean; allowMainnet?: boolean },
) {
  const { blockhash } = await conn.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: from.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([from]);

  if (opts.dryRun) {
    const result = await conn.connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    return {
      simulatedOnly: true,
      ok: result.value.err === null,
      logs: result.value.logs ?? [],
      unitsConsumed: result.value.unitsConsumed ?? undefined,
      err: result.value.err,
      signature: "",
      slot: 0,
      feeLamports: 0,
    };
  }

  const sent = await conn.sendWithRetry(tx, { allowMainnet: opts.allowMainnet });
  return {
    simulatedOnly: false,
    ok: true,
    signature: sent.signature,
    slot: sent.slot,
    feeLamports: sent.feeLamports,
    logs: undefined,
    unitsConsumed: undefined,
    err: null,
  };
}

export function registerTransferTools(
  server: McpServer,
  deps: ToolDeps,
  z: typeof import("zod").z,
): void {
  const { connections, run } = deps;

  server.registerTool(
    "transfer",
    {
      description:
        "Send a single transfer: native SOL (omit mint) or SPL/Token-2022 tokens (provide mint + decimals). Auto-creates the destination token account unless allowAtaCreation=false. Returns signature, slot, fee.",
      inputSchema: {
        walletName: z.string().describe("Loaded wallet paying fees and sending funds."),
        to: z.string().describe("Recipient address (wallet address for tokens; their ATA is derived automatically)."),
        amount: z.string().describe("Human-readable amount, e.g. \"1.5\" (SOL) or token units matching decimals."),
        mint: z.string().optional().describe("Token mint address. Omit for native SOL."),
        decimals: z.number().int().min(0).max(18).optional().describe("Required for token transfers (transferChecked on-chain validation)."),
        allowAtaCreation: z.boolean().optional().describe("Auto-create destination token account (~0.002 SOL rent). Default true."),
        dryRun: z.boolean().optional().describe("Simulate only — returns logs without sending."),
        allowMainnet: z.literal(true).optional().describe("Required literal true to send on mainnet-beta."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: SendOptions & {
      to: string;
      amount: string;
      mint?: string;
      decimals?: number;
      allowAtaCreation?: boolean;
    }) => {
      const conn = connections.get(args.cluster);
      const from = resolveFrom(deps, args.walletName);
      const mint = args.mint ? new PublicKey(args.mint) : undefined;

      // Exact conversion: SOL via lamports; tokens via decimals-aware parse.
      const base = args.mint
        ? parseAmount(args.amount, args.decimals ?? 0)
        : solToLamports(args.amount);
      if (!args.mint && args.decimals !== undefined) {
        throw new Error("decimals is only valid for token transfers.");
      }

      const built = await buildTransferInstructions(conn, {
        payer: from.publicKey,
        destination: new PublicKey(args.to),
        mint,
        amount: base,
        decimals: args.decimals,
        allowAtaCreation: args.allowAtaCreation,
      });

      const result = await sendInstructions(conn, from, built.instructions, {
        dryRun: args.dryRun,
        allowMainnet: args.allowMainnet,
      });
      return {
        ...result,
        program: built.program?.kind ?? "system",
        destinationAtaCreated: built.destinationAtaCreated,
        amountBaseUnits: base.toString(),
      };
    }),
  );

  server.registerTool(
    "batch_transfer",
    {
      description:
        "Send one token/SOL amount pattern to many recipients. Instructions are chunked into multiple transactions (default ≤5 instructions per tx) sent serially; each chunk reports independently.",
      inputSchema: {
        walletName: z.string().describe("Loaded wallet paying fees and sending funds."),
        recipients: z
          .array(
            z.object({
              to: z.string().describe("Recipient address."),
              amount: z.string().describe("Human-readable amount for THIS recipient."),
            }),
          )
          .min(1)
          .max(50)
          .describe("1–50 recipients."),
        mint: z.string().optional().describe("Token mint. Omit for SOL."),
        decimals: z.number().int().optional().describe("Required for token transfers."),
        chunkSize: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("Max instructions per transaction. Default 5."),
        dryRun: z.boolean().optional().describe("Simulate every chunk without sending."),
        allowMainnet: z.literal(true).optional().describe("Required literal true for mainnet-beta."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: SendOptions & {
      recipients: Array<{ to: string; amount: string }>;
      mint?: string;
      decimals?: number;
      chunkSize?: number;
    }) => {
      const conn = connections.get(args.cluster);
      const from = resolveFrom(deps, args.walletName);
      const mint = args.mint ? new PublicKey(args.mint) : undefined;
      const chunkSize = args.chunkSize ?? 5;

      const built: { to: string; instructions: import("@solana/web3.js").TransactionInstruction[] }[] = [];
      for (const r of args.recipients) {
        const amount = mint ? parseAmount(r.amount, args.decimals ?? 0) : solToLamports(r.amount);
        const res = await buildTransferInstructions(conn, {
          payer: from.publicKey,
          destination: new PublicKey(r.to),
          mint,
          amount,
          decimals: args.decimals,
        });
        built.push({ to: r.to, instructions: res.instructions });
      }

      // Chunk per-transaction instruction count, sending serially.
      const chunks: { to: string; instructions: typeof built[number]["instructions"] }[] = [];
      for (const b of built) {
        const last = chunks.at(-1);
        if (last && last.instructions.length + b.instructions.length <= chunkSize) {
          last.instructions.push(...b.instructions);
          last.to += `, ${b.to}`;
        } else {
          chunks.push({ to: b.to, instructions: [...b.instructions] });
        }
      }

      const results: unknown[] = [];
      for (const [i, chunk] of chunks.entries()) {
        try {
          const r = await sendInstructions(conn, from, chunk.instructions, {
            dryRun: args.dryRun,
            allowMainnet: args.allowMainnet,
          });
          results.push({ chunk: i + 1, recipients: chunk.to.split(", ").length, ...r });
        } catch (error) {
          results.push({
            chunk: i + 1,
            recipients: chunk.to.split(", ").length,
            ...(parseTransactionError(error)),
            failedChunk: true,
          });
          break; // serial: stop at first failed chunk, report the rest as skipped
        }
      }
      const failed = results.filter((r) => (r as { failedChunk?: boolean }).failedChunk).length;
      return {
        totalRecipients: args.recipients.length,
        chunks: results,
        summary:
          failed === 0
            ? `All ${chunks.length} chunk(s) ${args.dryRun ? "simulated" : "sent"} successfully.`
            : `${chunks.length - failed}/${chunks.length} chunks succeeded; remaining chunks skipped.`,
      };
    }),
  );

  server.registerTool(
    "mixed_transfer",
    {
      description:
        "One transaction containing multiple legs: native SOL plus any number of different SPL/Token-2022 mints. All legs share one signature.",
      inputSchema: {
        walletName: z.string().describe("Loaded wallet paying fees and sending funds."),
        legs: z
          .array(
            z.object({
              kind: z.enum(["sol", "token"]).describe("Leg type."),
              to: z.string().describe("Recipient address."),
              amount: z.string().describe("Human-readable amount (SOL units for sol legs)."),
              mint: z.string().optional().describe("Mint address (token legs only)."),
              decimals: z.number().int().optional().describe("Decimals (token legs only)."),
            }),
          )
          .min(2)
          .max(10)
          .describe("2–10 legs; mixing kinds encouraged."),
        dryRun: z.boolean().optional().describe("Simulate without sending."),
        allowMainnet: z.literal(true).optional().describe("Required literal true for mainnet-beta."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: SendOptions & {
      legs: Array<{
        kind: "sol" | "token";
        to: string;
        amount: string;
        mint?: string;
        decimals?: number;
      }>;
    }) => {
      const conn = connections.get(args.cluster);
      const from = resolveFrom(deps, args.walletName);

      const allInstructions: import("@solana/web3.js").TransactionInstruction[] = [];
      const legSummary: Array<{ kind: string; to: string; amount: string }> = [];
      for (const leg of args.legs) {
        if (leg.kind === "sol" && (leg.mint || leg.decimals !== undefined)) {
          throw new Error("sol legs must not set mint/decimals.");
        }
        if (leg.kind === "token" && (!leg.mint || leg.decimals === undefined)) {
          throw new Error("token legs require mint and decimals.");
        }
        const amount = leg.kind === "sol" ? solToLamports(leg.amount) : parseAmount(leg.amount, leg.decimals ?? 0);
        const built = await buildTransferInstructions(conn, {
          payer: from.publicKey,
          destination: new PublicKey(leg.to),
          mint: leg.kind === "token" ? new PublicKey(leg.mint!) : undefined,
          amount,
          decimals: leg.decimals,
        });
        allInstructions.push(...built.instructions);
        legSummary.push({ kind: leg.kind, to: leg.to, amount: leg.amount });
      }

      const result = await sendInstructions(conn, from, allInstructions, {
        dryRun: args.dryRun,
        allowMainnet: args.allowMainnet,
      });
      return { ...result, legs: legSummary };
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
