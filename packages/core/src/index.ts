/**
 * @solwallet/core — Solana wallet testing library.
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
} from "./utils/parse-error.js";

export {
  getMintProgram,
  type MintProgram,
  type TokenProgramKind,
} from "./transfer/program.js";

export {
  buildTransferInstructions,
  TOKEN_PROGRAM_IDS,
  type BuildTransferOptions,
  type BuiltTransfer,
} from "./transfer/build.js";

export { dryRun, type DryRunResult } from "./transfer/dryrun.js";

export {
  transfer,
  type TransferRequest,
  type TransferResult,
} from "./transfer/transfer.js";

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
