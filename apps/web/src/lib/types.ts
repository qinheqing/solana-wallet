import type { EncryptedKeystoreV1 } from "@solwallet/core";

export type ClusterName = "mainnet-beta" | "devnet" | "testnet" | "custom";

/** 64-byte solana-keygen secret-key array. */
export type KeypairBytes = number[];

/**
 * Persisted wallet record (localStorage). Never holds a decrypted secret —
 * only the raw bytes (if the user opted out of encryption) or an
 * EncryptedKeystoreV1 blob.
 */
export interface StoredWalletRecord {
  id: string;
  name: string;
  address: string;
  createdAt: number;
  encrypted: boolean;
  /** Plaintext secret-key bytes OR an EncryptedKeystoreV1 payload. */
  payload: KeypairBytes | EncryptedKeystoreV1;
}

export interface AppSettings {
  cluster: ClusterName;
  customRpcUrl: string;
  currentWalletId: string | null;
}
