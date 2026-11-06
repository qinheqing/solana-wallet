import { describe, expect, it } from "vitest";
import { CORE_VERSION, type Cluster } from "./index.js";

describe("@solwallet/core smoke", () => {
  it("exports a version", () => {
    expect(CORE_VERSION).toBe("0.1.0");
  });

  it("defines the three official clusters", () => {
    const clusters: Cluster[] = ["mainnet-beta", "devnet", "testnet"];
    expect(clusters).toHaveLength(3);
  });
});
