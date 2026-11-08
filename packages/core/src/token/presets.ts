/**
 * Token presets (PRD T-F): named bundles of CreateMintOptions + Token-2022
 * extension defaults so an AI caller / UI can say "give me a transfer-fee
 * token" without spelling out every parameter. Every field can be
 * overridden; presets are DEFAULTS, never constraints.
 */
import { Keypair, PublicKey } from "@solana/web3.js";

import type { ClusterConnection } from "../connection/connection.js";
import { SolwalletError } from "../connection/errors.js";
import {
  createSplToken,
  createToken2022,
  type CreateMintOptions,
  type CreateTokenResult,
  type Token2022ExtensionOptions,
} from "./create.js";
import { toPublicKey, type SendTokenOptions, type TokenTxResult } from "./internal.js";
import { mintTokens } from "./manage.js";

export type TokenPresetName =
  | "plain-2022"
  | "transfer-fee"
  | "permanent-delegate"
  | "scaled-ui"
  | "transfer-hook"
  | "legacy-spl"
  | "memo-required";

export type TokenPresetProgram = "spl-token" | "token-2022";

/** Create options a preset may pre-fill (everything is overridable). */
export type PresetDefaults = Partial<Omit<CreateMintOptions, keyof SendTokenOptions>> & {
  extensions?: Token2022ExtensionOptions;
};

export interface TokenPreset {
  name: TokenPresetName;
  description: string;
  program: TokenPresetProgram;
  defaults: PresetDefaults;
  /** Caveats an AI caller / UI should surface before using the preset. */
  notes: string[];
}

/**
 * Placeholder hook program for the `transfer-hook` preset: the zero pubkey,
 * which Token-2022 stores as "no hook program" (OptionalNonZeroPubkey).
 * Supply `extensions.transferHook.programId` to point at a real hook, or
 * call updateTransferHookProgram later.
 */
export const TRANSFER_HOOK_PLACEHOLDER_PROGRAM_ID: PublicKey = PublicKey.default;

export const TOKEN_PRESETS: Record<TokenPresetName, TokenPreset> = {
  "plain-2022": {
    name: "plain-2022",
    description: "Token-2022 mint with no extensions (9 decimals).",
    program: "token-2022",
    defaults: { decimals: 9 },
    notes: ["Behaves like a classic SPL mint but lives on the Token-2022 program."],
  },
  "transfer-fee": {
    name: "transfer-fee",
    description: "Token-2022 mint with the TransferFeeConfig extension (default 0 bps / 0 max fee).",
    program: "token-2022",
    defaults: {
      decimals: 9,
      extensions: { transferFeeConfig: { transferFeeBasisPoints: 0, maximumFee: 0n } },
    },
    notes: [
      "Override extensions.transferFeeConfig {transferFeeBasisPoints, maximumFee} to charge a fee; setTransferFee changes it later (effective next epoch).",
      "The payer becomes both the fee-config and withdraw-withheld authority.",
    ],
  },
  "permanent-delegate": {
    name: "permanent-delegate",
    description: "Token-2022 mint whose permanent delegate (default: the payer) can move/burn any holder's tokens.",
    program: "token-2022",
    defaults: { decimals: 9, extensions: { permanentDelegate: { delegate: PublicKey.default } } },
    notes: [
      "Extremely high privilege and irreversible: the delegate can transfer or burn from ANY account of this mint.",
      "Defaults the delegate to the payer; override extensions.permanentDelegate.delegate for another address.",
    ],
  },
  "scaled-ui": {
    name: "scaled-ui",
    description: "Token-2022 mint with the ScaledUiAmount extension (default multiplier 1.5).",
    program: "token-2022",
    defaults: { decimals: 9, extensions: { scaledUiAmount: { multiplier: 1.5 } } },
    notes: [
      "Display-only: UIs show raw × multiplier; this wallet never scales raw amounts.",
      "Update the multiplier later with updateScaledUiMultiplier (authority defaults to the payer).",
    ],
  },
  "transfer-hook": {
    name: "transfer-hook",
    description: "Token-2022 mint with the TransferHook extension; hook program must be supplied.",
    program: "token-2022",
    defaults: {
      decimals: 9,
      extensions: { transferHook: { programId: TRANSFER_HOOK_PLACEHOLDER_PROGRAM_ID } },
    },
    notes: [
      "Supply extensions.transferHook.programId — absent, the hook program is stored as null (zero pubkey) and transfers run without a hook until updateTransferHookProgram sets one.",
      "A real hook program must exist on chain and expose extra-account metas, or transfers fail.",
    ],
  },
  "legacy-spl": {
    name: "legacy-spl",
    description: "Classic SPL Token mint (no extensions possible), 9 decimals.",
    program: "spl-token",
    defaults: { decimals: 9 },
    notes: ["extensions are ignored on the classic SPL Token program."],
  },
  "memo-required": {
    name: "memo-required",
    description: "Token-2022 mint intended for memo-required receiving accounts (same mint as plain-2022).",
    program: "token-2022",
    defaults: { decimals: 9 },
    notes: [
      "MemoTransfer is an ACCOUNT extension, not a mint extension: after creating the mint, call enableMemoTransfer({ owner, mint }) for each recipient ATA that must require memos.",
      "Transfers to such accounts fail with NoMemo (custom error 36) unless the transaction carries a memo instruction.",
    ],
  },
};

/** Options accepted by resolvePreset / createFromPreset (all optional). */
export type PresetOverrides = PresetDefaults &
  SendTokenOptions & {
    /** Force a token program (defaults to the preset's program). */
    program?: TokenPresetProgram;
  };

export interface ResolvedPreset {
  preset: TokenPresetName;
  program: TokenPresetProgram;
  options: CreateMintOptions & { extensions?: Token2022ExtensionOptions };
  notes: string[];
}

export function isTokenPresetName(value: string): value is TokenPresetName {
  return Object.prototype.hasOwnProperty.call(TOKEN_PRESETS, value);
}

/**
 * Merge a preset's defaults with explicit overrides into concrete create
 * options. Extensions merge per-key (an override replaces that extension's
 * whole config). Payer-dependent defaults (permanent delegate) resolve here.
 */
export function resolvePreset(
  name: TokenPresetName,
  overrides: PresetOverrides = {},
  ctx: { payer: string | PublicKey | Keypair },
): ResolvedPreset {
  const preset = TOKEN_PRESETS[name];
  if (!preset) {
    throw new SolwalletError(`Unknown token preset "${name}".`, {
      code: "PRESET_UNKNOWN",
      hint: `Known presets: ${Object.keys(TOKEN_PRESETS).join(", ")}.`,
    });
  }
  const payer = ctx.payer instanceof Keypair ? ctx.payer.publicKey : toPublicKey(ctx.payer);
  const { program: programOverride, extensions: extOverride, ...rest } = overrides;
  const program = programOverride ?? preset.program;

  const extensions: Token2022ExtensionOptions = { ...(preset.defaults.extensions ?? {}), ...(extOverride ?? {}) };
  if (
    extensions.permanentDelegate &&
    toPublicKey(extensions.permanentDelegate.delegate).equals(PublicKey.default)
  ) {
    extensions.permanentDelegate = { delegate: payer };
  }

  const options: CreateMintOptions & { extensions?: Token2022ExtensionOptions } = {
    ...preset.defaults,
    ...rest,
    decimals: rest.decimals ?? preset.defaults.decimals ?? 9,
  };
  if (program === "token-2022" && Object.keys(extensions).length > 0) {
    options.extensions = extensions;
  } else {
    delete options.extensions;
  }
  return { preset: name, program, options, notes: preset.notes };
}

export interface CreateFromPresetOptions extends PresetOverrides {
  /** Mint `amount` base units to `owner`'s ATA right after creation. */
  mintTo?: { owner: string | PublicKey; amount: bigint };
}

export interface CreateFromPresetResult extends CreateTokenResult {
  preset: TokenPresetName;
  tokenProgram: TokenPresetProgram;
  notes: string[];
  /** Result of the follow-up mintTo transaction (absent if not requested, simulated or creation failed). */
  mintTo?: TokenTxResult & { owner: string; amount: string };
}

/**
 * Create a mint from a preset (dispatching to createSplToken/createToken2022)
 * and optionally mint an initial amount in a second transaction.
 */
export async function createFromPreset(
  conn: ClusterConnection,
  payer: Keypair,
  name: TokenPresetName,
  overrides: CreateFromPresetOptions = {},
): Promise<CreateFromPresetResult> {
  const { mintTo, ...presetOverrides } = overrides;
  const resolved = resolvePreset(name, presetOverrides, { payer });
  const result =
    resolved.program === "spl-token"
      ? await createSplToken(conn, payer, resolved.options)
      : await createToken2022(conn, payer, resolved.options);

  const out: CreateFromPresetResult = {
    ...result,
    preset: name,
    tokenProgram: resolved.program,
    notes: resolved.notes,
  };
  if (mintTo && !result.error && !result.simulatedOnly) {
    const minted = await mintTokens(conn, payer, result.mint, mintTo.owner, mintTo.amount, {
      allowMainnet: overrides.allowMainnet,
      policy: overrides.policy,
    });
    out.mintTo = {
      ...minted,
      owner: toPublicKey(mintTo.owner).toBase58(),
      amount: mintTo.amount.toString(),
    };
  }
  return out;
}
