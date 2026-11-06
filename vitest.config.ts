import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
    // Chain-dependent integration tests are opt-in via RUN_ONCHAIN_TESTS=1
    // (handled per-test with describe.skipIf).
  },
});
