/**
 * Cluster types and endpoint mapping.
 */
import { clusterApiUrl } from "@solana/web3.js";

/** Supported cluster targets. `custom` is derived from a raw RPC URL. */
export type Cluster = "mainnet-beta" | "devnet" | "testnet" | "custom";

/** Official cluster RPC endpoints (public, rate-limited). */
export const OFFICIAL_CLUSTERS = ["mainnet-beta", "devnet", "testnet"] as const;
export type OfficialCluster = (typeof OFFICIAL_CLUSTERS)[number];

export const CLUSTER_ENDPOINTS: Record<OfficialCluster, string> = {
  "mainnet-beta": clusterApiUrl("mainnet-beta"),
  devnet: clusterApiUrl("devnet"),
  testnet: clusterApiUrl("testnet"),
};

/** Resolved connection target. */
export interface ClusterTarget {
  cluster: Cluster;
  rpcUrl: string;
}

/**
 * Resolve a cluster name or a raw RPC URL into a concrete target.
 *
 * @param target - Official cluster name, or any https RPC URL (Helius, QuickNode…)
 * @throws if the string is neither an official cluster nor an https URL
 */
export function resolveClusterTarget(target: Cluster | string): ClusterTarget {
  if ((OFFICIAL_CLUSTERS as readonly string[]).includes(target)) {
    const cluster = target as OfficialCluster;
    return { cluster, rpcUrl: CLUSTER_ENDPOINTS[cluster] };
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(
      `Invalid cluster target: "${target}". Pass an official cluster (${OFFICIAL_CLUSTERS.join(", ")}) or an https RPC URL.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`RPC URL must be http(s), got: "${target}"`);
  }
  // A URL equal to an official endpoint still counts as that cluster.
  for (const [name, endpoint] of Object.entries(CLUSTER_ENDPOINTS)) {
    if (url.origin === new URL(endpoint).origin) {
      return { cluster: name as OfficialCluster, rpcUrl: endpoint };
    }
  }
  return { cluster: "custom", rpcUrl: url.toString() };
}
