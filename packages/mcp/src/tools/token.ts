/**
 * Token tools — wired to @solwallet/core task #8 (mint creation, SPL +
 * Token-2022 with extensions) and task #9 (mint/burn + Token-2022 runtime
 * management). Multisig tools live in ./multisig.ts (task #10).
 */
import {
  createSplToken,
  createToken2022,
  type Token2022ExtensionOptions,
} from "@solwallet/core";
import { PublicKey } from "@solana/web3.js";

import type { ToolDeps } from "../types.js";

type McpServer = import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

export function registerTokenTools(
  server: McpServer,
  deps: ToolDeps,
  z: typeof import("zod").z,
): void {
  const { connections, run } = deps;

  server.registerTool(
    "create_token",
    {
      description:
        "Create a new SPL Token or Token-2022 mint. Token-2022 enables extensions: transferFeeConfig, transferHook, interestBearingConfig, nonTransferable, permanentDelegate, tokenMetadata (on-chain name/symbol/uri) and defaultAccountState=frozen. Returns the mint address, signature and enabled extensions.",
      inputSchema: {
        walletName: z.string().describe("Mint authority wallet (loaded); pays creation fees."),
        decimals: z.number().int().min(0).max(18).describe("Mint decimals."),
        tokenProgram: z
          .enum(["spl-token", "token-2022"])
          .optional()
          .describe("Default spl-token. Use token-2022 to enable `extensions`."),
        extensions: z
          .object({
            transferFeeConfig: z
              .object({
                transferFeeBasisPoints: z.number().int().min(0).max(10000).describe("Fee in basis points (100 = 1%)."),
                maximumFee: z.string().describe("Maximum fee in token base units (integer string)."),
              })
              .optional()
              .describe("Transfer fee taken on transfers; updatable later by the authority."),
            transferHook: z
              .object({ programId: z.string().describe("Hook program invoked on every transfer.") })
              .optional()
              .describe("Transfer hook (hook program must exist on chain)."),
            interestBearingConfig: z
              .object({ rate: z.number().int().min(-32768).max(32767).describe("Signed i16 interest rate.") })
              .optional()
              .describe("Interest-bearing mint configuration."),
            nonTransferable: z
              .boolean()
              .optional()
              .describe("Tokens can never be transferred (soulbound)."),
            permanentDelegate: z
              .object({ delegate: z.string().describe("Delegate allowed to transfer/burn any account.") })
              .optional()
              .describe("Permanent delegate with unlimited transfer/burn rights."),
            tokenMetadata: z
              .object({
                name: z.string().min(1).describe("Token name."),
                symbol: z.string().min(1).describe("Token symbol."),
                uri: z.string().describe("URI to off-chain metadata (may be empty)."),
              })
              .optional()
              .describe("On-chain metadata (implies metadataPointer → the mint itself)."),
            defaultAccountState: z
              .object({ accountState: z.literal("frozen") })
              .optional()
              .describe("New token accounts start FROZEN until thawed by the freeze authority."),
          })
          .optional()
          .describe("Token-2022 extension config (ignored for spl-token)."),
        dryRun: z.boolean().optional().describe("Simulate without sending."),
        allowMainnet: z.literal(true).optional().describe("Required literal true for mainnet-beta."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: {
      walletName: string;
      decimals: number;
      tokenProgram?: "spl-token" | "token-2022";
      extensions?: {
        transferFeeConfig?: { transferFeeBasisPoints: number; maximumFee: string };
        transferHook?: { programId: string };
        interestBearingConfig?: { rate: number };
        nonTransferable?: boolean;
        permanentDelegate?: { delegate: string };
        tokenMetadata?: { name: string; symbol: string; uri: string };
        defaultAccountState?: { accountState: "frozen" };
      };
      dryRun?: boolean;
      allowMainnet?: boolean;
      cluster?: string;
    }) => {
      const conn = connections.get(args.cluster);
      const from = deps.store.require(args.walletName).keypair;
      const base = {
        decimals: args.decimals,
        dryRun: args.dryRun,
        allowMainnet: args.allowMainnet,
      };

      if (args.tokenProgram === "token-2022") {
        const raw = args.extensions ?? {};
        const extensions: Token2022ExtensionOptions = {};
        if (raw.transferFeeConfig) {
          extensions.transferFeeConfig = {
            transferFeeBasisPoints: raw.transferFeeConfig.transferFeeBasisPoints,
            maximumFee: BigInt(raw.transferFeeConfig.maximumFee),
          };
        }
        if (raw.transferHook) {
          extensions.transferHook = { programId: new PublicKey(raw.transferHook.programId) };
        }
        if (raw.interestBearingConfig) {
          extensions.interestBearingConfig = { rate: raw.interestBearingConfig.rate };
        }
        if (raw.nonTransferable) extensions.nonTransferable = true;
        if (raw.permanentDelegate) {
          extensions.permanentDelegate = { delegate: new PublicKey(raw.permanentDelegate.delegate) };
        }
        if (raw.tokenMetadata) extensions.tokenMetadata = raw.tokenMetadata;
        if (raw.defaultAccountState) extensions.defaultAccountState = { accountState: "frozen" };

        const result = await createToken2022(conn, from, { ...base, extensions });
        return {
          mint: result.mint,
          tokenProgram: "token-2022",
          extensions: result.extensions,
          signature: result.signature,
          slot: result.slot,
          feeLamports: result.feeLamports,
          simulatedOnly: result.simulatedOnly,
          logs: result.logs,
        };
      }

      const result = await createSplToken(conn, from, base);
      return {
        mint: result.mint,
        tokenProgram: "spl-token",
        extensions: result.extensions,
        signature: result.signature,
        slot: result.slot,
        feeLamports: result.feeLamports,
        simulatedOnly: result.simulatedOnly,
        logs: result.logs,
      };
    }),
  );

  server.registerTool(
    "manage_token2022",
    {
      description:
        "Runtime management of a token mint: mintTokens/burnTokens (SPL & Token-2022), plus Token-2022-only actions — setTransferFee (effective next epoch), freezeAccount/thawAccount, setMintAuthority/setFreezeAuthority (revoke requires confirmRevoke:true), updateMetadata (name/symbol/uri/custom key).",
      inputSchema: {
        walletName: z.string().describe("Authority wallet (loaded)."),
        mint: z.string().describe("Mint address."),
        action: z
          .enum([
            "mintTokens",
            "burnTokens",
            "setTransferFee",
            "freezeAccount",
            "thawAccount",
            "setMintAuthority",
            "setFreezeAuthority",
            "updateMetadata",
          ])
          .describe("Management action."),
        params: z.record(z.unknown()).optional().describe(
          "Action params: mintTokens {destinationOwner, amount(base-unit string)} · burnTokens {amount} · setTransferFee {transferFeeBasisPoints, maximumFee(string)} · freezeAccount/thawAccount {tokenAccountOwner? (default: authority wallet)} · setMintAuthority/setFreezeAuthority {newAuthority | null + confirmRevoke:true to revoke} · updateMetadata {field(name|symbol|uri|custom), value}.",
        ),
        dryRun: z.boolean().optional().describe("Simulate without sending."),
        allowMainnet: z.literal(true).optional().describe("Required literal true for mainnet-beta."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: {
      walletName: string;
      mint: string;
      action:
        | "mintTokens"
        | "burnTokens"
        | "setTransferFee"
        | "freezeAccount"
        | "thawAccount"
        | "setMintAuthority"
        | "setFreezeAuthority"
        | "updateMetadata";
      params?: Record<string, unknown>;
      dryRun?: boolean;
      allowMainnet?: boolean;
      cluster?: string;
    }) => {
      const conn = connections.get(args.cluster);
      const from = deps.store.require(args.walletName).keypair;
      const mint = new PublicKey(args.mint);
      const p = args.params ?? {};
      const opts = { dryRun: args.dryRun, allowMainnet: args.allowMainnet };
      const str = (key: string, required: string): string => {
        const v = p[key];
        if (typeof v !== "string" || v.length === 0) {
          throw new Error(`Missing params.${key} — required for action "${args.action}" (${required}).`);
        }
        return v;
      };

      switch (args.action) {
        case "mintTokens": {
          const amount = BigInt(str("amount", "base-unit integer string"));
          const { mintTokens } = await import("@solwallet/core");
          return {
            action: args.action,
            ...(await mintTokens(conn, from, mint, str("destinationOwner", "recipient wallet address"), amount, opts)),
          };
        }
        case "burnTokens": {
          const amount = BigInt(str("amount", "base-unit integer string"));
          const { burnTokens } = await import("@solwallet/core");
          return { action: args.action, ...(await burnTokens(conn, from, mint, amount, opts)) };
        }
        case "setTransferFee": {
          const bps = p.transferFeeBasisPoints;
          if (typeof bps !== "number") {
            throw new Error("Missing params.transferFeeBasisPoints (integer 0–10000).");
          }
          const { setTransferFee } = await import("@solwallet/core");
          return {
            action: args.action,
            effectiveNote: "New fee takes effect at the start of the next epoch (~2 days).",
            ...(await setTransferFee(
              conn,
              from,
              mint,
              { transferFeeBasisPoints: bps, maximumFee: str("maximumFee", "base-unit integer string") },
              opts,
            )),
          };
        }
        case "freezeAccount":
        case "thawAccount": {
          const core = await import("@solwallet/core");
          const fn = args.action === "freezeAccount" ? core.freezeTokenAccount : core.thawTokenAccount;
          const tokenAccountOwner =
            typeof p.tokenAccountOwner === "string" && p.tokenAccountOwner.length > 0
              ? p.tokenAccountOwner
              : from.publicKey.toBase58();
          return { action: args.action, ...(await fn(conn, from, mint, tokenAccountOwner, opts)) };
        }
        case "setMintAuthority":
        case "setFreezeAuthority": {
          const core = await import("@solwallet/core");
          const fn = args.action === "setMintAuthority" ? core.setMintAuthority : core.setFreezeAuthority;
          const raw = p.newAuthority;
          if (raw !== null && typeof raw !== "string") {
            throw new Error(
              'Missing params.newAuthority — pass a base58 address, or null with confirmRevoke:true to permanently renounce.',
            );
          }
          return {
            action: args.action,
            ...(await fn(conn, from, mint, raw, { ...opts, confirmRevoke: p.confirmRevoke === true })),
          };
        }
        case "updateMetadata": {
          const { updateTokenMetadata } = await import("@solwallet/core");
          return {
            action: args.action,
            ...(await updateTokenMetadata(
              conn,
              from,
              mint,
              { field: str("field", "name | symbol | uri | custom key"), value: str("value", "new field value") },
              opts,
            )),
          };
        }
      }
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
