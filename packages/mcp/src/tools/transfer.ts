/**
 * Transfer tools (F4 surface): single / batch / mixed transfers.
 * Amounts are human-readable strings converted by @solwallet/core exactly;
 * batching / merging orchestration lives entirely in core.
 */
import {
  buildTransferInstructions,
  executeBatchTransfer,
  executeMixedTransfer,
  parseAmount,
  solToLamports,
  type BatchItem,
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
        "Send one token/SOL amount pattern to many recipients. Core splits them into size-aware batches (instruction count + 1232-byte budget) sent serially; each batch reports per-recipient results.",
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
          .describe("Max instructions per transaction. Default 8."),
        onFailure: z
          .enum(["stop", "continue"])
          .optional()
          .describe("'stop' (default): abort after a failed batch, remaining recipients reported as skipped. 'continue': keep sending later batches."),
        dryRun: z.boolean().optional().describe("Simulate every batch without sending."),
        allowMainnet: z.literal(true).optional().describe("Required literal true for mainnet-beta."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: SendOptions & {
      recipients: Array<{ to: string; amount: string }>;
      mint?: string;
      decimals?: number;
      chunkSize?: number;
      onFailure?: "stop" | "continue";
    }) => {
      const conn = connections.get(args.cluster);
      const from = resolveFrom(deps, args.walletName);
      const mint = args.mint ? new PublicKey(args.mint) : undefined;

      // Exact amount conversion stays at the MCP layer; instruction
      // building + splitting + sending are core responsibilities.
      const items: BatchItem[] = [];
      for (const r of args.recipients) {
        const amount = mint ? parseAmount(r.amount, args.decimals ?? 0) : solToLamports(r.amount);
        const built = await buildTransferInstructions(conn, {
          payer: from.publicKey,
          destination: new PublicKey(r.to),
          mint,
          amount,
          decimals: args.decimals,
        });
        items.push({ destination: new PublicKey(r.to), instructions: built.instructions });
      }

      const batches = await executeBatchTransfer(conn, from, items, {
        maxInstructionsPerTx: args.chunkSize,
        onFailure: args.onFailure,
        dryRun: args.dryRun,
        allowMainnet: args.allowMainnet,
      });

      const chunks = batches.map((b) => {
        const firstFailure = b.results.find((r) => r.status === "failed");
        const ok = b.results.every((r) => r.status === "success");
        return {
          chunk: b.batchIndex + 1,
          recipients: b.results.length,
          estimatedBytes: b.estimatedBytes,
          ok,
          simulatedOnly: args.dryRun === true,
          signature: b.signatures[0],
          signatures: b.signatures,
          slot: b.slot,
          feeLamports: b.feeLamports,
          logs: b.logs,
          failedChunk: firstFailure !== undefined,
          ...(firstFailure?.error
            ? {
                code: firstFailure.error.code,
                message: firstFailure.error.message,
                suggestion: firstFailure.error.suggestion,
              }
            : {}),
          results: b.results.map((r) => ({
            to: r.to,
            status: r.status,
            signature: r.signature,
            ...(r.error
              ? { code: r.error.code, message: r.error.message, suggestion: r.error.suggestion }
              : {}),
          })),
        };
      });
      const failed = chunks.filter((c) => c.failedChunk).length;
      const skipped = chunks.reduce((n, c) => n + c.results.filter((r) => r.status === "skipped").length, 0);
      return {
        totalRecipients: args.recipients.length,
        chunks,
        skippedRecipients: skipped,
        summary:
          failed === 0
            ? `All ${chunks.length} batch(es) ${args.dryRun ? "simulated" : "sent"} successfully.`
            : `${chunks.length - failed}/${chunks.length} batches succeeded; ${skipped} recipient(s) skipped.`,
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

      // Amount strings → exact base units here; validation, instruction
      // building (program dispatch + ATA), size guard and sending are core.
      const legs = args.legs.map((leg) => ({
        kind: leg.kind,
        to: new PublicKey(leg.to),
        amount:
          leg.kind === "sol" ? solToLamports(leg.amount) : parseAmount(leg.amount, leg.decimals ?? 0),
        mint: leg.kind === "token" ? new PublicKey(leg.mint!) : undefined,
        decimals: leg.decimals,
      }));

      const result = await executeMixedTransfer(conn, from, legs, {
        dryRun: args.dryRun,
        allowMainnet: args.allowMainnet,
      });
      return {
        ok: result.error === undefined,
        simulatedOnly: result.simulatedOnly,
        signature: result.signature,
        slot: result.slot,
        feeLamports: result.feeLamports,
        logs: result.logs,
        unitsConsumed: result.unitsConsumed,
        ...(result.error ? { error: result.error } : {}),
        legs: result.legs.map((l, i) => ({
          kind: l.kind,
          to: l.to,
          amount: args.legs[i]?.amount ?? l.amountBaseUnits,
          amountBaseUnits: l.amountBaseUnits,
          program: l.program,
          destinationAtaCreated: l.destinationAtaCreated,
          destinationAta: l.destinationAta,
        })),
      };
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
