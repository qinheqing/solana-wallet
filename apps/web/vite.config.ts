import { defineConfig } from "vite";

// Local validator reached through the dev server, so remote browsers only
// need port 5173 (no firewall / secure-context / CORS concerns on 8899).
// Override with SOLWALLET_LOCAL_RPC=http://host:port (ws port = rpc + 1).
const LOCAL_RPC = process.env.SOLWALLET_LOCAL_RPC ?? "http://127.0.0.1:8899";
const LOCAL_WS = LOCAL_RPC.replace(/^http/, "ws").replace(/:(\d+)$/, (_m, p) => `:${Number(p) + 1}`);
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  define: {
    // @solana/web3.js and friends expect a Node-like `global`.
    global: "globalThis",
  },
  resolve: {
    alias: {
      buffer: "buffer",
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      define: { global: "globalThis" },
    },
    include: ["buffer"],
  },
  server: {
    proxy: {
      "/rpc-ws": { target: LOCAL_WS, ws: true, rewrite: () => "/" },
      "/rpc": { target: LOCAL_RPC, changeOrigin: true, rewrite: () => "/" },
    },
  },
  build: {
    outDir: "dist",
  },
});
