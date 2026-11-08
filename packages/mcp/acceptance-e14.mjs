/**
 * Task #14 end-to-end acceptance driver — real localnet, real MCP server
 * over stdio, exercising PRD §6 MVP criteria 1, 3 (criterion 4 is the
 * `pnpm test` run; criterion 2 — Web UI parity — is verified by code
 * review + build, since no browser-automation tool is configured here).
 *
 * Criterion 1: generate wallet → airdrop → create Token2022 (transfer fee)
 *              → batch transfer → query balance, all via MCP tool calls.
 * Criterion 3: 2-of-3 multisig SOL transfer: create → propose → approve×2
 *              → execute.
 */
import { spawn } from "node:child_process";

const child = spawn("node", ["dist/cli.js"], {
  cwd: new URL(".", import.meta.url).pathname,
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, SOLWALLET_CLUSTER: "http://127.0.0.1:8899" },
});

const reqs = new Map();
let nextId = 1;
let buffer = "";
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
      /* ignore non-JSON lines (server banner on stderr is separate) */
    }
  }
});

function request(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method} ${JSON.stringify(params)}`)), timeoutMs);
    reqs.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(name, args, timeoutMs) {
  const res = await request("tools/call", { name, arguments: args }, timeoutMs);
  if (res.error) throw new Error(`RPC error on ${name}: ${res.error.message}`);
  const text = res.result?.content?.[0]?.text ?? "{}";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  // Two failure channels exist in this codebase: the MCP-level `isError`
  // flag (thrown exceptions, caught by run()) AND an in-band `error` field
  // on results that use the "return, don't throw" pattern (transfer,
  // create_multisig, propose/approve/execute_multisig, etc). A check that
  // only looks at `isError` produces false positives on the second kind.
  const failed = Boolean(res.result?.isError) || Boolean(parsed?.error);
  return { isError: failed, data: parsed, raw: text };
}

async function main() {
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "acceptance-14", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  console.log("\n━━━ Criterion 1: wallet → airdrop → Token-2022(fee) → batch transfer → balance ━━━");

  const alice = (await call("create_wallet", { name: "alice" })).data;
  check("create_wallet: alice has a valid address", typeof alice.address === "string" && alice.address.length >= 32);

  const r1 = (await call("create_wallet", { name: "r1" })).data;
  const r2 = (await call("create_wallet", { name: "r2" })).data;

  const airdrop = await call("request_airdrop", { walletName: "alice", lamports: "5000000000" }, 60_000);
  check("request_airdrop: alice funded on localnet (real faucet)", !airdrop.isError, airdrop.raw);

  const aliceBalance0 = (await call("get_balances", { walletName: "alice" })).data;
  check("get_balances: alice SOL ≈ 5 after airdrop", aliceBalance0.solUi >= 4.9, `got ${aliceBalance0.solUi}`);

  const token = await call("create_token", {
    walletName: "alice",
    decimals: 6,
    tokenProgram: "token-2022",
    extensions: {
      transferFeeConfig: { transferFeeBasisPoints: 100, maximumFee: "1000000" }, // 1% fee, cap 1 token
    },
  });
  check("create_token: Token-2022 mint created with transferFeeConfig", !token.isError && Boolean(token.data.mint), token.raw.slice(0, 200));
  check("create_token: extensions report includes transferFeeConfig", token.data.extensions?.includes?.("transferFeeConfig"), JSON.stringify(token.data.extensions));

  const mint = token.data.mint;
  const mintResult = await call("manage_token2022", {
    walletName: "alice",
    mint,
    action: "mintTokens",
    params: { destinationOwner: alice.address, amount: "1000000000" }, // 1000 tokens @6dp
  });
  check("manage_token2022 mintTokens: minted to alice", !mintResult.isError, mintResult.raw.slice(0, 200));

  const batch = await call(
    "batch_transfer",
    {
      walletName: "alice",
      recipients: [
        { to: r1.address, amount: "10000000" }, // 0.01 SOL in lamports
        { to: r2.address, amount: "10000000" },
      ],
    },
    60_000,
  );
  check("batch_transfer: all chunks sent successfully", !batch.isError && /sent successfully/.test(batch.data.summary ?? ""), batch.raw.slice(0, 300));

  const r1Balance = (await call("get_balances", { walletName: "r1" })).data;
  check("get_balances: r1 received 0.01 SOL via batch (solLamports + solDisplay)", r1Balance.solLamports === 10_000_000 && r1Balance.solDisplay === "0.01 SOL", `got ${r1Balance.solLamports} / ${r1Balance.solDisplay}`);

  console.log("\n━━━ Criterion 3: 2-of-3 multisig SOL transfer (create → propose → approve×2 → execute) ━━━");

  const m1 = (await call("create_wallet", { name: "m1" })).data;
  const m2 = (await call("create_wallet", { name: "m2" })).data;
  const m3 = (await call("create_wallet", { name: "m3" })).data;
  await call("request_airdrop", { walletName: "m1", lamports: "2000000000" }, 60_000);
  await call("request_airdrop", { walletName: "m2", lamports: "2000000000" }, 60_000);

  const ms = await call("create_multisig", {
    walletName: "m1",
    members: [m1.address, m2.address, m3.address],
    threshold: 2,
  });
  check("create_multisig: 2-of-3 created", !ms.isError && Boolean(ms.data.multisigPda), ms.raw.slice(0, 300));

  const fundVault = await call("request_airdrop", { address: ms.data.vaultPda, lamports: "1000000000" }, 60_000);
  check("request_airdrop: multisig vault funded", !fundVault.isError, fundVault.raw.slice(0, 200));

  const beneficiary = (await call("create_wallet", { name: "beneficiary" })).data;
  const proposal = await call("propose_multisig", {
    walletName: "m1",
    multisigPda: ms.data.multisigPda,
    to: beneficiary.address,
    amount: "100000000", // 0.1 SOL in lamports
  });
  check("propose_multisig: proposal created (active)", !proposal.isError && proposal.data.transactionIndex !== undefined, proposal.raw.slice(0, 300));

  const txIndex = proposal.data.transactionIndex;
  const approve1 = await call("approve_multisig", { walletName: "m1", multisigPda: ms.data.multisigPda, transactionIndex: txIndex });
  check("approve_multisig: m1 approved (1/2)", !approve1.isError, approve1.raw.slice(0, 200));

  const approve2 = await call("approve_multisig", { walletName: "m2", multisigPda: ms.data.multisigPda, transactionIndex: txIndex });
  check("approve_multisig: m2 approved → executeReady", !approve2.isError && approve2.data.executeReady === true, approve2.raw.slice(0, 300));

  const exec = await call("execute_multisig", { walletName: "m1", multisigPda: ms.data.multisigPda, transactionIndex: txIndex }, 60_000);
  check("execute_multisig: executed with signature", !exec.isError && Boolean(exec.data.signature), exec.raw.slice(0, 300));

  const beneficiaryBalance = (await call("get_balances", { walletName: "beneficiary" })).data;
  check("get_balances: beneficiary received 0.1 SOL from multisig vault", Math.abs(beneficiaryBalance.solUi - 0.1) < 1e-6, `got ${beneficiaryBalance.solUi}`);

  const state = await call("get_multisig", { multisigPda: ms.data.multisigPda });
  const execProposal = state.data.proposals?.find((p) => p.transactionIndex === txIndex);
  check("get_multisig: proposal status is 'executed'", execProposal?.status === "executed", JSON.stringify(execProposal));

  console.log(`\n━━━ RESULT: ${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`} ━━━\n`);
  child.stdin.end();
  child.kill("SIGTERM");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  child.kill("SIGTERM");
  process.exit(1);
});
