/**
 * Token-2022 capabilities (PRD prd-token2022-capabilities.md) end-to-end
 * acceptance driver — real localnet, real MCP server over stdio.
 *
 *   node packages/mcp/acceptance-t22.mjs
 *
 * Requires a local validator on http://127.0.0.1:8899 (solana-test-validator).
 * Scenario 10 (CPI forwarder) needs the solwallet_cpi program deployed; set
 * SOLWALLET_CPI_PROGRAM_ID to override the default (the keypair in
 * packages/cpi-program/target/deploy). It is skipped when not deployed.
 *
 * Prints a PASS/FAIL table at the end and exits 1 on any FAIL. Scenarios are
 * independent as far as practical; a thrown error inside a scenario fails
 * that scenario only.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Connection, MessageV0, PublicKey, VersionedTransaction } from "@solana/web3.js";

const RPC_URL = process.env.SOLWALLET_RPC_URL ?? "http://127.0.0.1:8899";
const HERE = new URL(".", import.meta.url).pathname;

const child = spawn("node", ["dist/cli.js"], {
  cwd: HERE,
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, SOLWALLET_CLUSTER: RPC_URL },
});

// ---------------------------------------------------------------- transport
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
      /* non-JSON line */
    }
  }
});

function request(method, params, timeoutMs = 90_000) {
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
  const failed = Boolean(res.result?.isError) || Boolean(parsed?.error);
  return { isError: failed, mcpIsError: Boolean(res.result?.isError), data: parsed, raw: text };
}

// ---------------------------------------------------------------- reporting
const table = [];
let current = null;
let failures = 0;

function scenario(id, title) {
  current = { id, title, checks: [], failed: 0, values: [] };
  table.push(current);
  console.log(`\n━━━ ${id}: ${title} ━━━`);
}

function check(label, cond, detail) {
  const ok = Boolean(cond);
  current.checks.push({ label, ok, detail });
  if (ok) {
    console.log(`  PASS ${label}${detail ? ` — ${trunc(detail)}` : ""}`);
  } else {
    failures++;
    current.failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${trunc(detail)}` : ""}`);
  }
  return ok;
}

function note(key, value) {
  current.values.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function trunc(s, n = 400) {
  s = typeof s === "string" ? s : JSON.stringify(s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function skip(reason) {
  current.skipped = reason;
  console.log(`  SKIP ${reason}`);
}

async function runScenario(id, title, fn) {
  scenario(id, title);
  try {
    await fn();
  } catch (err) {
    check(`scenario threw: ${err.message}`, false);
  }
}

const findExt = (list, type) => (list ?? []).find((e) => e.type === type);
const findFinding = (pf, code) => (pf?.findings ?? []).find((f) => f.code === code);
const hasKeyDeep = (obj, key) => JSON.stringify(obj).includes(`"${key}"`);

// ---------------------------------------------------------------- main
async function main() {
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "acceptance-t22", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const rpc = new Connection(RPC_URL, "confirmed");
  console.log(`validator: ${RPC_URL} version ${(await rpc.getVersion())["solana-core"]}`);

  // Shared state across scenarios.
  const S = {};
  const DEC = 6;

  // --- bootstrap: payer wallet + funding (not a numbered scenario) ----------
  await runScenario("0", "bootstrap: create_wallet payer/recipient/victim + request_airdrop", async () => {
    S.payer = (await call("create_wallet", { name: "payer" })).data;
    S.recipient = (await call("create_wallet", { name: "recipient" })).data;
    S.victim = (await call("create_wallet", { name: "victim" })).data;
    check("payer address present", typeof S.payer.address === "string" && S.payer.address.length >= 32, S.payer.address);
    for (const [name, sol] of [["payer", "10"], ["recipient", "2"], ["victim", "2"]]) {
      const a = await call("request_airdrop", { walletName: name, sol });
      check(`request_airdrop ${name} ${sol} SOL`, !a.isError, a.isError ? a.raw : a.data.signature);
    }
    note("payer", S.payer.address);
    note("recipient", S.recipient.address);
    note("victim", S.victim.address);
  });

  // --- 1 ---------------------------------------------------------------------
  await runScenario("1", "create_token transfer-fee preset + inspect_mint + derive_address + inspect_token_account", async () => {
    const t = await call("create_token", {
      walletName: "payer",
      preset: "transfer-fee",
      decimals: DEC,
      extensions: { transferFeeConfig: { transferFeeBasisPoints: 100, maximumFee: "1000000000000" } },
      mintTo: { owner: S.payer.address, amount: "1000000" },
    });
    check("create_token ok with mint", !t.isError && Boolean(t.data.mint), t.isError ? t.raw : t.data.mint);
    S.feeMint = t.data.mint;
    note("feeMint", S.feeMint);
    check("create_token.extensions includes transferFeeConfig", t.data.extensions?.includes?.("transferFeeConfig"), JSON.stringify(t.data.extensions));
    check("create_token.mintTo amount 1000000 minted", t.data.mintTo?.amount === "1000000" && !t.data.mintTo?.error, JSON.stringify(t.data.mintTo));

    const m = await call("inspect_mint", { mint: S.feeMint });
    const fee = findExt(m.data.extensions, "TransferFeeConfig");
    check("inspect_mint program token-2022 decimals 6", m.data.program === "token-2022" && m.data.decimals === DEC, `${m.data.program}/${m.data.decimals}`);
    check("inspect_mint TransferFeeConfig newer bps 100", fee?.newerTransferFee?.transferFeeBasisPoints === 100, JSON.stringify(fee));
    check("inspect_mint accountLen present (number)", typeof m.data.accountLen === "number", `accountLen=${m.data.accountLen}`);
    note("accountLen", m.data.accountLen);
    check("inspect_mint withdrawWithheldAuthority == payer", fee?.withdrawWithheldAuthority === S.payer.address, fee?.withdrawWithheldAuthority);

    const d = await call("derive_address", { owner: S.payer.address, mint: S.feeMint });
    check("derive_address legacy != token2022", d.data.legacy?.address && d.data.legacy.address !== d.data.token2022?.address, `${d.data.legacy?.address} vs ${d.data.token2022?.address}`);
    check("derive_address both isOffCurve", d.data.legacy?.isOffCurve === true && d.data.token2022?.isOffCurve === true);
    S.payerFeeAta = d.data.token2022.address;

    const ta = await call("inspect_token_account", { address: S.payerFeeAta });
    check("inspect_token_account resolves token2022 ATA (owner=payer, mint=feeMint)", !ta.isError && ta.data.owner === S.payer.address && ta.data.mint === S.feeMint && ta.data.address === S.payerFeeAta, ta.isError ? ta.raw : `amount=${ta.data.amount}`);
    check("inspect_token_account amount == 1000000", ta.data.amount === "1000000", ta.data.amount);
    check("inspect_token_account dataLength == inspect_mint.accountLen", ta.data.dataLength === m.data.accountLen, `${ta.data.dataLength} vs ${m.data.accountLen}`);

    // Top-up so later scenarios have supply to play with.
    const top = await call("manage_token2022", { walletName: "payer", mint: S.feeMint, action: "mintTokens", params: { destinationOwner: S.payer.address, amount: "99000000" } });
    check("manage_token2022 mintTokens top-up 99000000", !top.isError, top.isError ? top.raw : top.data.signature);
  });

  // --- 2 ---------------------------------------------------------------------
  await runScenario("2", "build_transfer knobs → preflight TRANSFER_FEE → transfer → inspect_transaction fee/net → withheld → no uiAmount", async () => {
    const base = { walletName: "payer", to: S.recipient.address, amount: "1", mint: S.feeMint, decimals: DEC };
    const b = await call("build_transfer", { ...base, computeUnitLimit: 200000, computeUnitPrice: 1, ataMode: "always-idempotent" });
    check("build_transfer ok", !b.isError, b.isError ? b.raw : undefined);
    const labels = b.data.labels ?? b.data.plan?.instructions?.map((i) => i.label);
    const expected = ["setComputeUnitLimit", "setComputeUnitPrice", "createAssociatedTokenAccountIdempotent", "transferChecked"];
    check("labels exactly [CU limit, CU price, createATAIdempotent, transferChecked]", JSON.stringify(labels) === JSON.stringify(expected), JSON.stringify(labels));
    const ixs = b.data.plan?.instructions ?? [];
    check("transferChecked dataHex starts with 0c", ixs[3]?.dataHex?.startsWith("0c"), ixs[3]?.dataHex);
    check("createATAIdempotent dataHex == 01", ixs[2]?.dataHex === "01", ixs[2]?.dataHex);
    check("plan.messageHex non-empty", typeof b.data.plan?.messageHex === "string" && b.data.plan.messageHex.length > 0, `len=${b.data.plan?.messageHex?.length}`);
    check("plan.signers == [payer]", JSON.stringify(b.data.plan?.signers) === JSON.stringify([S.payer.address]), JSON.stringify(b.data.plan?.signers));
    check("amountBaseUnits == 1000000", b.data.amountBaseUnits === "1000000", b.data.amountBaseUnits);
    S.recipientFeeAta = b.data.destinationAta;

    const pf = await call("preflight_transfer", base);
    const feeF = findFinding(pf.data, "TRANSFER_FEE");
    check("preflight ok=true", pf.data.ok === true && !pf.isError, JSON.stringify(pf.data.blocking));
    check("preflight TRANSFER_FEE info finding with expectedFee 10000", feeF?.severity === "info" && feeF?.data?.expectedFee === "10000", JSON.stringify(feeF?.data));
    note("TRANSFER_FEE.data", feeF?.data);
    check("preflight DEST_ATA_MISSING info (recipient ATA not yet created)", findFinding(pf.data, "DEST_ATA_MISSING")?.severity === "info");

    const tx = await call("transfer", base);
    check("transfer ok with signature", !tx.isError && typeof tx.data.signature === "string" && tx.data.signature.length > 40, tx.isError ? tx.raw : tx.data.signature);
    check("transfer result carries plan + preflight", Boolean(tx.data.plan?.messageHex) && Array.isArray(tx.data.preflight?.findings));
    S.feeTxSig = tx.data.signature;

    const ins = await call("inspect_transaction", { signature: S.feeTxSig });
    const mv = ins.data.movements ?? [];
    check("inspect_transaction exactly one movement (transferChecked)", mv.length === 1 && mv[0].instructionType === "transferChecked", JSON.stringify(mv.map((m) => m.instructionType)));
    check("movement.amount == 1000000", mv[0]?.amount === "1000000", mv[0]?.amount);
    check("movement.fee == {10000, balance-delta}", mv[0]?.fee?.amount === "10000" && mv[0]?.fee?.source === "balance-delta", JSON.stringify(mv[0]?.fee));
    check("movement.balanceDelta == 990000", mv[0]?.balanceDelta === "990000", mv[0]?.balanceDelta);
    check("movement isInner false, program token-2022", mv[0]?.isInner === false && mv[0]?.program === "token-2022");
    check("inspect_transaction.explorerUrl present", typeof ins.data.explorerUrl === "string", ins.data.explorerUrl);
    note("movement", { amount: mv[0]?.amount, fee: mv[0]?.fee, balanceDelta: mv[0]?.balanceDelta });

    const ra = await call("inspect_token_account", { address: S.recipientFeeAta });
    const wh = findExt(ra.data.extensions, "TransferFeeAmount");
    check("recipient ATA withheldAmount == 10000", wh?.withheldAmount === "10000", JSON.stringify(wh));
    check("recipient ATA amount == 990000", ra.data.amount === "990000", ra.data.amount);

    const bal = await call("get_balances", { walletName: "payer" });
    check("get_balances has no uiAmount key anywhere", !bal.isError && !hasKeyDeep(bal.data, "uiAmount"), trunc(bal.raw, 300));
    const tok = (bal.data.tokens ?? bal.data.tokenBalances ?? []).find?.((t) => t.mint === S.feeMint);
    check("get_balances lists feeMint raw amount 99000000", tok && (tok.amount === "99000000" || tok.amountBaseUnits === "99000000"), JSON.stringify(tok));
  });

  // --- 3 ---------------------------------------------------------------------
  await runScenario("3", "enableMemoTransfer → MEMO_REQUIRED block → force NoMemo(36) → memo ok → disableMemoTransfer", async () => {
    const en = await call("manage_token2022", { walletName: "recipient", mint: S.feeMint, action: "enableMemoTransfer" });
    check("enableMemoTransfer ok", !en.isError, en.isError ? en.raw : en.data.signature);
    check("enableMemoTransfer.tokenAccount == recipient ATA", en.data.tokenAccount === S.recipientFeeAta, en.data.tokenAccount);
    const ta = await call("inspect_token_account", { address: S.recipientFeeAta });
    const memo = findExt(ta.data.extensions, "MemoTransfer");
    check("inspect_token_account MemoTransfer.requireIncomingTransferMemos true", memo?.requireIncomingTransferMemos === true, JSON.stringify(memo));

    const base = { walletName: "payer", to: S.recipient.address, amount: "1", mint: S.feeMint, decimals: DEC };
    const blocked = await call("transfer", base);
    check("transfer blocked: isError + error.code PREFLIGHT_BLOCKED", blocked.isError && blocked.data.error?.code === "PREFLIGHT_BLOCKED", trunc(blocked.raw, 200));
    check("blocked result has MEMO_REQUIRED block finding", findFinding(blocked.data.preflight, "MEMO_REQUIRED")?.severity === "block", JSON.stringify(blocked.data.preflight?.findings?.map((f) => f.code)));

    const forced = await call("transfer", { ...base, force: true });
    check("transfer force:true → isError", forced.isError, trunc(forced.raw, 300));
    const custom = forced.data.error?.custom;
    check("forced error.custom.code === 36 (NoMemo)", custom?.code === 36, `error=${JSON.stringify(forced.data.error)}`);
    note("forcedError", forced.data.error);

    const withMemo = await call("transfer", { ...base, memo: "hello" });
    check("transfer memo:'hello' ok", !withMemo.isError && Boolean(withMemo.data.signature), withMemo.isError ? withMemo.raw : withMemo.data.signature);
    check("plan labels include memo before transferChecked", (() => { const l = withMemo.data.plan?.instructions?.map((i) => i.label) ?? []; return l.indexOf("memo") >= 0 && l.indexOf("memo") < l.indexOf("transferChecked"); })(), JSON.stringify(withMemo.data.plan?.instructions?.map((i) => i.label)));
    const ins = await call("inspect_transaction", { signature: withMemo.data.signature });
    check("inspect_transaction: memo ix not counted as movement (1 movement)", ins.data.movements?.length === 1 && ins.data.movements[0].instructionType === "transferChecked", JSON.stringify(ins.data.movements?.map((m) => m.instructionType)));
    check("inspect_transaction: no warnings about memo", (ins.data.warnings ?? []).length === 0, JSON.stringify(ins.data.warnings));

    const dis = await call("manage_token2022", { walletName: "recipient", mint: S.feeMint, action: "disableMemoTransfer" });
    check("disableMemoTransfer ok", !dis.isError, dis.isError ? dis.raw : dis.data.signature);
    const ta2 = await call("inspect_token_account", { address: S.recipientFeeAta });
    check("MemoTransfer.requireIncomingTransferMemos now false", findExt(ta2.data.extensions, "MemoTransfer")?.requireIncomingTransferMemos === false, JSON.stringify(findExt(ta2.data.extensions, "MemoTransfer")));
    const plain = await call("transfer", base);
    check("transfer without memo succeeds after disable", !plain.isError && Boolean(plain.data.signature), plain.isError ? plain.raw : plain.data.signature);
  });

  // --- 4 ---------------------------------------------------------------------
  await runScenario("4", "withdrawWithheldFromAccounts by payer (withdraw authority) → withheld 0, payer ATA increased", async () => {
    const before = await call("inspect_token_account", { address: S.recipientFeeAta });
    const withheldBefore = BigInt(findExt(before.data.extensions, "TransferFeeAmount")?.withheldAmount ?? "0");
    const payerBefore = BigInt((await call("inspect_token_account", { address: S.payerFeeAta })).data.amount);
    check("recipient ATA has withheld > 0 before withdraw", withheldBefore > 0n, withheldBefore.toString());
    note("withheldBefore", withheldBefore.toString());

    const w = await call("manage_token2022", { walletName: "payer", mint: S.feeMint, action: "withdrawWithheldFromAccounts", params: { sources: [S.recipientFeeAta] } });
    check("withdrawWithheldFromAccounts ok", !w.isError, w.isError ? w.raw : w.data.signature);

    const after = await call("inspect_token_account", { address: S.recipientFeeAta });
    check("recipient ATA withheld == 0", findExt(after.data.extensions, "TransferFeeAmount")?.withheldAmount === "0", JSON.stringify(findExt(after.data.extensions, "TransferFeeAmount")));
    const payerAfter = BigInt((await call("inspect_token_account", { address: S.payerFeeAta })).data.amount);
    check("payer ATA increased by withheld", payerAfter - payerBefore === withheldBefore, `${payerBefore} → ${payerAfter} (Δ ${payerAfter - payerBefore})`);

    if (w.data.signature) {
      const ins = await call("inspect_transaction", { signature: w.data.signature });
      const mv = ins.data.movements?.[0];
      check("inspect_transaction movement withdrawWithheldTokensFromAccounts", mv?.instructionType === "withdrawWithheldTokensFromAccounts", JSON.stringify(ins.data.movements?.map((m) => m.instructionType)));
      check("withdraw movement balanceDelta == withheld", mv?.balanceDelta === withheldBefore.toString(), `balanceDelta=${mv?.balanceDelta}`);
    }
  });

  // --- 5 ---------------------------------------------------------------------
  await runScenario("5", "permanent-delegate preset: payer moves victim's tokens; preflight PERMANENT_DELEGATE_TRANSFER", async () => {
    const t = await call("create_token", { walletName: "payer", preset: "permanent-delegate", decimals: DEC, mintTo: { owner: S.victim.address, amount: "1000000" } });
    check("create_token permanent-delegate ok", !t.isError && Boolean(t.data.mint), t.isError ? t.raw : t.data.mint);
    S.pdMint = t.data.mint;
    note("pdMint", S.pdMint);
    const m = await call("inspect_mint", { mint: S.pdMint });
    check("inspect_mint PermanentDelegate.delegate == payer", findExt(m.data.extensions, "PermanentDelegate")?.delegate === S.payer.address, JSON.stringify(findExt(m.data.extensions, "PermanentDelegate")));

    const args = { walletName: "payer", sourceOwner: S.victim.address, to: S.payer.address, amount: "0.5", mint: S.pdMint, decimals: DEC };
    const pf = await call("preflight_transfer", args);
    check("preflight PERMANENT_DELEGATE_TRANSFER finding", Boolean(findFinding(pf.data, "PERMANENT_DELEGATE_TRANSFER")), JSON.stringify(pf.data.findings?.map((f) => `${f.code}:${f.severity}`)));
    check("preflight ok=true", pf.data.ok === true, JSON.stringify(pf.data.blocking));

    const tx = await call("transfer", args);
    check("transfer by permanent delegate ok", !tx.isError && Boolean(tx.data.signature), tx.isError ? tx.raw : tx.data.signature);
    const ins = await call("inspect_transaction", { signature: tx.data.signature });
    const mv = ins.data.movements?.[0];
    check("movement.authority == payer", mv?.authority === S.payer.address, mv?.authority);
    check("movement.sourceOwner == victim", mv?.sourceOwner === S.victim.address, mv?.sourceOwner);
    check("movement.destOwner == payer, amount 500000", mv?.destOwner === S.payer.address && mv?.amount === "500000", JSON.stringify({ destOwner: mv?.destOwner, amount: mv?.amount }));
  });

  // --- 6 ---------------------------------------------------------------------
  await runScenario("6", "approve_delegate 500 → over-limit blocked → within-limit ok (DELEGATE_TRANSFER) → revoke → AUTHORITY_NOT_DELEGATE", async () => {
    const t = await call("create_token", { walletName: "payer", preset: "plain-2022", decimals: DEC, mintTo: { owner: S.victim.address, amount: "1000000" } });
    check("create_token plain-2022 ok", !t.isError && Boolean(t.data.mint), t.isError ? t.raw : t.data.mint);
    S.plainMint = t.data.mint;
    note("plainMint", S.plainMint);

    const ap = await call("approve_delegate", { walletName: "victim", mint: S.plainMint, delegate: S.payer.address, amount: "0.0005", decimals: DEC });
    check("approve_delegate 500 base units ok", !ap.isError && ap.data.amountBaseUnits === "500", ap.isError ? ap.raw : JSON.stringify({ sig: ap.data.signature, base: ap.data.amountBaseUnits }));
    const dta = (await call("derive_address", { owner: S.victim.address, mint: S.plainMint })).data.token2022.address;
    const acct = await call("inspect_token_account", { address: dta });
    check("victim ATA delegate == payer, delegatedAmount 500", acct.data.delegate === S.payer.address && acct.data.delegatedAmount === "500", JSON.stringify({ delegate: acct.data.delegate, delegatedAmount: acct.data.delegatedAmount }));

    const args = { walletName: "payer", sourceOwner: S.victim.address, to: S.payer.address, mint: S.plainMint, decimals: DEC };
    const over = await call("transfer", { ...args, amount: "0.001" });
    check("transfer 1000 blocked PREFLIGHT_BLOCKED + INSUFFICIENT_DELEGATED_AMOUNT", over.isError && over.data.error?.code === "PREFLIGHT_BLOCKED" && findFinding(over.data.preflight, "INSUFFICIENT_DELEGATED_AMOUNT")?.severity === "block", trunc(over.raw, 300));

    const within = await call("transfer", { ...args, amount: "0.0004" });
    check("transfer 400 ok", !within.isError && Boolean(within.data.signature), within.isError ? within.raw : within.data.signature);
    check("transfer 400 preflight has DELEGATE_TRANSFER info", findFinding(within.data.preflight, "DELEGATE_TRANSFER")?.severity === "info", JSON.stringify(within.data.preflight?.findings?.map((f) => `${f.code}:${f.severity}`)));

    const rv = await call("revoke_delegate", { walletName: "victim", mint: S.plainMint });
    check("revoke_delegate ok", !rv.isError, rv.isError ? rv.raw : rv.data.signature);
    const after = await call("transfer", { ...args, amount: "0.0001" });
    check("post-revoke transfer blocked AUTHORITY_NOT_DELEGATE", after.isError && after.data.error?.code === "PREFLIGHT_BLOCKED" && findFinding(after.data.preflight, "AUTHORITY_NOT_DELEGATE")?.severity === "block", trunc(after.raw, 300));
  });

  // --- 7 ---------------------------------------------------------------------
  await runScenario("7", "instruction=transfer (03) → on-chain custom 31; ataMode=create on existing ATA fails", async () => {
    const base = { walletName: "payer", to: S.recipient.address, amount: "0.1", mint: S.feeMint, decimals: DEC };
    const b = await call("build_transfer", { ...base, instruction: "transfer" });
    const ix = b.data.plan?.instructions?.find((i) => i.label === "transfer");
    check("build_transfer instruction=transfer → label 'transfer' dataHex starts 03", ix?.dataHex?.startsWith("03"), JSON.stringify(b.data.plan?.instructions?.map((i) => [i.label, i.dataHex])));

    const tx = await call("transfer", { ...base, instruction: "transfer", force: true, skipPreflight: true });
    check("transfer(plain) on fee mint → isError", tx.isError, trunc(tx.raw, 300));
    check("error.custom.code === 31 (MintRequiredForTransfer) surfaced", tx.data.error?.custom?.code === 31, `error=${JSON.stringify(tx.data.error)}`);
    note("plainTransferError", tx.data.error);

    const bc = await call("build_transfer", { ...base, ataMode: "create" });
    const createIx = bc.data.plan?.instructions?.find((i) => /createAssociatedTokenAccount$/.test(i.label ?? ""));
    check("build_transfer ataMode=create → non-idempotent create ix with dataHex ''", createIx !== undefined && createIx.dataHex === "", JSON.stringify(bc.data.plan?.instructions?.map((i) => [i.label, i.dataHex])));
    const txc = await call("transfer", { ...base, ataMode: "create", force: true });
    check("transfer ataMode=create to existing ATA → isError", txc.isError, trunc(txc.raw, 300));
    note("ataCreateError", txc.data.error);
  });

  // --- 8 ---------------------------------------------------------------------
  await runScenario("8", "raw channel: dryRun plan.messageHex → local VersionedTransaction → sign_transaction → simulate → send", async () => {
    const dry = await call("transfer", { walletName: "payer", to: S.recipient.address, amount: "0.1", mint: S.feeMint, decimals: DEC, dryRun: true });
    check("transfer dryRun ok + simulatedOnly", !dry.isError && dry.data.simulatedOnly === true && dry.data.ok === true, trunc(dry.raw, 200));
    const hex = dry.data.plan?.messageHex;
    check("dryRun plan.messageHex present", typeof hex === "string" && hex.length > 0);
    const msg = MessageV0.deserialize(Buffer.from(hex, "hex"));
    const vtx = new VersionedTransaction(msg);
    const unsignedHex = Buffer.from(vtx.serialize()).toString("hex");

    const signed = await call("sign_transaction", { transaction: unsignedHex, walletNames: ["payer"] });
    check("sign_transaction fullySigned true, signedBy payer", !signed.isError && signed.data.fullySigned === true && signed.data.signedBy?.[0] === S.payer.address, signed.isError ? signed.raw : JSON.stringify({ kind: signed.data.kind, encoding: signed.data.encoding }));
    const sim = await call("simulate_transaction", { transaction: signed.data.txHex });
    check("simulate_transaction ok", !sim.isError && sim.data.ok === true, trunc(sim.raw, 300));
    const sent = await call("send_transaction", { transaction: signed.data.txHex });
    check("send_transaction confirmed signature", !sent.isError && typeof sent.data.signature === "string" && sent.data.signature.length > 40, sent.isError ? sent.raw : sent.data.signature);
    if (sent.data.signature) {
      const ins = await call("inspect_transaction", { signature: sent.data.signature });
      check("inspect_transaction of raw-sent tx: amount 100000", ins.data.movements?.[0]?.amount === "100000", JSON.stringify(ins.data.movements?.[0]?.amount));
    }
    // Also: sign with a non-required wallet must be refused.
    const bad = await call("sign_transaction", { transaction: unsignedHex, walletNames: ["victim"] });
    check("sign_transaction with non-required wallet → SIGNER_NOT_REQUIRED", bad.isError && bad.data.error?.code === "SIGNER_NOT_REQUIRED", trunc(bad.raw, 200));
  });

  // --- 9 ---------------------------------------------------------------------
  await runScenario("9", "scaled-ui preset multiplier 1.5 → updateScaledUiMultiplier 2; legacy-spl accountLen 165", async () => {
    const t = await call("create_token", { walletName: "payer", preset: "scaled-ui" });
    check("create_token scaled-ui ok", !t.isError && Boolean(t.data.mint), t.isError ? t.raw : t.data.mint);
    const m1 = await call("inspect_mint", { mint: t.data.mint });
    const s1 = findExt(m1.data.extensions, "ScaledUiAmount");
    check("inspect_mint ScaledUiAmount multiplier 1.5", s1?.multiplier === 1.5, JSON.stringify(s1));
    const up = await call("manage_token2022", { walletName: "payer", mint: t.data.mint, action: "updateScaledUiMultiplier", params: { multiplier: 2 } });
    check("updateScaledUiMultiplier 2 ok", !up.isError, up.isError ? up.raw : up.data.signature);
    const m2 = await call("inspect_mint", { mint: t.data.mint });
    const s2 = findExt(m2.data.extensions, "ScaledUiAmount");
    check("inspect_mint shows multiplier 2 (multiplier or newMultiplier)", s2?.multiplier === 2 || s2?.newMultiplier === 2, JSON.stringify(s2));
    note("scaledUiAfter", s2);

    const l = await call("create_token", { walletName: "payer", preset: "legacy-spl" });
    check("create_token legacy-spl ok", !l.isError && l.data.tokenProgram === "spl-token", l.isError ? l.raw : l.data.mint);
    const ml = await call("inspect_mint", { mint: l.data.mint });
    check("inspect_mint legacy: program spl-token, accountLen 165, no extensions", ml.data.program === "spl-token" && ml.data.accountLen === 165 && (ml.data.extensions ?? []).length === 0, JSON.stringify({ program: ml.data.program, accountLen: ml.data.accountLen, ext: ml.data.extensions }));
  });

  // --- 10 --------------------------------------------------------------------
  await runScenario("10", "cpi_token_transfer through solwallet_cpi → inspect_transaction movement isInner", async () => {
    let programId = process.env.SOLWALLET_CPI_PROGRAM_ID;
    if (!programId) {
      const kp = `${HERE}../cpi-program/target/deploy/solwallet_cpi-keypair.json`;
      if (existsSync(kp)) {
        const { Keypair } = await import("@solana/web3.js");
        programId = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(kp, "utf8")))).publicKey.toBase58();
      }
    }
    if (!programId) return skip("no SOLWALLET_CPI_PROGRAM_ID and no program keypair in packages/cpi-program/target/deploy");
    const info = await rpc.getAccountInfo(new PublicKey(programId));
    if (!info?.executable) return skip(`program ${programId} not deployed on ${RPC_URL} (solana program deploy packages/cpi-program/target/deploy/solwallet_cpi.so --program-id …/solwallet_cpi-keypair.json)`);
    note("cpiProgram", programId);

    const r = await call("cpi_token_transfer", { walletName: "payer", programId, destination: S.victim.address, mint: S.feeMint, amount: "0.2", decimals: DEC });
    check("cpi_token_transfer ok with signature", !r.isError && Boolean(r.data.signature), r.isError ? r.raw : r.data.signature);
    check("cpi_token_transfer program token-2022, amountBaseUnits 200000, destinationAtaCreated", r.data.program === "token-2022" && r.data.amountBaseUnits === "200000" && r.data.destinationAtaCreated === true, JSON.stringify({ program: r.data.program, base: r.data.amountBaseUnits, created: r.data.destinationAtaCreated }));
    const ins = await call("inspect_transaction", { signature: r.data.signature });
    const mv = ins.data.movements ?? [];
    const inner = mv.find((m) => m.instructionType === "transferChecked");
    check("inspect_transaction movement transferChecked isInner === true", inner?.isInner === true, JSON.stringify(mv.map((m) => ({ type: m.instructionType, isInner: m.isInner, idx: m.instructionIndex, inner: m.innerIndex }))));
    check("inner movement amount 200000 fee 2000 balanceDelta 198000", inner?.amount === "200000" && inner?.fee?.amount === "2000" && inner?.balanceDelta === "198000", JSON.stringify({ amount: inner?.amount, fee: inner?.fee, delta: inner?.balanceDelta }));
    check("inner movement authority == payer (no PDA custody)", inner?.authority === S.payer.address, inner?.authority);
  });

  // ---------------------------------------------------------------- table
  console.log("\n━━━ RESULT TABLE ━━━");
  const rows = table.map((s) => {
    const status = s.skipped ? "SKIP" : s.failed ? "FAIL" : "PASS";
    const n = `${s.checks.length - s.failed}/${s.checks.length}`;
    return `${status.padEnd(5)} #${s.id.padEnd(3)} ${n.padEnd(6)} ${s.title}${s.values.length ? `\n           ${s.values.join("  ")}` : ""}${s.skipped ? `\n           ${s.skipped}` : ""}`;
  });
  console.log(rows.join("\n"));
  console.log(`\n━━━ ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ━━━\n`);
  child.stdin.end();
  child.kill("SIGTERM");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL:", err.stack ?? err.message);
  child.kill("SIGTERM");
  process.exit(1);
});
