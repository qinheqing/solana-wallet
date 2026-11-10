/**
 * Token tools — wired to @sol-wallet/core task #8 (mint creation, SPL +
 * Token-2022 with extensions) and task #9 (mint/burn + Token-2022 runtime
 * management). Multisig tools live in ./multisig.ts (task #10).
 */
import {
  createSplToken,
  createToken2022,
  mintTokens,
  burnTokens,
  setTransferFee,
  freezeTokenAccount,
  thawTokenAccount,
  setMintAuthority,
  setFreezeAuthority,
  updateTokenMetadata,
  updateScaledUiMultiplier,
  enableMemoTransfer,
  disableMemoTransfer,
  withdrawWithheldFromAccounts,
  harvestWithheldToMint,
  withdrawWithheldFromMint,
  updateTransferHookProgram,
  pauseMint,
  resumeMint,
  closeMint,
  updateInterestRate,
  updateDefaultAccountState,
  setExtensionAuthority,
  findWithheldAccounts,
  EXTENSION_AUTHORITY_TYPES,
  type ExtensionAuthorityKind,
  createFromPreset,
  TOKEN_PRESETS,
  type Token2022ExtensionOptions,
  type TokenPresetName,
} from "@sol-wallet/core";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import { display, solDisplay, tryDecimals } from "../amounts.js";
import type { ToolDeps } from "../types.js";

/** Convert the MCP (string-typed) extension payload into core options. */
function toCoreExtensions(raw: {
  transferFeeConfig?: { transferFeeBasisPoints: number; maximumFee: string };
  transferHook?: { programId: string };
  interestBearingConfig?: { rate: number };
  nonTransferable?: boolean;
  permanentDelegate?: { delegate: string };
  tokenMetadata?: { name: string; symbol: string; uri: string };
  defaultAccountState?: { accountState: "frozen" };
  scaledUiAmount?: { multiplier: number; authority?: string };
  pausable?: { authority?: string };
  mintCloseAuthority?: { closeAuthority?: string };
}): Token2022ExtensionOptions {
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
  if (raw.scaledUiAmount) {
    extensions.scaledUiAmount = {
      multiplier: raw.scaledUiAmount.multiplier,
      authority: raw.scaledUiAmount.authority ? new PublicKey(raw.scaledUiAmount.authority) : undefined,
    };
  }
  if (raw.pausable) {
    extensions.pausable = { authority: raw.pausable.authority ? new PublicKey(raw.pausable.authority) : undefined };
  }
  if (raw.mintCloseAuthority) {
    extensions.mintCloseAuthority = {
      closeAuthority: raw.mintCloseAuthority.closeAuthority ? new PublicKey(raw.mintCloseAuthority.closeAuthority) : undefined,
    };
  }
  return extensions;
}

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
        "Create a new SPL Token or Token-2022 mint. Token-2022 enables extensions: transferFeeConfig, transferHook, interestBearingConfig, nonTransferable, permanentDelegate, tokenMetadata (on-chain name/symbol/uri), defaultAccountState=frozen, scaledUiAmount (display-only multiplier), pausable and mintCloseAuthority. A spl-token mint can carry Metaplex metadata via `metadata`. Optional `preset` fills defaults (plain-2022 | transfer-fee | permanent-delegate | scaled-ui | transfer-hook | legacy-spl | memo-required); explicit fields override preset values. Optional `mintTo` mints an initial amount right after creation. Returns the mint address, signature and enabled extensions.",
      inputSchema: {
        walletName: z.string().describe("Mint authority wallet (loaded); pays creation fees."),
        preset: z
          .enum(["plain-2022", "transfer-fee", "permanent-delegate", "scaled-ui", "transfer-hook", "legacy-spl", "memo-required"])
          .optional()
          .describe(
            "Quick template supplying tokenProgram/decimals/extensions defaults. Explicit fields override. transfer-fee defaults 0 bps; permanent-delegate defaults the delegate to this wallet; scaled-ui multiplier 1.5; transfer-hook needs extensions.transferHook.programId (else stored as null); memo-required = plain-2022 + call manage_token2022 enableMemoTransfer on recipient ATAs.",
          ),
        decimals: z.number().int().min(0).max(18).optional().describe("Mint decimals (required unless a preset is given; preset default 9)."),
        mintTo: z
          .object({
            owner: z.string().describe("Wallet address that receives the initial supply (its ATA is created if missing)."),
            amount: z
              .string()
              .regex(/^\d+$/, "amount must be an integer string in base units")
              .describe("Initial amount in token base units (integer string, NOT human-readable: \"1000000\" = 1 token at 6 decimals)."),
          })
          .optional()
          .describe("Mint an initial supply in a second transaction right after creation (skipped on dryRun)."),
        tokenProgram: z
          .enum(["spl-token", "token-2022"])
          .optional()
          .describe("Default spl-token. Use token-2022 to enable `extensions`."),
        extensions: z
          .object({
            transferFeeConfig: z
              .object({
                transferFeeBasisPoints: z.number().int().min(0).max(10000).describe("Fee in basis points (100 = 1%)."),
                maximumFee: z
                  .string()
                  .regex(/^\d+$/, "maximumFee must be an integer string in base units")
                  .describe("Maximum fee per transfer in token base units (integer string, NOT human-readable: \"1000000\" = 1 token at 6 decimals)."),
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
            scaledUiAmount: z
              .object({
                multiplier: z.number().positive().describe("Display multiplier (> 0), e.g. 1.5."),
                authority: z.string().optional().describe("Authority allowed to update the multiplier (default: this wallet)."),
              })
              .optional()
              .describe("ScaledUiAmount: UIs display raw × multiplier. Display-only — raw amounts in this wallet are never scaled."),
            pausable: z
              .object({ authority: z.string().optional().describe("Pause authority (default: this wallet).") })
              .optional()
              .describe("Pausable: the pause authority can halt ALL transfers, mints and burns (manage_token2022 pauseMint / resumeMint)."),
            mintCloseAuthority: z
              .object({ closeAuthority: z.string().optional().describe("Close authority (default: this wallet).") })
              .optional()
              .describe("MintCloseAuthority: lets the close authority close the mint once supply is 0 (manage_token2022 closeMint)."),
          })
          .optional()
          .describe("Token-2022 extension config (ignored for spl-token)."),
        metadata: z
          .object({
            name: z.string().min(1).describe("Token name (≤ 32 bytes)."),
            symbol: z.string().min(1).describe("Token symbol (≤ 10 bytes)."),
            uri: z.string().optional().describe("Off-chain JSON URI (≤ 200 bytes, may be empty)."),
          })
          .optional()
          .describe(
            "spl-token only: name/symbol/uri via a Metaplex Token Metadata account created in the same transaction (the Metaplex program must exist on the cluster). For token-2022 use extensions.tokenMetadata instead.",
          ),
        dryRun: z.boolean().optional().describe("Simulate without sending."),
        allowMainnet: z.literal(true).optional().describe("Required literal true for mainnet-beta."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: {
      walletName: string;
      metadata?: { name: string; symbol: string; uri?: string };
      preset?: TokenPresetName;
      decimals?: number;
      mintTo?: { owner: string; amount: string };
      tokenProgram?: "spl-token" | "token-2022";
      extensions?: {
        transferFeeConfig?: { transferFeeBasisPoints: number; maximumFee: string };
        transferHook?: { programId: string };
        interestBearingConfig?: { rate: number };
        nonTransferable?: boolean;
        permanentDelegate?: { delegate: string };
        tokenMetadata?: { name: string; symbol: string; uri: string };
        defaultAccountState?: { accountState: "frozen" };
        scaledUiAmount?: { multiplier: number; authority?: string };
        pausable?: { authority?: string };
        mintCloseAuthority?: { closeAuthority?: string };
      };
      dryRun?: boolean;
      allowMainnet?: boolean;
      cluster?: string;
    }) => {
      const conn = connections.get(args.cluster);
      const from = deps.store.require(args.walletName).keypair;
      const mintTo = args.mintTo
        ? { owner: new PublicKey(args.mintTo.owner), amount: BigInt(args.mintTo.amount) }
        : undefined;

      // --- preset path: preset supplies defaults, explicit fields override.
      if (args.preset) {
        const extOverride = args.extensions ? toCoreExtensions(args.extensions) : undefined;
        const presetDecimals = args.decimals ?? TOKEN_PRESETS[args.preset].defaults.decimals ?? 9;
        const result = await createFromPreset(conn, from, args.preset, {
          decimals: args.decimals,
          program: args.tokenProgram,
          extensions: extOverride,
          dryRun: args.dryRun,
          allowMainnet: args.allowMainnet,
          mintTo,
        });
        return {
          mint: result.mint,
          preset: result.preset,
          tokenProgram: result.tokenProgram,
          extensions: result.extensions,
          notes: result.notes,
          signature: result.signature,
          slot: result.slot,
          feeLamports: result.feeLamports,
          feeDisplay: solDisplay(result.feeLamports),
          simulatedOnly: result.simulatedOnly,
          logs: result.logs,
          error: result.error,
          mintTo: result.mintTo
            ? { ...result.mintTo, amountDisplay: display(result.mintTo.amount, presetDecimals) }
            : result.mintTo,
          decimals: presetDecimals,
        };
      }

      if (args.decimals === undefined) {
        throw new Error("Missing decimals — required unless a preset is given.");
      }
      if (args.metadata && args.tokenProgram === "token-2022") {
        throw new Error("`metadata` (Metaplex) is for spl-token mints; for token-2022 pass extensions.tokenMetadata.");
      }
      const base = {
        decimals: args.decimals,
        dryRun: args.dryRun,
        allowMainnet: args.allowMainnet,
      };
      /** Mint the initial supply after a successful (non-simulated) creation. */
      const followUpMint = async (mint: string) => {
        if (!mintTo) return undefined;
        const minted = await mintTokens(conn, from, mint, mintTo.owner, mintTo.amount, {
          allowMainnet: args.allowMainnet,
        });
        return {
          ...minted,
          owner: mintTo.owner.toBase58(),
          amount: mintTo.amount.toString(),
          amountDisplay: display(mintTo.amount, args.decimals),
        };
      };

      if (args.tokenProgram === "token-2022") {
        const extensions = toCoreExtensions(args.extensions ?? {});
        const result = await createToken2022(conn, from, { ...base, extensions });
        return {
          mint: result.mint,
          tokenProgram: "token-2022",
          extensions: result.extensions,
          signature: result.signature,
          slot: result.slot,
          feeLamports: result.feeLamports,
          feeDisplay: solDisplay(result.feeLamports),
          simulatedOnly: result.simulatedOnly,
          logs: result.logs,
          error: result.error,
          mintTo: !result.error && !result.simulatedOnly ? await followUpMint(result.mint) : undefined,
          decimals: args.decimals,
        };
      }

      const result = await createSplToken(conn, from, { ...base, metadata: args.metadata });
      return {
        mint: result.mint,
        tokenProgram: "spl-token",
        extensions: result.extensions,
        signature: result.signature,
        slot: result.slot,
        feeLamports: result.feeLamports,
        feeDisplay: solDisplay(result.feeLamports),
        simulatedOnly: result.simulatedOnly,
        logs: result.logs,
        error: result.error,
        mintTo: !result.error && !result.simulatedOnly ? await followUpMint(result.mint) : undefined,
        decimals: args.decimals,
      };
    }),
  );

  server.registerTool(
    "manage_token2022",
    {
      description:
        "Runtime management of a token mint: mintTokens/burnTokens (SPL & Token-2022), plus Token-2022-only actions — setTransferFee (effective next epoch), freezeAccount/thawAccount, setMintAuthority/setFreezeAuthority (revoke requires confirmRevoke:true), updateMetadata (name/symbol/uri/custom key), updateScaledUiMultiplier (display-only), enableMemoTransfer/disableMemoTransfer (this wallet's own ATA; reallocates it when needed), withdrawWithheldFromAccounts / harvestWithheldToMint / withdrawWithheldFromMint (transfer-fee collection), updateTransferHookProgram, pauseMint/resumeMint (Pausable), closeMint (MintCloseAuthority, supply must be 0; requires confirmClose:true), updateInterestRate (InterestBearing), updateDefaultAccountState (freeze authority), setExtensionAuthority (rotate/revoke one extension authority). Verify results with inspect_mint / inspect_token_account.",
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
            "updateScaledUiMultiplier",
            "enableMemoTransfer",
            "disableMemoTransfer",
            "withdrawWithheldFromAccounts",
            "harvestWithheldToMint",
            "withdrawWithheldFromMint",
            "updateTransferHookProgram",
            "pauseMint",
            "resumeMint",
            "closeMint",
            "updateInterestRate",
            "updateDefaultAccountState",
            "setExtensionAuthority",
          ])
          .describe("Management action."),
        params: z.record(z.unknown()).optional().describe(
          "Action params: mintTokens {destinationOwner, amount} · burnTokens {amount} · setTransferFee {transferFeeBasisPoints, maximumFee} · freezeAccount/thawAccount {tokenAccountOwner? (default: authority wallet)} · setMintAuthority/setFreezeAuthority {newAuthority | null + confirmRevoke:true to revoke} · updateMetadata {field(name|symbol|uri|custom), value} · updateScaledUiMultiplier {multiplier (number > 0), effectiveTimestamp? (unix seconds, default 0 = now)} · enableMemoTransfer/disableMemoTransfer {} (acts on this wallet's ATA of the mint; wallet must own it) · withdrawWithheldFromAccounts {sources: string[] (token ACCOUNT addresses, not owners), destination? (token account; default this wallet's ATA)} · harvestWithheldToMint {sources: string[]} (permissionless) · withdrawWithheldFromMint {destination?} · updateTransferHookProgram {programId: string | null (null clears the hook)} · pauseMint/resumeMint {} (wallet = pause authority) · closeMint {destination? (receives rent; default this wallet), confirmClose: true} (IRREVERSIBLE) · updateInterestRate {rate: integer bps/year, −32768…32767} (wallet = rate authority) · updateDefaultAccountState {state: \"initialized\" | \"frozen\"} (wallet = freeze authority) · setExtensionAuthority {kind: transferFeeConfig | withheldWithdraw | closeMint | interestRate | permanentDelegate | transferHookProgramId | metadataPointer | scaledUiAmount | pausable, newAuthority: address | null (+ confirmRevoke:true to revoke)}. NOTE: amount and maximumFee are base units (integer string, NOT human-readable) — \"1000000\" = 1 token at 6 decimals; \"1.5\" is rejected.",
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
        | "updateMetadata"
        | "updateScaledUiMultiplier"
        | "enableMemoTransfer"
        | "disableMemoTransfer"
        | "withdrawWithheldFromAccounts"
        | "harvestWithheldToMint"
        | "withdrawWithheldFromMint"
        | "updateTransferHookProgram"
        | "pauseMint"
        | "resumeMint"
        | "closeMint"
        | "updateInterestRate"
        | "updateDefaultAccountState"
        | "setExtensionAuthority";
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
      const optionalStr = (key: string): string | undefined =>
        typeof p[key] === "string" && (p[key] as string).length > 0 ? (p[key] as string) : undefined;
      const addressList = (key: string): string[] => {
        const v = p[key];
        if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x.length > 0)) {
          throw new Error(`Missing params.${key} — required for action "${args.action}" (non-empty array of token ACCOUNT addresses, not wallet owners).`);
        }
        return v as string[];
      };
      /** Base-unit fields: integer strings only — "1.5" is a unit mistake, not a number. */
      const baseUnits = (key: string): bigint => {
        const v = str(key, "base-unit integer string");
        if (!/^\d+$/.test(v)) {
          throw new Error(
            `params.${key} must be an integer string in token base units (got "${v}"). This field is NOT human-readable: for 1.5 tokens at 6 decimals pass "1500000".`,
          );
        }
        return BigInt(v);
      };

      switch (args.action) {
        case "mintTokens": {
          const amount = baseUnits("amount");
          const decimals = await tryDecimals(conn, mint);
          const res = await mintTokens(conn, from, mint, str("destinationOwner", "recipient wallet address"), amount, opts);
          return {
            action: args.action,
            ...res,
            feeDisplay: solDisplay(res.feeLamports),
            amount: amount.toString(),
            amountDisplay: display(amount, decimals),
            decimals: decimals ?? null,
          };
        }
        case "burnTokens": {
          const amount = baseUnits("amount");
          const decimals = await tryDecimals(conn, mint);
          const res = await burnTokens(conn, from, mint, amount, opts);
          return {
            action: args.action,
            ...res,
            feeDisplay: solDisplay(res.feeLamports),
            amount: amount.toString(),
            amountDisplay: display(amount, decimals),
            decimals: decimals ?? null,
          };
        }
        case "setTransferFee": {
          const bps = p.transferFeeBasisPoints;
          if (typeof bps !== "number") {
            throw new Error("Missing params.transferFeeBasisPoints (integer 0–10000).");
          }
          return {
            action: args.action,
            effectiveNote: "New fee takes effect at the start of the next epoch (~2 days).",
            ...(await setTransferFee(
              conn,
              from,
              mint,
              { transferFeeBasisPoints: bps, maximumFee: baseUnits("maximumFee").toString() },
              opts,
            )),
          };
        }
        case "freezeAccount":
        case "thawAccount": {
          const fn = args.action === "freezeAccount" ? freezeTokenAccount : thawTokenAccount;
          const tokenAccountOwner =
            typeof p.tokenAccountOwner === "string" && p.tokenAccountOwner.length > 0
              ? p.tokenAccountOwner
              : from.publicKey.toBase58();
          return { action: args.action, ...(await fn(conn, from, mint, tokenAccountOwner, opts)) };
        }
        case "setMintAuthority":
        case "setFreezeAuthority": {
          const fn = args.action === "setMintAuthority" ? setMintAuthority : setFreezeAuthority;
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
        case "updateScaledUiMultiplier": {
          const multiplier = p.multiplier;
          if (typeof multiplier !== "number" || !(multiplier > 0)) {
            throw new Error("Missing params.multiplier — a number > 0 (display-only: UIs show raw × multiplier).");
          }
          const ts = p.effectiveTimestamp;
          const effectiveTimestamp =
            typeof ts === "number" || typeof ts === "string" ? BigInt(ts) : undefined;
          return {
            action: args.action,
            note: "ScaledUiAmount only changes how UIs display balances; raw amounts are unchanged.",
            ...(await updateScaledUiMultiplier(conn, { mint, authority: from, multiplier, effectiveTimestamp }, opts)),
          };
        }
        case "enableMemoTransfer":
        case "disableMemoTransfer": {
          const fn = args.action === "enableMemoTransfer" ? enableMemoTransfer : disableMemoTransfer;
          return {
            action: args.action,
            tokenAccount: getAssociatedTokenAddressSync(mint, from.publicKey, true, TOKEN_2022_PROGRAM_ID).toBase58(),
            ...(await fn(conn, { owner: from, mint }, opts)),
          };
        }
        case "withdrawWithheldFromAccounts": {
          return {
            action: args.action,
            ...(await withdrawWithheldFromAccounts(
              conn,
              { mint, authority: from, sources: addressList("sources"), destination: optionalStr("destination") },
              opts,
            )),
          };
        }
        case "harvestWithheldToMint": {
          return {
            action: args.action,
            ...(await harvestWithheldToMint(conn, { payer: from, mint, sources: addressList("sources") }, opts)),
          };
        }
        case "withdrawWithheldFromMint": {
          return {
            action: args.action,
            ...(await withdrawWithheldFromMint(
              conn,
              { mint, authority: from, destination: optionalStr("destination") },
              opts,
            )),
          };
        }
        case "updateTransferHookProgram": {
          const raw = p.programId;
          if (raw !== null && typeof raw !== "string") {
            throw new Error("Missing params.programId — pass a base58 program address, or null to clear the hook.");
          }
          return {
            action: args.action,
            ...(await updateTransferHookProgram(conn, { mint, authority: from, programId: raw }, opts)),
          };
        }
        case "pauseMint":
        case "resumeMint": {
          const fn = args.action === "pauseMint" ? pauseMint : resumeMint;
          return { action: args.action, ...(await fn(conn, { mint, authority: from }, opts)) };
        }
        case "closeMint": {
          return {
            action: args.action,
            ...(await closeMint(
              conn,
              { mint, authority: from, destination: optionalStr("destination"), confirmClose: p.confirmClose === true },
              opts,
            )),
          };
        }
        case "updateInterestRate": {
          const rate = p.rate;
          if (typeof rate !== "number") {
            throw new Error("Missing params.rate — integer basis points per year (−32768…32767).");
          }
          return { action: args.action, ...(await updateInterestRate(conn, { mint, authority: from, rate }, opts)) };
        }
        case "updateDefaultAccountState": {
          const state = p.state;
          if (state !== "initialized" && state !== "frozen") {
            throw new Error('Missing params.state — "initialized" or "frozen".');
          }
          return {
            action: args.action,
            ...(await updateDefaultAccountState(conn, { mint, freezeAuthority: from, state }, opts)),
          };
        }
        case "setExtensionAuthority": {
          const kind = p.kind;
          if (typeof kind !== "string" || !(kind in EXTENSION_AUTHORITY_TYPES)) {
            throw new Error(`Missing or unknown params.kind — one of: ${Object.keys(EXTENSION_AUTHORITY_TYPES).join(", ")}.`);
          }
          const raw = p.newAuthority;
          if (raw !== null && typeof raw !== "string") {
            throw new Error("Missing params.newAuthority — a base58 address, or null with confirmRevoke:true to revoke.");
          }
          return {
            action: args.action,
            kind,
            ...(await setExtensionAuthority(conn, from, mint, kind as ExtensionAuthorityKind, raw, {
              ...opts,
              confirmRevoke: p.confirmRevoke === true,
            })),
          };
        }
      }
    }),
  );

  server.registerTool(
    "find_withheld_accounts",
    {
      description:
        "List token accounts of a Token-2022 transfer-fee mint that hold withheld fees (largest first): address, owner, withheldAmount (raw + display). Feed the addresses to manage_token2022 withdrawWithheldFromAccounts / harvestWithheldToMint `sources`. Read-only; uses getProgramAccounts, which some public mainnet RPCs disable or rate-limit.",
      inputSchema: {
        mint: z.string().describe("Token-2022 mint address."),
        cluster: clusterParam(z, deps),
      },
    },
    run(async (args: { mint: string; cluster?: string }) => {
      const conn = connections.get(args.cluster);
      const decimals = await tryDecimals(conn, new PublicKey(args.mint));
      const accounts = await findWithheldAccounts(conn, args.mint);
      const total = accounts.reduce((sum, a) => sum + BigInt(a.withheldAmount), 0n);
      return {
        cluster: conn.cluster,
        mint: args.mint,
        decimals: decimals ?? null,
        count: accounts.length,
        totalWithheld: total.toString(),
        totalWithheldDisplay: display(total, decimals),
        accounts: accounts.map((a) => ({ ...a, withheldDisplay: display(a.withheldAmount, decimals) })),
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
