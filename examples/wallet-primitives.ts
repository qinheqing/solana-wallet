/**
 * Example D — account & transaction primitives, end to end on a live cluster:
 *
 *   1. createTokenAccount: a NON-ATA token account (Token-2022, sized for
 *      the mint's extensions) owned by a fresh holder
 *   2. mintTokens into that account (destinationAccount), transfer out of it
 *      (sourceTokenAccount) and into another one (destinationTokenAccount)
 *   3. burnTokens by the PermanentDelegate from another holder's account
 *      (sourceAccount; the holder never signs), BurnChecked
 *   4. createLookupTable seeded with the receiver's account + mint, then a
 *      v0 transfer compiled against it (plan.addressTableLookups non-empty)
 *   5. inspectLookupTable, deactivateLookupTable
 *
 * Run: pnpm example examples/wallet-primitives.ts
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  burnTokens,
  createFromPreset,
  createLookupTable,
  createTokenAccount,
  deactivateLookupTable,
  inspectLookupTable,
  inspectTokenAccount,
  mintTokens,
  transfer,
} from "@sol-wallet/core";

import { assertOk, connect, ensureFunded, expect, loadPayer, log, runExample, short, txRef } from "./lib.js";

const DECIMALS = 6;

await runExample("wallet-primitives", async (steps) => {
  const conn = connect();
  const payer = await loadPayer(); // mint authority + permanent delegate + ALT authority
  await ensureFunded(conn, payer, "payer");
  const holder = Keypair.generate();
  await ensureFunded(conn, holder, "holder"); // signs the transfer out of its account

  // ---- 1. non-ATA token accounts -------------------------------------------
  const created = assertOk(
    "createFromPreset(permanent-delegate)",
    await createFromPreset(conn, payer, "permanent-delegate", { decimals: DECIMALS }),
  );
  const mint = new PublicKey(created.mint);
  const holderAcct = assertOk(
    "createTokenAccount(holder)",
    await createTokenAccount(conn, payer, { mint, owner: holder.publicKey }),
  );
  const sinkAcct = assertOk("createTokenAccount(sink)", await createTokenAccount(conn, payer, { mint }));
  log(`mint ${short(mint)}; holder account ${short(holderAcct.address)}; sink account ${short(sinkAcct.address)}`);
  const inspected = await inspectTokenAccount(conn, holderAcct.address);
  expect(inspected.owner === holder.publicKey.toBase58(), "holder account owned by holder");
  expect(inspected.dataLength === holderAcct.space, "allocated space matches");
  steps.tokenAccounts = {
    mint: created.mint,
    holder: { address: holderAcct.address, space: holderAcct.space, ...txRef(conn, holderAcct.signature) },
    sink: { address: sinkAcct.address, ...txRef(conn, sinkAcct.signature) },
  };

  // ---- 2. mint into / transfer between explicit accounts --------------------
  assertOk(
    "mintTokens(destinationAccount)",
    await mintTokens(conn, payer, mint, null, 5_000_000n, { destinationAccount: holderAcct.address }),
  );
  const moved = assertOk(
    "transfer(sourceTokenAccount → destinationTokenAccount)",
    await transfer(conn, {
      from: holder,
      sourceTokenAccount: holderAcct.address,
      destinationTokenAccount: sinkAcct.address,
      mint,
      amount: 1_000_000n,
      decimals: DECIMALS,
    }),
  );
  expect(moved.plan?.instructions.length === 1, "no ATA creation instruction");
  const afterMove = await inspectTokenAccount(conn, sinkAcct.address);
  expect(afterMove.amount === "1000000", "sink received 1 token");
  steps.explicitTransfer = { ...txRef(conn, moved.signature), sinkAmount: afterMove.amount };

  // ---- 3. permanent delegate burns from the holder's account ----------------
  const burned = assertOk(
    "burnTokens(sourceAccount, permanent delegate)",
    await burnTokens(conn, payer, mint, 2_000_000n, { sourceAccount: holderAcct.address }),
  );
  const afterBurn = await inspectTokenAccount(conn, holderAcct.address);
  expect(afterBurn.amount === "2000000", "holder 5 − 1 − 2 = 2 tokens");
  steps.delegateBurn = { ...txRef(conn, burned.signature), holderAmount: afterBurn.amount };

  // ---- 4. lookup table + v0 transfer through it ------------------------------
  const alt = await createLookupTable(conn, payer, { addresses: [new PublicKey(sinkAcct.address), mint] });
  assertOk("createLookupTable", alt);
  log(`lookup table ${short(alt.table)}; waiting one slot before use`);
  const extendedAt = await conn.connection.getSlot("confirmed");
  while ((await conn.connection.getSlot("confirmed")) <= extendedAt) {
    await new Promise((r) => setTimeout(r, 400));
  }
  const viaAlt = assertOk(
    "transfer(lookupTables)",
    await transfer(conn, {
      from: holder,
      sourceTokenAccount: holderAcct.address,
      destinationTokenAccount: sinkAcct.address,
      mint,
      amount: 500_000n,
      decimals: DECIMALS,
      lookupTables: [alt.table],
    }),
  );
  expect((viaAlt.plan?.addressTableLookups.length ?? 0) === 1, "plan references the lookup table");
  const tx = await conn.connection.getTransaction(viaAlt.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  expect(tx?.version === 0, "landed as v0");
  expect((tx?.transaction.message.addressTableLookups.length ?? 0) === 1, "on-chain message uses the table");
  steps.lookupTable = {
    table: alt.table,
    createSteps: alt.transactions.map((t) => ({ step: t.step, signature: t.signature })),
    transfer: { ...txRef(conn, viaAlt.signature), addressTableLookups: viaAlt.plan?.addressTableLookups },
  };

  // ---- 5. inspect + deactivate ------------------------------------------------
  const info = await inspectLookupTable(conn, alt.table);
  expect(info.active && info.addresses.length === 2, "table active with 2 addresses");
  assertOk("deactivateLookupTable", await deactivateLookupTable(conn, payer, alt.table));
  const after = await inspectLookupTable(conn, alt.table);
  expect(!after.active || after.deactivationSlot !== null, "table deactivating");
  steps.lookupTableLifecycle = { before: { active: info.active, count: info.addresses.length }, deactivationSlot: after.deactivationSlot };
});
