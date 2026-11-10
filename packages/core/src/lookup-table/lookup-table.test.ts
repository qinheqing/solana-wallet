/**
 * Lookup-table lifecycle primitives — offline, fake connection.
 */
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { ClusterConnection } from "../connection/connection.js";
import {
  LOOKUP_TABLE_EXTEND_CHUNK,
  closeLookupTable,
  createLookupTable,
  deactivateLookupTable,
  extendLookupTable,
  inspectLookupTable,
} from "./lookup-table.js";

const authority = Keypair.generate();
const keys = (n: number) => Array.from({ length: n }, () => Keypair.generate().publicKey);

function fakeConn(opts: { sendErr?: boolean; table?: AddressLookupTableAccount } = {}) {
  const txs: VersionedTransaction[] = [];
  const fake = {
    getSlot: vi.fn().mockResolvedValue(1234),
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 99,
    }),
    sendRawTransaction: vi.fn().mockImplementation((raw: Uint8Array) => {
      txs.push(VersionedTransaction.deserialize(raw));
      return Promise.resolve(`SIG_${txs.length}`);
    }),
    simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: ["ok"], unitsConsumed: 1 } }),
    confirmTransaction: vi
      .fn()
      .mockResolvedValue(
        opts.sendErr
          ? { value: { err: { InstructionError: [0, { Custom: 0 }] } }, context: { slot: 7 } }
          : { value: { err: null }, context: { slot: 7 } },
      ),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
    getAddressLookupTable: vi.fn().mockResolvedValue({ context: { slot: 1 }, value: opts.table ?? null }),
  };
  const conn = new ClusterConnection(
    { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" },
    { connection: fake as unknown as Connection },
  );
  return { conn, fake, txs };
}

/** Instruction discriminants of the ALT program (u32 LE). */
const discriminants = (tx: VersionedTransaction) =>
  tx.message.compiledInstructions
    .filter((ci) => tx.message.staticAccountKeys[ci.programIdIndex]!.equals(AddressLookupTableProgram.programId))
    .map((ci) => Buffer.from(ci.data).readUInt32LE(0));
const CREATE = 0;
const EXTEND = 2;
const DEACTIVATE = 3;
const CLOSE = 4;

describe("createLookupTable", () => {
  it("derives the table from the finalized slot and seeds the first chunk in the create tx", async () => {
    const { conn, fake, txs } = fakeConn();
    const addrs = keys(25);
    const res = await createLookupTable(conn, authority, { addresses: addrs });
    expect(fake.getSlot).toHaveBeenCalledWith("finalized");
    const [, expected] = AddressLookupTableProgram.createLookupTable({
      authority: authority.publicKey,
      payer: authority.publicKey,
      recentSlot: 1234,
    });
    expect(res.table).toBe(expected.toBase58());
    expect(res.transactions.map((t) => t.step)).toEqual(["create+extend(20)", "extend(5)"]);
    expect(txs).toHaveLength(2);
    expect(discriminants(txs[0]!)).toEqual([CREATE, EXTEND]);
    expect(discriminants(txs[1]!)).toEqual([EXTEND]);
    expect(res.error).toBeUndefined();
    for (const tx of txs) expect(tx.serialize().length).toBeLessThanOrEqual(1232);
  });

  it("without addresses sends a bare create", async () => {
    const { conn, txs } = fakeConn();
    const res = await createLookupTable(conn, authority, { recentSlot: 5 });
    expect(res.transactions.map((t) => t.step)).toEqual(["create"]);
    expect(discriminants(txs[0]!)).toEqual([CREATE]);
  });

  it("dryRun simulates only the create transaction", async () => {
    const { conn, fake, txs } = fakeConn();
    const res = await createLookupTable(conn, authority, { addresses: keys(45), dryRun: true });
    expect(txs).toHaveLength(0);
    expect(fake.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(res.transactions).toHaveLength(1);
    expect(res.transactions[0]!.simulatedOnly).toBe(true);
    expect(res.table).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});

describe("extend / deactivate / close", () => {
  const table = Keypair.generate().publicKey;

  it("extends in chunks of LOOKUP_TABLE_EXTEND_CHUNK", async () => {
    const { conn, txs } = fakeConn();
    const res = await extendLookupTable(conn, authority, table, keys(45));
    expect(LOOKUP_TABLE_EXTEND_CHUNK).toBe(20);
    expect(res.transactions.map((t) => t.step)).toEqual(["extend(20)", "extend(20)", "extend(5)"]);
    expect(txs.every((tx) => discriminants(tx)[0] === EXTEND)).toBe(true);
  });

  it("rejects an empty address list", async () => {
    const { conn } = fakeConn();
    await expect(extendLookupTable(conn, authority, table, [])).rejects.toMatchObject({ code: "ALT_ADDRESSES_REQUIRED" });
  });

  it("deactivate and close send one instruction each; close defaults rent to the authority", async () => {
    const { conn, txs } = fakeConn();
    await deactivateLookupTable(conn, authority, table);
    await closeLookupTable(conn, authority, table);
    expect(discriminants(txs[0]!)).toEqual([DEACTIVATE]);
    expect(discriminants(txs[1]!)).toEqual([CLOSE]);
    const closeIx = txs[1]!.message.compiledInstructions[0]!;
    const recipient = txs[1]!.message.staticAccountKeys[closeIx.accountKeyIndexes[2]!]!;
    expect(recipient.equals(authority.publicKey)).toBe(true);
  });

  it("returns on-chain failures in-band and stops at the first one", async () => {
    const { conn, txs } = fakeConn({ sendErr: true });
    const res = await extendLookupTable(conn, authority, table, keys(30));
    expect(txs).toHaveLength(1);
    expect(res.transactions).toHaveLength(1);
    expect(res.error).toBeDefined();
  });
});

describe("inspectLookupTable", () => {
  it("decodes state", async () => {
    const addrs = keys(3);
    const account = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: {
        deactivationSlot: BigInt("18446744073709551615"),
        lastExtendedSlot: 77,
        lastExtendedSlotStartIndex: 1,
        authority: authority.publicKey,
        addresses: addrs,
      },
    });
    const { conn } = fakeConn({ table: account });
    const info = await inspectLookupTable(conn, account.key);
    expect(info).toEqual({
      address: account.key.toBase58(),
      authority: authority.publicKey.toBase58(),
      addresses: addrs.map((a) => a.toBase58()),
      active: true,
      deactivationSlot: null,
      lastExtendedSlot: 77,
      lastExtendedSlotStartIndex: 1,
    });
  });

  it("missing table → ALT_NOT_FOUND", async () => {
    const { conn } = fakeConn();
    await expect(inspectLookupTable(conn, new PublicKey(Keypair.generate().publicKey))).rejects.toMatchObject({
      code: "ALT_NOT_FOUND",
    });
  });
});
