/**
 * @sol-wallet/core — Solana wallet testing library.
 *
 * Zero UI dependencies. All modules (connection, wallet, transfer, token,
 * multisig) are built on this package.
 */
export const CORE_VERSION = "0.1.0" as const;

export type Cluster = "mainnet-beta" | "devnet" | "testnet" | "custom";

export {
  OFFICIAL_CLUSTERS,
  CLUSTER_ENDPOINTS,
  resolveClusterTarget,
  type OfficialCluster,
  type ClusterTarget,
} from "./connection/cluster.js";

export {
  ClusterConnection,
  createConnection,
  DEFAULT_CONFIRM_POLICY,
  MAINNET_GENESIS_HASH,
  isAlreadyProcessedError,
  shouldRetrySend,
  type ClusterConnectionOptions,
  type ClusterHealth,
  type ConfirmPolicy,
  type SendResult,
} from "./connection/connection.js";

export {
  SolwalletError,
  MainnetNotAllowedError,
  AirdropNotSupportedError,
  TransactionSendError,
  type SolwalletErrorOptions,
} from "./connection/errors.js";

export * from "./wallet/index.js";

export {
  formatAmount,
  parseAmount,
  lamportsToSol,
  solToLamports,
} from "./utils/amount.js";

export {
  parseTransactionError,
  type ParsedProgramError,
  type ParseTransactionErrorOptions,
} from "./utils/parse-error.js";

export {
  getMintProgram,
  mintProgramFromOwner,
  type MintProgram,
  type TokenProgramKind,
} from "./transfer/program.js";

export {
  buildTransferInstructions,
  buildTransferPlan,
  createMemoInstruction,
  MEMO_PROGRAM_ID,
  TOKEN_PROGRAM_IDS,
  type AtaMode,
  type BuildTransferOptions,
  type BuildTransferPlanOptions,
  type BuiltTransfer,
  type ComputeBudgetOptions,
  type PreloadedTransferAccounts,
  type TransferInstructionKind,
} from "./transfer/build.js";

// --- PRD T-B: transaction plans -------------------------------------------
export {
  describeInstructions,
  planFromInstructions,
  planFromMessage,
  type InstructionLabel,
  type PlannedAccount,
  type PlannedInstruction,
  type TransactionPlan,
} from "./transfer/plan.js";

// --- PRD T-D: raw transaction channel -------------------------------------
export {
  decodeRawTransaction,
  parseRawTransaction,
  signTransactionHex,
  simulateRaw,
  sendRaw,
  type DecodedRawTransaction,
  type ParsedRawTransaction,
  type RawSignature,
  type RawTxEncoding,
  type RawTxKind,
  type SendRawOptions,
  type SendRawResult,
  type SignRawResult,
  type SimulateRawResult,
} from "./transfer/raw.js";

export { dryRun, type DryRunResult } from "./transfer/dryrun.js";

// --- PRD T-C: transfer preflight --------------------------------------------
export {
  computeTransferFee,
  describeBlockers,
  evaluatePreflight,
  pickFeeTier,
  preflightTransfer,
  preflightTransferWithAccounts,
  resolveTransferAtas,
  type PreflightAccounts,
  type PreflightCode,
  type PreflightContext,
  type PreflightFinding,
  type PreflightResolved,
  type PreflightResult,
  type PreflightSeverity,
} from "./transfer/preflight.js";

export {
  transfer,
  type TransferRequest,
  type TransferResult,
} from "./transfer/transfer.js";

// --- CPI example program (task 7) + token CPI forwarder (PRD T-I, task 23) --
export {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  CPI_BATCH_TRANSFER_DISCRIMINANT,
  CPI_FORWARD_TRANSFER_CHECKED_DATA_BYTES,
  CPI_FORWARD_TRANSFER_CHECKED_DISCRIMINANT,
  CPI_INITIALIZE_VAULT_DISCRIMINANT,
  CPI_VAULT_SEED,
  buildCpiBatchTransferInstruction,
  buildCpiInitializeVaultInstruction,
  buildForwardTransferCheckedInstruction,
  cpiTokenTransfer,
  deployCpiProgram,
  executeCpiBatchTransfer,
  findCpiVaultPda,
  findProgramDataAddress,
  initializeCpiVault,
  serializeCpiBatchTransferData,
  serializeCpiForwardTransferCheckedData,
  serializeCpiInitializeVaultData,
  type CpiBatchTransferOptions,
  type CpiBatchTransferResult,
  type CpiInitializeVaultOptions,
  type CpiInitializeVaultResult,
  type CpiRecipient,
  type CpiTokenTransferRequest,
  type CpiTokenTransferResult,
  type DeployCpiProgramOptions,
  type DeployCpiProgramResult,
  type ForwardTransferCheckedInstructionParams,
} from "./transfer/cpi.js";

// --- PRD T-H: delegate approve / revoke -------------------------------------
export {
  approveDelegate,
  revokeDelegate,
  type ApproveDelegateRequest,
  type DelegateResult,
  type DelegateSendOptions,
  type RevokeDelegateRequest,
} from "./transfer/delegate.js";

export {
  MAX_TX_BYTES,
  DEFAULT_HEADROOM_BYTES,
  DEFAULT_SIZE_BUDGET_BYTES,
  DEFAULT_MAX_INSTRUCTIONS_PER_TX,
  estimateTransactionSize,
  splitIntoBatches,
  executeBatchTransfer,
  type BatchItem,
  type Batch,
  type BatchSplitOptions,
  type BatchItemResult,
  type BatchResult,
  type BatchTransferOptions,
} from "./transfer/batch.js";

export {
  executeMixedTransfer,
  type MixedLeg,
  type MixedTransferOptions,
  type MixedLegSummary,
  type MixedTransferResult,
} from "./transfer/mixed.js";

export * from "./multisig/index.js";

export * from "./token/index.js";

// --- T-A / T-E: address derivation, mint/account/transaction inspection ----
export * from "./inspect/index.js";
