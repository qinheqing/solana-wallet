/**
 * Real end-to-end usability check: drives the built MCP server over stdio
 * with live devnet RPC. Sequential JSON-RPC with newline framing.
 */
import { spawn } from "node:child_process";

const CHILD = "dist/cli.js";
const reqs = new Map();
let nextId = 1;
let buffer = "";

const child = spawn("node", [CHILD], {
  cwd: new URL(".", import.meta.url).pathname,
  stdio: ["pipe", "pipe", "inherit"],
});

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && reqs.has(msg.id)) {
        reqs.get(msg.id)(msg);
        reqs.delete(msg.id);
      }
    } catch {
      console.error("[unparsed]", line.slice(0, 100));
    }
  }
});

function request(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reqs.delete(id);
      reject(new Error(`timeout: ${method}`));
    }, timeoutMs);
    reqs.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  });
}

const text = (res) => {
  if (res.result?.isError) return `ERROR: ${res.result.content?.[0]?.text ?? "?"}`;
  const c = res.result?.content?.[0];
  return c?.text ?? JSON.stringify(res.result);
};

async function call(name, args, timeoutMs) {
  const res = await request("tools/call", { name, arguments: args }, timeoutMs);
  if (res.error) return `RPC-ERROR: ${res.error.message}`;
  const t = text(res);
  return res.result?.isError ? `ERROR: ${t}` : t;
}

function section(title) {
  console.log(`\n━━━ ${title} ━━━`);
}

// --- 1. initialize handshake -------------------------------------------------
const init = await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke-driver", version: "0" },
});
console.log("✅ initialize:", init.result.serverInfo.name, init.result.serverInfo.version);
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const tools = await request("tools/list", {});
console.log(`✅ tools/list: ${tools.result.tools.length} tools`);

// --- 2. wallets ---------------------------------------------------------------
section("创建两个钱包（alice 可用 SMOKE_MNEMONIC 固定地址）");
let alice;
if (process.env.SMOKE_MNEMONIC) {
  alice = JSON.parse(
    await call("import_wallet", {
      name: "alice",
      mnemonic: process.env.SMOKE_MNEMONIC,
    }),
  );
  console.log("alice (imported, stable):", alice.address);
} else {
  alice = JSON.parse(await call("create_wallet", { name: "alice" }));
  console.log("alice:", alice.address, `(${alice.words} 词)`);
}
const bob = JSON.parse(await call("create_wallet", { name: "bob" }));
console.log("bob:  ", bob.address);

section("export_secret 应被拒绝（缺危险标志）");
console.log(await call("export_secret", { walletName: "alice", format: "mnemonic" }));

// --- 3. real devnet -----------------------------------------------------------
section("真实 devnet：集群状态");
console.log(await call("get_cluster_status", {}));

section("真实 devnet：给 alice airdrop 2 SOL");
const airdrop = await call("request_airdrop", { walletName: "alice", sol: "2" }, 90_000);
console.log(airdrop);

section("alice 余额");
console.log(await call("get_balances", { walletName: "alice" }, 90_000));

// --- 4. real transfer ----------------------------------------------------------
section("真实转账：alice → bob 0.5 SOL");
console.log(
  await call(
    "transfer",
    { walletName: "alice", to: bob.address, amount: "0.5" },
    120_000,
  ),
);

section("bob 余额（应 ≈0.5 SOL）");
console.log(await call("get_balances", { walletName: "bob" }, 90_000));

// --- 5. batch -------------------------------------------------------------------
section("批量转账：alice → 2 个接收者");
const r1 = KeypairLike();
const r2 = KeypairLike();
console.log(
  await call(
    "batch_transfer",
    {
      walletName: "alice",
      recipients: [
        { to: r1, amount: "0.01" },
        { to: r2, amount: "0.01" },
      ],
    },
    180_000,
  ),
);

section("错误路径：金额 -5");
console.log(await call("transfer", { walletName: "alice", to: bob.address, amount: "-5" }));

child.stdin.end();
child.kill("SIGTERM");

function KeypairLike() {
  // 32 random bytes → base58 (Solana address alphabet), dependency-free.
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  // Leading zero bytes encode as '1'.
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out.padStart(44, "1").slice(0, 44);
}
