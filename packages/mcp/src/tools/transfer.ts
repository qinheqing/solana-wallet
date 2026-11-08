/**
 * Transfer tools (F4 surface): single / batch / mixed transfers.
 * All amounts are integer strings in BASE UNITS (lamports / token base
 * units); outputs echo the raw value plus a `*Display` hint. Token decimals
 * are resolved from the mint when omitted. Batching / merging orchestration
 * lives entirely in core.
 */
import {
  approveDelegate,
  buildTransferInstructions,
  buildTransferPlan,
  executeBatchTransfer,
  executeMixedTransfer,
  preflightTransfer,
  revokeDelegate,
  transfer,
  type AtaMode,
  type BatchItem,
  type BuildTransferOptions,
  type MixedLeg,
  type PreflightResult,
  type TransferInstructionKind,
} from "@solwallet/core";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  baseUnitParam,
  DECIMALS_OPTIONAL_DESC,
  display,
  parseBaseUnits,
  resolveDecimals,
  SOL_DECIMALS,
  solDisplay,
} from "../amounts.js";
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
        "Send a single transfer: native SOL (omit mint) or SPL/Token-2022 tokens (provide mint; decimals optional, read from the mint when omitted). `amount` is BASE UNITS (lamports / token base units). Auto-creates the destination token account unless allowAtaCreation=false. Runs preflight_transfer first: block-level findings (transfer hook, memo required, frozen, non-transferable, insufficient balance, authority not a delegate, fee mismatch, unchecked transfer on a fee/hook mint) return error.code=PREFLIGHT_BLOCKED with `preflight.findings` instead of sending — pass force=true to send anyway. Returns signature, slot, fee, plan and preflight; on-chain rejections come back in-band as `error` with `custom` {code, name, programId} (e.g. 36 NoMemo) next to plan and preflight. Delegate / PermanentDelegate transfer (moving another owner's tokens): walletName = the delegate wallet (pays fees and signs as authority), sourceOwner = the owner address whose token account is the source; the owner does NOT sign. Use approve_delegate first for a regular delegate; a Token-2022 PermanentDelegate needs no approval.",
      inputSchema: {
        walletName: z.string().describe("Loaded wallet paying fees. It is also the source owner and transfer authority unless sourceOwner / authorityWallet override them."),
        to: z.string().describe("Recipient address (wallet address for tokens; their ATA is derived automatically)."),
        amount: baseUnitParam(z, "Amount to send"),
        mint: z.string().optional().describe("Token mint address. Omit for native SOL."),
        decimals: z.number().int().min(0).max(18).optional().describe(DECIMALS_OPTIONAL_DESC),
        allowAtaCreation: z.boolean().optional().describe("Auto-create destination token account (~0.002 SOL rent). Default true."),
        dryRun: z.boolean().optional().describe("Simulate only — returns logs without sending."),
        allowMainnet: z.literal(true).optional().describe("Required literal true to send on mainnet-beta."),
        cluster: clusterParam(z, deps),
        ...constructionKnobs(z),
        authorityWallet: z.string().optional().describe(
          "Loaded wallet name that signs the token transfer as authority when it is NOT walletName — e.g. walletName pays the fee while the owner (authorityWallet = owner, sourceOwner = owner address) or a delegate signs. Its keypair co-signs the transaction. Not needed when walletName itself is the delegate.",
        ),
        force: z.boolean().optional().describe(
          "Bypass block-level preflight findings and let the validator's own preflight decide; for testing error handling. Findings are still returned in `preflight`.",
        ),
        skipPreflight: z.boolean().optional().describe(
          "Skip the local preflight entirely (no extra account reads, no `preflight` in the output).",
        ),
      },
    },
    run(async (args: SendOptions & TransferArgs & KnobArgs & { authorityWallet?: string; force?: boolean; skipPreflight?: boolean }) => {
      const conn = connections.get(args.cluster);
      const from = resolveFrom(deps, args.walletName);
      const authority = args.authorityWallet ? resolveFrom(deps, args.authorityWallet) : undefined;
      const base = baseUnits(args);
      const decimals = await resolveDecimals(conn, args.mint, args.decimals);
      const options = buildOptions(from.publicKey, args, base, decimals);

      // One pipeline for every caller: core transfer() runs preflight →
      // build → signer check → sign → dryRun | send, and reports failures
      // in-band (parsed, with `custom` for on-chain errors) next to the
      // plan and preflight so nothing is lost on the way out.
      const result = await transfer(conn, {
        from,
        destination: options.destination,
        mint: options.mint,
        amount: base,
        decimals: options.decimals,
        allowAtaCreation: options.allowAtaCreation,
        dryRun: args.dryRun,
        allowMainnet: args.allowMainnet,
        computeBudget: options.computeBudget,
        ataMode: options.ataMode,
        instruction: options.instruction,
        fee: options.fee,
        authority: authority?.publicKey,
        sourceOwner: options.sourceOwner,
        memo: options.memo,
        extraSigners: authority ? [authority] : [],
        force: args.force,
        skipPreflight: args.skipPreflight,
      });
      return {
        ok: result.error === undefined,
        simulatedOnly: result.simulatedOnly,
        signature: result.signature,
        slot: result.slot,
        feeLamports: result.feeLamports,
        feeDisplay: solDisplay(result.feeLamports),
        logs: result.logs,
        unitsConsumed: result.unitsConsumed,
        ...(result.error ? { error: result.error } : {}),
        program: result.program,
        destinationAtaCreated: result.destinationAtaCreated,
        destinationAtaExisted: result.destinationAtaExisted,
        amountBaseUnits: base.toString(),
        amountDisplay: amountDisplay(base, args.mint, decimals),
        decimals: decimals ?? null,
        ...(result.plan ? { plan: result.plan } : {}),
        ...(result.preflight ? { preflight: withFeeDisplay(result.preflight, decimals) } : {}),
      };
    }),
  );

  server.registerTool(
    "preflight_transfer",
    {
      description:
        "Check a transfer BEFORE sending, without signing or building: reads the mint and both token accounts and returns {ok, findings[]} where each finding has code, severity (block | warn | info), message, data. Block codes: TRANSFER_HOOK_PRESENT, MEMO_REQUIRED, ACCOUNT_FROZEN, NON_TRANSFERABLE, SOURCE_ATA_MISSING, INSUFFICIENT_TOKEN_BALANCE, INSUFFICIENT_DELEGATED_AMOUNT, AUTHORITY_NOT_DELEGATE, FEE_MISMATCH (fee ≠ expected → FeeMismatch 32 on chain), UNCHECKED_TRANSFER_REJECTED (instruction=transfer on a Token-2022 mint with TransferFeeConfig/TransferHook → MintRequiredForTransfer 31). Warn: SCALED_UI_AMOUNT, PREFLIGHT_INCOMPLETE. Info: DEST_ATA_MISSING, TRANSFER_FEE (expected fee + net by current epoch), NON_STANDARD_CONSTRUCTION. Same inputs as build_transfer; SOL transfers are always ok. ok=false flags isError so the result is not mistaken for a green light.",
      inputSchema: {
        walletName: z.string().describe("Loaded wallet used as fee payer (and default source owner / authority)."),
        to: z.string().describe("Recipient address (wallet address for tokens; their ATA is derived automatically)."),
        amount: baseUnitParam(z, "Amount to send"),
        mint: z.string().optional().describe("Token mint address. Omit for native SOL (always ok)."),
        decimals: z.number().int().min(0).max(18).optional().describe(DECIMALS_OPTIONAL_DESC),
        allowAtaCreation: z.boolean().optional().describe("With ataMode auto: whether a missing destination ATA would be created. Default true."),
        cluster: clusterParam(z, deps),
        ...constructionKnobs(z),
        authority: z.string().optional().describe(
          "Address that would sign the token transfer as authority when it is NOT walletName (delegate / permanent delegate).",
        ),
      },
    },
    run(async (args: TransferArgs & KnobArgs & { cluster?: string; authority?: string }) => {
      const conn = connections.get(args.cluster);
      const from = resolveFrom(deps, args.walletName);
      const base = baseUnits(args);
      const decimals = await resolveDecimals(conn, args.mint, args.decimals);
      const result: PreflightResult = await preflightTransfer(conn, {
        ...buildOptions(from.publicKey, args, base, decimals),
        authority: args.authority ? new PublicKey(args.authority) : undefined,
      });
      const { resolved, ...rest } = withFeeDisplay(result, decimals);
      return {
        ...rest,
        blocking: rest.findings.filter((f) => f.severity === "block").map((f) => f.code),
        amountBaseUnits: base.toString(),
        amountDisplay: amountDisplay(base, args.mint, decimals),
        decimals: decimals ?? null,
        program: resolved?.program ?? "system",
        mint: resolved?.mint ?? null,
        sourceAta: resolved?.sourceAta ?? null,
        destinationAta: resolved?.destinationAta ?? null,
        epoch: resolved?.epoch ?? null,
      };
    }),
  );

  server.registerTool(
    "build_transfer",
    {
      description:
        "Construct a transfer transaction WITHOUT signing or sending and return its TransactionPlan: every instruction (label, programId, accounts, dataHex), the serialized v0 message hex, estimated wire bytes, required signers and the blockhash. Accepts the same construction knobs as `transfer` (computeUnitLimit/Price, ataMode, instruction, fee, memo, authority, sourceOwner) — non-default values intentionally produce NON-STANDARD transactions for integration testing. Use it to inspect or hand a payload to an external signer (see sign_transaction / send_transaction).",
      inputSchema: {
        walletName: z.string().describe("Loaded wallet used as fee payer (and default source owner / authority)."),
        to: z.string().describe("Recipient address (wallet address for tokens; their ATA is derived automatically)."),
        amount: baseUnitParam(z, "Amount to send"),
        mint: z.string().optional().describe("Token mint address. Omit for native SOL."),
        decimals: z.number().int().min(0).max(18).optional().describe(DECIMALS_OPTIONAL_DESC),
        allowAtaCreation: z.boolean().optional().describe("With ataMode auto: create the destination ATA when missing. Default true."),
        cluster: clusterParam(z, deps),
        ...constructionKnobs(z),
        authority: z.string().optional().describe(
          "Address that will sign the token transfer as authority when it is NOT walletName (delegate / permanent delegate). Only recorded in plan.signers — nothing is signed here.",
        ),
      },
    },
    run(async (args: TransferArgs & KnobArgs & { cluster?: string; authority?: string }) => {
      const conn = connections.get(args.cluster);
      const from = resolveFrom(deps, args.walletName);
      const base = baseUnits(args);
      const decimals = await resolveDecimals(conn, args.mint, args.decimals);
      const { built, plan } = await buildTransferPlan(conn, {
        ...buildOptions(from.publicKey, args, base, decimals),
        authority: args.authority ? new PublicKey(args.authority) : undefined,
      });
      return {
        program: built.program?.kind ?? "system",
        destinationAtaCreated: built.destinationAtaCreated,
        destinationAtaExisted: built.destinationAtaExisted,
        destinationAta: built.destinationAta?.toBase58() ?? null,
        amountBaseUnits: base.toString(),
        amountDisplay: amountDisplay(base, args.mint, decimals),
        decimals: decimals ?? null,
        labels: built.labels,
        plan,
      };
    }),
  );

  // --- PRD T-H: delegate approve / revoke -----------------------------------
  server.registerTool(
    "approve_delegate",
    {
      description:
        "Approve a delegate on walletName's associated token account for `mint` (SPL Token or Token-2022, ApproveChecked). Afterwards the delegate can move up to `amount` out of that account via `transfer` with walletName = delegate wallet and sourceOwner = this owner's address. Sends immediately (no dry run); failures come back in `error` with isError.",
      inputSchema: {
        walletName: z.string().describe("Loaded wallet that OWNS the token account; pays the fee and signs the approval."),
        mint: z.string().describe("Token mint address."),
        delegate: z.string().describe("Address allowed to transfer from the owner's token account."),
        amount: baseUnitParam(z, "Allowance"),
        decimals: z.number().int().min(0).max(18).optional().describe(DECIMALS_OPTIONAL_DESC),
        allowMainnet: z.literal(true).optional().describe("Required literal true to send on mainnet-beta."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { walletName: string; mint: string; delegate: string; amount: string; decimals?: number; allowMainnet?: boolean; cluster?: string }) => {
      const conn = connections.get(args.cluster);
      const owner = resolveFrom(deps, args.walletName);
      const amount = parseBaseUnits(args.amount, "amount", { decimals: args.decimals, kind: "token" });
      const decimals = (await resolveDecimals(conn, args.mint, args.decimals))!;
      const res = await approveDelegate(conn, {
        owner,
        mint: new PublicKey(args.mint),
        delegate: new PublicKey(args.delegate),
        amount,
        decimals,
        allowMainnet: args.allowMainnet,
      });
      return {
        ok: res.error === undefined,
        ...res,
        feeDisplay: solDisplay(res.feeLamports),
        owner: owner.publicKey.toBase58(),
        delegate: args.delegate,
        amountBaseUnits: amount.toString(),
        amountDisplay: display(amount, decimals),
        decimals,
      };
    }),
  );

  server.registerTool(
    "revoke_delegate",
    {
      description:
        "Revoke any delegate on walletName's associated token account for `mint` (clears delegate and delegatedAmount). Sends immediately; failures come back in `error` with isError.",
      inputSchema: {
        walletName: z.string().describe("Loaded wallet that OWNS the token account; pays the fee and signs."),
        mint: z.string().describe("Token mint address."),
        allowMainnet: z.literal(true).optional().describe("Required literal true to send on mainnet-beta."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { walletName: string; mint: string; allowMainnet?: boolean; cluster?: string }) => {
      const conn = connections.get(args.cluster);
      const owner = resolveFrom(deps, args.walletName);
      const res = await revokeDelegate(conn, {
        owner,
        mint: new PublicKey(args.mint),
        allowMainnet: args.allowMainnet,
      });
      return { ok: res.error === undefined, ...res, feeDisplay: solDisplay(res.feeLamports), owner: owner.publicKey.toBase58() };
    }),
  );

  server.registerTool(
    "batch_transfer",
    {
      description:
        "Send one token/SOL amount pattern to many recipients. Amounts are BASE UNITS (lamports / token base units). Core splits them into size-aware batches (instruction count + 1232-byte budget) sent serially; each batch reports per-recipient results.",
      inputSchema: {
        walletName: z.string().describe("Loaded wallet paying fees and sending funds."),
        recipients: z
          .array(
            z.object({
              to: z.string().describe("Recipient address."),
              amount: baseUnitParam(z, "Amount for THIS recipient"),
            }),
          )
          .min(1)
          .max(50)
          .describe("1–50 recipients."),
        mint: z.string().optional().describe("Token mint. Omit for SOL."),
        decimals: z.number().int().min(0).max(18).optional().describe(DECIMALS_OPTIONAL_DESC),
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
      if (!args.mint && args.decimals !== undefined) {
        throw new Error("decimals is only valid for token transfers.");
      }
      const mint = args.mint ? new PublicKey(args.mint) : undefined;
      const decimals = await resolveDecimals(conn, args.mint, args.decimals);

      // Amounts arrive as base units; instruction building + splitting +
      // sending are core responsibilities.
      const items: BatchItem[] = [];
      const amounts: bigint[] = [];
      args.recipients.forEach((r, i) => {
        amounts.push(parseBaseUnits(r.amount, `recipients[${i}].amount`, { decimals, kind: mint ? "token" : "SOL" }));
      });
      for (const [i, r] of args.recipients.entries()) {
        const built = await buildTransferInstructions(conn, {
          payer: from.publicKey,
          destination: new PublicKey(r.to),
          mint,
          amount: amounts[i]!,
          decimals,
        });
        items.push({ destination: new PublicKey(r.to), instructions: built.instructions });
      }
      const amountByTo = new Map(args.recipients.map((r, i) => [r.to, amounts[i]!] as const));

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
          feeDisplay: solDisplay(b.feeLamports),
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
            amount: amountByTo.get(r.to)?.toString() ?? null,
            amountDisplay: amountDisplay(amountByTo.get(r.to) ?? null, args.mint, decimals),
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
        mint: args.mint ?? null,
        decimals: decimals ?? null,
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
        "One transaction containing multiple legs: native SOL plus any number of different SPL/Token-2022 mints. All legs share one signature. Leg amounts are BASE UNITS (lamports for sol legs, token base units for token legs).",
      inputSchema: {
        walletName: z.string().describe("Loaded wallet paying fees and sending funds."),
        legs: z
          .array(
            z.object({
              kind: z.enum(["sol", "token"]).describe("Leg type."),
              to: z.string().describe("Recipient address."),
              amount: baseUnitParam(z, "Amount for this leg"),
              mint: z.string().optional().describe("Mint address — REQUIRED for token legs, omit for sol legs."),
              decimals: z.number().int().min(0).max(18).optional().describe("Mint decimals — token legs only (resolved from the mint when omitted; passing it saves one RPC read). Invalid on sol legs."),
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

      // Explicit leg validation up front: a token leg without mint used to
      // crash deep inside PublicKey ("reading '_bn'") instead of saying why.
      args.legs.forEach((leg, i) => {
        if (leg.kind === "token") {
          if (!leg.mint) {
            throw new Error(`legs[${i}]: token legs require "mint".`);
          }
        } else if (leg.mint !== undefined || leg.decimals !== undefined) {
          throw new Error(`legs[${i}]: mint/decimals are only valid for token legs (kind: "token").`);
        }
      });

      // Amounts are base units already; decimals are resolved per token leg
      // (one read per distinct mint) when not supplied. Validation,
      // instruction building (program dispatch + ATA), size guard and
      // sending are core.
      const decimalsByMint = new Map<string, number>();
      const legs: Array<MixedLeg & { mint?: PublicKey }> = [];
      for (const [i, leg] of args.legs.entries()) {
        let decimals: number | undefined;
        if (leg.kind === "token" && leg.mint) {
          decimals = leg.decimals ?? decimalsByMint.get(leg.mint);
          if (decimals === undefined) {
            decimals = await resolveDecimals(conn, leg.mint, undefined);
          }
          decimalsByMint.set(leg.mint, decimals!);
        }
        legs.push({
          kind: leg.kind,
          to: new PublicKey(leg.to),
          amount: parseBaseUnits(leg.amount, `legs[${i}].amount`, { decimals, kind: leg.kind === "sol" ? "SOL" : "token" }),
          mint: leg.kind === "token" && leg.mint ? new PublicKey(leg.mint) : undefined,
          decimals,
        });
      }

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
        feeDisplay: solDisplay(result.feeLamports),
        logs: result.logs,
        unitsConsumed: result.unitsConsumed,
        ...(result.error ? { error: result.error } : {}),
        legs: result.legs.map((l, i) => ({
          kind: l.kind,
          to: l.to,
          amount: l.amountBaseUnits,
          amountBaseUnits: l.amountBaseUnits,
          amountDisplay: amountDisplay(l.amountBaseUnits, legs[i]?.mint?.toBase58(), legs[i]?.decimals),
          decimals: legs[i]?.decimals ?? null,
          program: l.program,
          destinationAtaCreated: l.destinationAtaCreated,
          destinationAta: l.destinationAta,
        })),
      };
    }),
  );
}

interface TransferArgs {
  walletName: string;
  to: string;
  amount: string;
  mint?: string;
  decimals?: number;
  allowAtaCreation?: boolean;
}

/** Construction knobs shared by `transfer` and `build_transfer` (PRD T-B). */
interface KnobArgs {
  computeUnitLimit?: number;
  computeUnitPrice?: number;
  ataMode?: AtaMode;
  instruction?: TransferInstructionKind;
  fee?: string;
  memo?: string;
  sourceOwner?: string;
}

function constructionKnobs(z: typeof import("zod").z) {
  return {
    computeUnitLimit: z.number().int().positive().optional().describe(
      "Prepend ComputeBudget setComputeUnitLimit(units). Default: none. Non-standard; for testing compute limits.",
    ),
    computeUnitPrice: z.number().int().nonnegative().optional().describe(
      "Prepend ComputeBudget setComputeUnitPrice(microLamports per CU). Default: none. Placed after computeUnitLimit.",
    ),
    ataMode: z.enum(["auto", "always-idempotent", "create", "none"]).optional().describe(
      "Destination ATA strategy (token transfers only). auto (default): look up the ATA and add CreateIdempotent only when missing. always-idempotent: always add CreateIdempotent. create: always add the NON-idempotent Create (fails on chain if the ATA exists). none: add nothing and never raise ATA_MISSING. Non-default values are intentionally non-standard.",
    ),
    instruction: z.enum(["transferChecked", "transfer", "transferCheckedWithFee"]).optional().describe(
      "Token instruction variant (token transfers only). transferChecked (default, validates mint+decimals). transfer: legacy unchecked Transfer. transferCheckedWithFee: Token-2022 TransferFee extension instruction — requires `fee`.",
    ),
    fee: z.string().optional().describe(
      "Expected fee in integer BASE UNITS (string), required with instruction=transferCheckedWithFee. Must match the mint's TransferFeeConfig or the chain rejects with FeeMismatch.",
    ),
    memo: z.string().optional().describe(
      "UTF-8 memo; adds a Memo-program instruction immediately before the transfer (after any ATA creation). Required by recipients with MemoTransfer enabled.",
    ),
    sourceOwner: z.string().optional().describe(
      "Owner address whose associated token account is the SOURCE when it is not walletName (delegate / permanent-delegate transfers). Default: walletName's address.",
    ),
  };
}

/** Base-unit input → bigint; `decimals` is only meaningful with a mint. */
function baseUnits(args: TransferArgs): bigint {
  if (!args.mint && args.decimals !== undefined) {
    throw new Error("decimals is only valid for token transfers.");
  }
  return parseBaseUnits(args.amount, "amount", { decimals: args.decimals, kind: args.mint ? "token" : "SOL" });
}

/** "1.5 SOL" for SOL, "1.5 (6 dp)" for tokens with known decimals, null otherwise. */
function amountDisplay(base: bigint | string | null, mint: string | undefined, decimals: number | undefined): string | null {
  if (base === null) return null;
  return mint ? display(base, decimals) : display(base, SOL_DECIMALS, "SOL");
}

/**
 * Add `expectedFeeDisplay` / `netDisplay` / `amountDisplay` next to the raw
 * base-unit figures of TRANSFER_FEE / FEE_MISMATCH findings.
 */
function withFeeDisplay<T extends { findings: PreflightResult["findings"] }>(result: T, decimals: number | undefined): T {
  if (decimals === undefined) return result;
  return {
    ...result,
    findings: result.findings.map((f) => {
      if ((f.code !== "TRANSFER_FEE" && f.code !== "FEE_MISMATCH") || !f.data) return f;
      const d = f.data as Record<string, unknown>;
      const str = (k: string): string | null => (typeof d[k] === "string" ? (d[k] as string) : null);
      return {
        ...f,
        data: {
          ...d,
          amountDisplay: display(str("amount"), decimals),
          expectedFeeDisplay: display(str("expectedFee"), decimals),
          netDisplay: display(str("net"), decimals),
        },
      };
    }),
  };
}

function buildOptions(payer: PublicKey, args: TransferArgs & KnobArgs, base: bigint, decimals: number | undefined): BuildTransferOptions {
  const computeBudget =
    args.computeUnitLimit !== undefined || args.computeUnitPrice !== undefined
      ? { unitLimit: args.computeUnitLimit, unitPrice: args.computeUnitPrice }
      : undefined;
  let fee: bigint | undefined;
  if (args.fee !== undefined) {
    if (!/^\d+$/.test(args.fee)) {
      throw new Error(`fee must be an integer base-unit string, got "${args.fee}".`);
    }
    fee = BigInt(args.fee);
  }
  return {
    payer,
    destination: new PublicKey(args.to),
    mint: args.mint ? new PublicKey(args.mint) : undefined,
    amount: base,
    decimals,
    allowAtaCreation: args.allowAtaCreation,
    computeBudget,
    ataMode: args.ataMode,
    instruction: args.instruction,
    fee,
    memo: args.memo,
    sourceOwner: args.sourceOwner ? new PublicKey(args.sourceOwner) : undefined,
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
