/**
 * Example B — MemoTransfer: blocked locally, rejected on chain when forced,
 * accepted with a memo.
 *
 *   create (preset memo-required) + mintTo payer
 *   → enableMemoTransfer on the recipient's ATA (recipient signs & pays)
 *   → transfer            → PREFLIGHT_BLOCKED / MEMO_REQUIRED (nothing sent)
 *   → transfer force      → on-chain NoMemo (custom error 36) in error.custom
 *   → transfer memo       → success; inspectTransaction shows the full amount landing
 *
 * Run: pnpm example examples/memo-block-and-force.ts
 */
import { Keypair } from "@solana/web3.js";
import {
  createFromPreset,
  deriveTokenAddresses,
  enableMemoTransfer,
  inspectTokenAccount,
  inspectTransaction,
  transfer,
} from "@solwallet/core";

import { assertOk, connect, ensureFunded, expect, loadPayer, log, runExample, short, txRef } from "./lib.js";

const DECIMALS = 6;
const MINT_AMOUNT = 5_000_000n;
const SEND_AMOUNT = 1_000_000n;
const NO_MEMO_CODE = 36;

await runExample("memo-block-and-force", async (steps) => {
  const conn = connect();
  const payer = await loadPayer();
  await ensureFunded(conn, payer, "payer");
  const recipient = Keypair.generate();
  await ensureFunded(conn, recipient, "recipient"); // pays for its ATA realloc

  // 1. Plain Token-2022 mint; "memo required" is an ACCOUNT extension, enabled next.
  const created = assertOk(
    "createFromPreset",
    await createFromPreset(conn, payer, "memo-required", {
      decimals: DECIMALS,
      mintTo: { owner: payer.publicKey, amount: MINT_AMOUNT },
    }),
  );
  log(`mint ${short(created.mint)} created`);
  steps.create = { mint: created.mint, preset: created.preset, notes: created.notes, ...txRef(conn, created.signature) };

  // 2. Recipient requires memos on its ATA (created + reallocated in the same tx).
  const enabled = assertOk("enableMemoTransfer", await enableMemoTransfer(conn, { owner: recipient, mint: created.mint }));
  const recipientAta = deriveTokenAddresses({ owner: recipient.publicKey, mint: created.mint }).token2022.address;
  const account = await inspectTokenAccount(conn, recipientAta);
  const memoExt = account.extensions.find((e) => e.type === "MemoTransfer");
  expect(memoExt !== undefined && "requireIncomingTransferMemos" in memoExt && memoExt.requireIncomingTransferMemos, "MemoTransfer enabled on recipient ATA");
  steps.enableMemo = { tokenAccount: recipientAta, ...txRef(conn, enabled.signature), extension: memoExt };

  const base = {
    from: payer,
    destination: recipient.publicKey,
    mint: created.mint,
    amount: SEND_AMOUNT,
    decimals: DECIMALS,
  };

  // 3. No memo → local preflight blocks; nothing reaches the chain.
  const blocked = await transfer(conn, base);
  expect(blocked.error?.code === "PREFLIGHT_BLOCKED", `expected PREFLIGHT_BLOCKED, got ${blocked.error?.code}`);
  const memoFinding = blocked.preflight?.findings.find((f) => f.code === "MEMO_REQUIRED");
  expect(memoFinding?.severity === "block", "MEMO_REQUIRED block finding");
  steps.blocked = {
    errorCode: blocked.error?.code,
    signature: blocked.signature, // empty: never sent
    findings: blocked.preflight?.findings.map((f) => `${f.severity}:${f.code}`),
    planLabels: blocked.plan?.instructions.map((ix) => ix.label) ?? null,
  };

  // 4. Forced → the validator rejects with Token-2022 NoMemo (custom 36).
  const forced = await transfer(conn, { ...base, force: true });
  expect(forced.error !== undefined, "forced send fails on chain");
  expect(
    forced.error?.custom?.code === NO_MEMO_CODE,
    `expected custom error ${NO_MEMO_CODE} (NoMemo), got ${JSON.stringify(forced.error?.custom ?? null)}`,
  );
  log(`forced send rejected: ${forced.error?.custom?.name} (${forced.error?.custom?.code})`);
  steps.forced = { errorCode: forced.error?.code, custom: forced.error?.custom, preflightOk: forced.preflight?.ok };

  // 5. With a memo → success.
  const sent = assertOk("transfer with memo", await transfer(conn, { ...base, memo: "solwallet example B" }));
  const labels = sent.plan?.instructions.map((ix) => ix.label) ?? [];
  expect(labels.indexOf("memo") === labels.indexOf("transferChecked") - 1, `memo precedes transferChecked (${labels.join(",")})`);
  steps.withMemo = { ...txRef(conn, sent.signature), planLabels: labels, preflightOk: sent.preflight?.ok };

  // 6. Decode it: full amount lands, no fee.
  const inspected = await inspectTransaction({ conn, signature: sent.signature });
  const move = inspected.movements.find((m) => m.instructionType === "transferChecked");
  expect(move?.balanceDelta === SEND_AMOUNT.toString(), `balanceDelta == ${SEND_AMOUNT}`);
  steps.inspect = {
    explorerUrl: inspected.explorerUrl,
    amount: move?.amount,
    fee: move?.fee,
    balanceDelta: move?.balanceDelta,
    destAccount: move?.destAccount,
    destMatchesDerivedAta: move?.destAccount === recipientAta,
  };
});
