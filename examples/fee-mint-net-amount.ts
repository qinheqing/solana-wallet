/**
 * Example A — net amount received through a Token-2022 transfer-fee mint.
 *
 *   create (preset transfer-fee, 100 bps) + mintTo
 *   → buildTransferPlan  (4-instruction "standard shape")
 *   → preflightTransfer  (TRANSFER_FEE: expectedFee / net)
 *   → transfer
 *   → inspectTransaction (amount − fee == balanceDelta)
 *   → inspectTokenAccount (fee withheld on the recipient's ATA)
 *
 * Run: pnpm example examples/fee-mint-net-amount.ts
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  buildTransferPlan,
  createFromPreset,
  deriveTokenAddresses,
  inspectTokenAccount,
  inspectTransaction,
  preflightTransfer,
  transfer,
  type BuildTransferOptions,
} from "@solwallet/core";

import { assertOk, connect, displayAmount, ensureFunded, expect, loadPayer, log, runExample, short, txRef } from "./lib.js";

const DECIMALS = 6;
const FEE_BPS = 100; // 1 %
const MAX_FEE = 1_000_000n; // 1 token
const MINT_AMOUNT = 10_000_000n; // 10 tokens to the payer
const SEND_AMOUNT = 1_000_000n; // 1 token to the recipient

await runExample("fee-mint-net-amount", async (steps) => {
  const conn = connect();
  const payer = await loadPayer();
  await ensureFunded(conn, payer, "payer");
  const recipient = Keypair.generate(); // only needs an address; the payer funds its ATA

  // 1. Mint with a 1 % transfer fee, initial supply to the payer.
  const created = assertOk(
    "createFromPreset",
    await createFromPreset(conn, payer, "transfer-fee", {
      decimals: DECIMALS,
      extensions: { transferFeeConfig: { transferFeeBasisPoints: FEE_BPS, maximumFee: MAX_FEE } },
      mintTo: { owner: payer.publicKey, amount: MINT_AMOUNT },
    }),
  );
  log(`mint ${short(created.mint)} created (${created.extensions.join(", ")})`);
  steps.create = {
    mint: created.mint,
    preset: created.preset,
    extensions: created.extensions,
    ...txRef(conn, created.signature),
    mintTo: created.mintTo
      ? { amount: created.mintTo.amount, amountDisplay: displayAmount(created.mintTo.amount, DECIMALS), ...txRef(conn, created.mintTo.signature) }
      : null,
  };

  // 2. Build only: compute budget + always-idempotent ATA + transferChecked.
  const opts: BuildTransferOptions = {
    payer: payer.publicKey,
    destination: recipient.publicKey,
    mint: new PublicKey(created.mint),
    amount: SEND_AMOUNT,
    decimals: DECIMALS,
    computeBudget: { unitLimit: 200_000, unitPrice: 1 },
    ataMode: "always-idempotent",
  };

  const { plan } = await buildTransferPlan(conn, opts);
  const labels = plan.instructions.map((ix) => ix.label);
  expect(
    labels.join(",") ===
      "setComputeUnitLimit,setComputeUnitPrice,createAssociatedTokenAccountIdempotent,transferChecked",
    `standard 4-instruction shape, got ${labels.join(",")}`,
  );
  steps.build = { labels, estimatedBytes: plan.estimatedBytes, signers: plan.signers, messageHexBytes: plan.messageHex.length / 2 };

  // 3. Preflight: fee tier for the current epoch, expected fee and net.
  const preflight = await preflightTransfer(conn, opts);
  const feeFinding = preflight.findings.find((f) => f.code === "TRANSFER_FEE");
  expect(preflight.ok, "preflight ok");
  expect(feeFinding !== undefined, "TRANSFER_FEE finding present");
  steps.preflight = { ok: preflight.ok, codes: preflight.findings.map((f) => f.code), transferFee: feeFinding?.data ?? null };

  // 4. Send with the same knobs.
  const sent = assertOk(
    "transfer",
    await transfer(conn, {
      from: payer,
      destination: recipient.publicKey,
      mint: created.mint,
      amount: SEND_AMOUNT,
      decimals: DECIMALS,
      computeBudget: opts.computeBudget,
      ataMode: opts.ataMode,
    }),
  );
  log(`transfer ${sent.signature}`);
  steps.transfer = { ...txRef(conn, sent.signature), feeLamports: sent.feeLamports, destinationAtaCreated: sent.destinationAtaCreated };

  // 5. Inspect: declared amount vs fee vs destination balance delta.
  const inspected = await inspectTransaction({ conn, signature: sent.signature });
  const move = inspected.movements.find((m) => m.instructionType === "transferChecked");
  expect(move !== undefined, "transferChecked movement decoded");
  const amount = BigInt(move!.amount ?? "0");
  const fee = BigInt(move!.fee?.amount ?? "0");
  const delta = BigInt(move!.balanceDelta ?? "0");
  const consistent = amount - fee === delta;
  expect(consistent, `amount(${amount}) − fee(${fee}) == balanceDelta(${delta})`);
  expect(feeFinding?.data?.expectedFee === fee.toString(), "preflight expectedFee matches on-chain fee");
  steps.inspect = {
    explorerUrl: inspected.explorerUrl,
    instructionType: move!.instructionType,
    program: move!.program,
    amount: amount.toString(),
    amountDisplay: displayAmount(amount, DECIMALS),
    fee: move!.fee,
    feeDisplay: displayAmount(fee, DECIMALS),
    balanceDelta: delta.toString(),
    balanceDeltaDisplay: displayAmount(delta, DECIMALS),
    consistent,
  };

  // 6. The fee sits withheld on the recipient's ATA until the authority withdraws it.
  const ata = deriveTokenAddresses({ owner: recipient.publicKey, mint: created.mint }).token2022.address;
  const account = await inspectTokenAccount(conn, ata);
  const withheld = account.extensions.find((e) => e.type === "TransferFeeAmount");
  steps.recipientAccount = {
    address: ata,
    amount: account.amount,
    amountDisplay: displayAmount(account.amount, DECIMALS),
    withheld: withheld && "withheldAmount" in withheld ? withheld.withheldAmount : null,
    withheldDisplay: displayAmount(withheld && "withheldAmount" in withheld ? withheld.withheldAmount : null, DECIMALS),
    dataLength: account.dataLength,
  };
});
