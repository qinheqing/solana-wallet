/**
 * Example C — PermanentDelegate forced transfer, plus the ordinary
 * approve-delegate variant for contrast.
 *
 *   Part 1 (permanent-delegate preset, delegate = payer):
 *     mintTo victim → preflight (PERMANENT_DELEGATE_TRANSFER)
 *     → transfer { from: payer, sourceOwner: victim, authority: payer }
 *     → inspectTransaction: authority ≠ sourceOwner, victim never signed
 *   Part 2 (plain-2022 mint):
 *     mintTo victim → approveDelegate(victim → payer, 0.5)
 *     → preflight 1 token  → INSUFFICIENT_DELEGATED_AMOUNT (block)
 *     → transfer 0.5 token → DELEGATE_TRANSFER (info), success
 *
 * Run: pnpm example examples/permanent-delegate-transfer.ts
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  approveDelegate,
  createFromPreset,
  inspectMint,
  inspectTransaction,
  preflightTransfer,
  transfer,
} from "@solwallet/core";

import { assertOk, connect, ensureFunded, expect, loadPayer, log, runExample, short, txRef } from "./lib.js";

const DECIMALS = 6;
const MINT_AMOUNT = 3_000_000n; // 3 tokens to the victim
const TAKE_AMOUNT = 1_000_000n; // 1 token moved by the delegate
const ALLOWANCE = 500_000n; // 0.5 token approved in part 2

await runExample("permanent-delegate-transfer", async (steps) => {
  const conn = connect();
  const payer = await loadPayer(); // also the (permanent) delegate
  await ensureFunded(conn, payer, "payer/delegate");
  const victim = Keypair.generate();
  const receiver = Keypair.generate();
  await ensureFunded(conn, victim, "victim"); // signs the approve in part 2

  // ---- Part 1: PermanentDelegate ------------------------------------------
  const created = assertOk(
    "createFromPreset(permanent-delegate)",
    await createFromPreset(conn, payer, "permanent-delegate", {
      decimals: DECIMALS,
      mintTo: { owner: victim.publicKey, amount: MINT_AMOUNT },
    }),
  );
  const mintInfo = await inspectMint(conn, created.mint);
  const pd = mintInfo.extensions.find((e) => e.type === "PermanentDelegate");
  expect(pd !== undefined && "delegate" in pd && pd.delegate === payer.publicKey.toBase58(), "PermanentDelegate == payer");
  log(`mint ${short(created.mint)} permanent delegate ${short(payer.publicKey)}; victim ${short(victim.publicKey)} holds ${MINT_AMOUNT}`);
  steps.permanentMint = { mint: created.mint, permanentDelegate: pd, ...txRef(conn, created.signature) };

  const forcedOpts = {
    payer: payer.publicKey,
    destination: receiver.publicKey,
    mint: new PublicKey(created.mint),
    amount: TAKE_AMOUNT,
    decimals: DECIMALS,
    sourceOwner: victim.publicKey,
    authority: payer.publicKey,
  };
  const pre = await preflightTransfer(conn, forcedOpts);
  expect(pre.ok, "preflight ok for permanent delegate");
  expect(pre.findings.some((f) => f.code === "PERMANENT_DELEGATE_TRANSFER"), "PERMANENT_DELEGATE_TRANSFER finding");
  steps.permanentPreflight = { ok: pre.ok, codes: pre.findings.map((f) => f.code) };

  const taken = assertOk(
    "permanent delegate transfer",
    await transfer(conn, {
      from: payer,
      sourceOwner: victim.publicKey,
      authority: payer.publicKey,
      destination: receiver.publicKey,
      mint: created.mint,
      amount: TAKE_AMOUNT,
      decimals: DECIMALS,
    }),
  );
  expect(!taken.plan!.signers.includes(victim.publicKey.toBase58()), "victim is not a signer");

  const inspected = await inspectTransaction({ conn, signature: taken.signature });
  const move = inspected.movements.find((m) => m.instructionType === "transferChecked");
  expect(move !== undefined, "movement decoded");
  expect(move!.authority !== move!.sourceOwner, "authority ≠ sourceOwner (forced transfer evidence)");
  expect(move!.authority === payer.publicKey.toBase58() && move!.sourceOwner === victim.publicKey.toBase58(), "authority is payer, source owner is victim");
  steps.permanentTransfer = {
    ...txRef(conn, taken.signature),
    signers: taken.plan?.signers,
    authority: move!.authority,
    sourceOwner: move!.sourceOwner,
    destOwner: move!.destOwner,
    balanceDelta: move!.balanceDelta,
  };

  // ---- Part 2: ordinary delegate (needs the owner's approval) --------------
  const plain = assertOk(
    "createFromPreset(plain-2022)",
    await createFromPreset(conn, payer, "plain-2022", {
      decimals: DECIMALS,
      mintTo: { owner: victim.publicKey, amount: MINT_AMOUNT },
    }),
  );
  const approved = assertOk(
    "approveDelegate",
    await approveDelegate(conn, { owner: victim, mint: plain.mint, delegate: payer.publicKey, amount: ALLOWANCE, decimals: DECIMALS }),
  );
  steps.delegateApprove = { mint: plain.mint, tokenAccount: approved.tokenAccount, allowance: ALLOWANCE.toString(), ...txRef(conn, approved.signature) };

  const tooMuch = await preflightTransfer(conn, { ...forcedOpts, mint: new PublicKey(plain.mint), amount: TAKE_AMOUNT });
  expect(!tooMuch.ok && tooMuch.findings.some((f) => f.code === "INSUFFICIENT_DELEGATED_AMOUNT"), "1 token > 0.5 allowance is blocked");
  steps.delegateOverAllowance = { ok: tooMuch.ok, codes: tooMuch.findings.map((f) => f.code) };

  const withinAllowance = assertOk(
    "delegate transfer",
    await transfer(conn, {
      from: payer,
      sourceOwner: victim.publicKey,
      authority: payer.publicKey,
      destination: receiver.publicKey,
      mint: plain.mint,
      amount: ALLOWANCE,
      decimals: DECIMALS,
    }),
  );
  expect(withinAllowance.preflight?.findings.some((f) => f.code === "DELEGATE_TRANSFER") === true, "DELEGATE_TRANSFER finding");
  steps.delegateTransfer = { ...txRef(conn, withinAllowance.signature), codes: withinAllowance.preflight?.findings.map((f) => f.code) };
});
