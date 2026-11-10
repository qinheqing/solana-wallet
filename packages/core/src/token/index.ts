/**
 * Token operations: mint creation (SPL + Token-2022 with extensions) and
 * Token-2022 runtime management.
 */
export {
  createSplToken,
  createToken2022,
  type CreateMintOptions,
  type CreateTokenResult,
  type Token2022ExtensionOptions,
} from "./create.js";

export {
  mintTokens,
  burnTokens,
  type BurnTokensOptions,
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
  type MintAuthorityParams,
  type CloseMintParams,
  type UpdateInterestRateParams,
  type UpdateDefaultAccountStateParams,
  type WithheldAccount,
  type TokenManageResult,
  type TransferFeeUpdate,
  type UpdateScaledUiMultiplierParams,
  type MemoTransferParams,
  type WithdrawWithheldFromAccountsParams,
  type HarvestWithheldToMintParams,
  type WithdrawWithheldFromMintParams,
  type UpdateTransferHookProgramParams,
} from "./manage.js";

export {
  METAPLEX_TOKEN_METADATA_PROGRAM_ID,
  METAPLEX_MAX_NAME_LEN,
  METAPLEX_MAX_SYMBOL_LEN,
  METAPLEX_MAX_URI_LEN,
  metaplexMetadataPda,
  createMetaplexMetadataInstruction,
  decodeMetaplexMetadata,
  validateTokenMetadata,
  type TokenMetadataInput,
} from "./metaplex.js";

// --- PRD T-F: token presets -----------------------------------------------
export {
  TOKEN_PRESETS,
  TRANSFER_HOOK_PLACEHOLDER_PROGRAM_ID,
  isTokenPresetName,
  resolvePreset,
  createFromPreset,
  type TokenPresetName,
  type TokenPresetProgram,
  type TokenPreset,
  type PresetDefaults,
  type PresetOverrides,
  type ResolvedPreset,
  type CreateFromPresetOptions,
  type CreateFromPresetResult,
} from "./presets.js";

export type { SendTokenOptions, TokenTxResult } from "./internal.js";

// --- token accounts at arbitrary (non-ATA) addresses -----------------------
export {
  createTokenAccount,
  type CreateTokenAccountParams,
  type CreateTokenAccountResult,
} from "./account.js";
