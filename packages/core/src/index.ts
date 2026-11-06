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
