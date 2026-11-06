/**
 * MCP server state: in-memory wallet store + per-cluster connection cache.
 *
 * Wallets live ONLY in process memory — a restart clears them. This is the
 * safe default for a testing tool; persisting keys is an explicit user
 * action via export_secret.
 */
import { ClusterConnection, createConnection } from "@solwallet/core";
import type { Keypair } from "@solana/web3.js";

export type WalletOrigin = "generated" | "keyfile" | "mnemonic";

export interface StoredWallet {
  name: string;
  keypair: Keypair;
  origin: WalletOrigin;
  /** Mnemonic words when the wallet was generated/imported from a phrase. */
  mnemonic?: string;
  derivationPath?: string;
}

export class WalletStore {
  private wallets = new Map<string, StoredWallet>();

  put(wallet: StoredWallet): void {
    this.wallets.set(wallet.name, wallet);
  }

  get(name: string): StoredWallet | undefined {
    return this.wallets.get(name);
  }

  require(name: string): StoredWallet {
    const w = this.wallets.get(name);
    if (!w) {
      throw new Error(
        `Unknown wallet "${name}". Call list_wallets to see loaded wallets, or create_wallet/import_wallet first.`,
      );
    }
    return w;
  }

  list(): StoredWallet[] {
    return [...this.wallets.values()];
  }

  /** Every secret string the sanitizer must never leak. */
  allSecrets(): string[] {
    const out: string[] = [];
    for (const w of this.wallets.values()) {
      if (w.mnemonic) out.push(w.mnemonic);
      if (w.derivationPath) {
        // no secrets in paths; keep structure explicit
      }
      out.push(JSON.stringify(Array.from(w.keypair.secretKey)));
    }
    return out;
  }
}

export class ConnectionManager {
  private cache = new Map<string, ClusterConnection>();

  constructor(
    private readonly factory: (clusterOrUrl: string) => ClusterConnection = (c) =>
      createConnection(c),
  ) {}

  /** Default cluster: env SOLWALLET_CLUSTER, else devnet. */
  defaultCluster(): string {
    return process.env.SOLWALLET_CLUSTER ?? "devnet";
  }

  get(cluster?: string): ClusterConnection {
    const target = cluster ?? this.defaultCluster();
    let conn = this.cache.get(target);
    if (!conn) {
      conn = this.factory(target);
      this.cache.set(target, conn);
    }
    return conn;
  }
}
