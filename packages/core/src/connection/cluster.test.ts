import { describe, expect, it } from "vitest";
import { CLUSTER_ENDPOINTS, resolveClusterTarget } from "./cluster.js";

describe("resolveClusterTarget", () => {
  it("maps official clusters to official endpoints", () => {
    for (const name of ["mainnet-beta", "devnet", "testnet"] as const) {
      const t = resolveClusterTarget(name);
      expect(t.cluster).toBe(name);
      expect(t.rpcUrl).toBe(CLUSTER_ENDPOINTS[name]);
    }
  });

  it("resolves custom RPC URLs as custom", () => {
    const t = resolveClusterTarget("https://my-node.helius-rpc.com/?api-key=x");
    expect(t.cluster).toBe("custom");
    expect(t.rpcUrl).toContain("helius");
  });

  it("recognizes official endpoints passed as URLs", () => {
    const t = resolveClusterTarget(CLUSTER_ENDPOINTS.devnet);
    expect(t.cluster).toBe("devnet");
  });

  it("rejects garbage targets", () => {
    expect(() => resolveClusterTarget("not-a-url-or-cluster")).toThrow(/Invalid cluster target/);
    expect(() => resolveClusterTarget("ftp://example.com")).toThrow(/http\(s\)/);
  });
});
