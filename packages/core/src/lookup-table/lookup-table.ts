/**
 * Address lookup tables (ALT): lifecycle primitives (create / extend /
 * deactivate / close / inspect) plus `fetchLookupTables`, which resolves
 * table addresses into the accounts `compileToV0Message` needs.
 *
 * The signing wallet is both authority and payer. Every send goes through
 * the shared token send pipeline (dry run, mainnet guard, in-band errors).
 */
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  PublicKey,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";

import type { ClusterConnection } from "../connection/connection.js";
import { SolwalletError } from "../connection/errors.js";
import { signAndSendTokenTx, toPublicKey, type SendTokenOptions, type TokenTxResult } from "../token/internal.js";

/**
 * Addresses per extend instruction. 20 × 32 B keeps an extend transaction
 * (and the create transaction that carries the first chunk) well under the
 * 1232-byte packet limit.
 */
export const LOOKUP_TABLE_EXTEND_CHUNK = 20;

/** Slot value the runtime stores in `deactivationSlot` while a table is active. */
const ACTIVE_DEACTIVATION_SLOT = 2n ** 64n - 1n;

/** One transaction sent (or simulated) as part of a lookup-table operation. */
export interface LookupTableTx extends TokenTxResult {
  /** What the transaction did, e.g. "create+extend(20)" or "extend(5)". */
  step: string;
}

export interface LookupTableResult {
  /** Lookup table address. */
  table: string;
  /** Transactions in send order; stops at the first failure. */
  transactions: LookupTableTx[];
  /** First failure, mirrored from the failing transaction (absent on success). */
  error?: TokenTxResult["error"];
}

export interface CreateLookupTableOptions extends SendTokenOptions {
  /** Addresses to seed the table with (chunked, first chunk rides in the create tx). */
  addresses?: Array<string | PublicKey>;
  /** Slot used to derive the table address. Default: current finalized slot. */
  recentSlot?: number | bigint;
}

function toKeys(addresses: ReadonlyArray<string | PublicKey>): PublicKey[] {
  return addresses.map((a) => toPublicKey(a));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function sendSteps(
  conn: ClusterConnection,
  authority: Keypair,
  table: PublicKey,
  steps: Array<{ step: string; ixs: TransactionInstruction[] }>,
  opts: SendTokenOptions,
): Promise<LookupTableResult> {
  const transactions: LookupTableTx[] = [];
  for (const { step, ixs } of steps) {
    const res = await signAndSendTokenTx(conn, authority, ixs, opts);
    transactions.push({ step, ...res });
    if (res.error) return { table: table.toBase58(), transactions, error: res.error };
  }
  return { table: table.toBase58(), transactions };
}

function extendSteps(
  authority: PublicKey,
  table: PublicKey,
  addresses: PublicKey[],
): Array<{ step: string; ixs: TransactionInstruction[] }> {
  return chunk(addresses, LOOKUP_TABLE_EXTEND_CHUNK).map((part) => ({
    step: `extend(${part.length})`,
    ixs: [
      AddressLookupTableProgram.extendLookupTable({
        lookupTable: table,
        authority,
        payer: authority,
        addresses: part,
      }),
    ],
  }));
}

/**
 * Create a lookup table owned by `authority` (also the payer), optionally
 * seeded with addresses. On dryRun only the create transaction is
 * simulated: extends of a table that does not exist yet cannot be simulated.
 */
export async function createLookupTable(
  conn: ClusterConnection,
  authority: Keypair,
  opts: CreateLookupTableOptions = {},
): Promise<LookupTableResult> {
  const recentSlot = opts.recentSlot ?? (await conn.connection.getSlot("finalized"));
  const [createIx, table] = AddressLookupTableProgram.createLookupTable({
    authority: authority.publicKey,
    payer: authority.publicKey,
    recentSlot,
  });
  const addresses = toKeys(opts.addresses ?? []);
  const [first = [], ...rest] = chunk(addresses, LOOKUP_TABLE_EXTEND_CHUNK);
  const createStep = {
    step: first.length > 0 ? `create+extend(${first.length})` : "create",
    ixs: [
      createIx,
      ...(first.length > 0
        ? [
            AddressLookupTableProgram.extendLookupTable({
              lookupTable: table,
              authority: authority.publicKey,
              payer: authority.publicKey,
              addresses: first,
            }),
          ]
        : []),
    ],
  };
  const steps = opts.dryRun
    ? [createStep]
    : [createStep, ...extendSteps(authority.publicKey, table, rest.flat())];
  return sendSteps(conn, authority, table, steps, opts);
}

/** Append addresses to a table, LOOKUP_TABLE_EXTEND_CHUNK per transaction. */
export async function extendLookupTable(
  conn: ClusterConnection,
  authority: Keypair,
  table: string | PublicKey,
  addresses: Array<string | PublicKey>,
  opts: SendTokenOptions = {},
): Promise<LookupTableResult> {
  const tableKey = toPublicKey(table);
  if (addresses.length === 0) {
    throw new SolwalletError("No addresses to add to the lookup table.", {
      code: "ALT_ADDRESSES_REQUIRED",
      hint: "Pass at least one address.",
    });
  }
  return sendSteps(conn, authority, tableKey, extendSteps(authority.publicKey, tableKey, toKeys(addresses)), opts);
}

/** Deactivate a table (step 1 of closing; it stays usable until the cooldown ends). */
export async function deactivateLookupTable(
  conn: ClusterConnection,
  authority: Keypair,
  table: string | PublicKey,
  opts: SendTokenOptions = {},
): Promise<LookupTableResult> {
  const tableKey = toPublicKey(table);
  return sendSteps(
    conn,
    authority,
    tableKey,
    [
      {
        step: "deactivate",
        ixs: [AddressLookupTableProgram.deactivateLookupTable({ lookupTable: tableKey, authority: authority.publicKey })],
      },
    ],
    opts,
  );
}

/**
 * Close a deactivated table and send its rent to `recipient` (default: the
 * authority). Fails on chain until the deactivation cooldown (~513 slots)
 * has elapsed — that failure comes back in-band as `error`.
 */
export async function closeLookupTable(
  conn: ClusterConnection,
  authority: Keypair,
  table: string | PublicKey,
  opts: SendTokenOptions & { recipient?: string | PublicKey } = {},
): Promise<LookupTableResult> {
  const tableKey = toPublicKey(table);
  const recipient = opts.recipient ? toPublicKey(opts.recipient) : authority.publicKey;
  return sendSteps(
    conn,
    authority,
    tableKey,
    [
      {
        step: "close",
        ixs: [
          AddressLookupTableProgram.closeLookupTable({
            lookupTable: tableKey,
            authority: authority.publicKey,
            recipient,
          }),
        ],
      },
    ],
    opts,
  );
}

export interface LookupTableInspection {
  address: string;
  /** null once the authority was removed (frozen table). */
  authority: string | null;
  addresses: string[];
  /** false once deactivated. */
  active: boolean;
  /** Slot of deactivation; null while active. */
  deactivationSlot: string | null;
  /** Addresses added in this slot become usable from the next slot. */
  lastExtendedSlot: number;
  lastExtendedSlotStartIndex: number;
}

/** Fetch and decode one table; throws ALT_NOT_FOUND when absent. */
export async function fetchLookupTable(
  conn: ClusterConnection,
  table: string | PublicKey,
): Promise<AddressLookupTableAccount> {
  const key = toPublicKey(table);
  const res = await conn.connection.getAddressLookupTable(key);
  if (!res.value) {
    throw new SolwalletError(`No address lookup table at ${key.toBase58()}.`, {
      code: "ALT_NOT_FOUND",
      hint: "Check the cluster and the table address; create one with createLookupTable / create_lookup_table.",
    });
  }
  return res.value;
}

/**
 * Resolve tables for v0 compilation. Deactivated tables are rejected
 * (ALT_DEACTIVATED): the runtime refuses lookups through them once the
 * cooldown ends, so a plan built on one is not reliably sendable.
 */
export async function fetchLookupTables(
  conn: ClusterConnection,
  tables: ReadonlyArray<string | PublicKey>,
): Promise<AddressLookupTableAccount[]> {
  const accounts = await Promise.all(tables.map((t) => fetchLookupTable(conn, t)));
  for (const a of accounts) {
    if (!a.isActive()) {
      throw new SolwalletError(`Address lookup table ${a.key.toBase58()} is deactivated.`, {
        code: "ALT_DEACTIVATED",
        hint: "Use an active table, or create a new one.",
      });
    }
  }
  return accounts;
}

/** Decode a table's state for display. */
export async function inspectLookupTable(
  conn: ClusterConnection,
  table: string | PublicKey,
): Promise<LookupTableInspection> {
  const account = await fetchLookupTable(conn, table);
  const s = account.state;
  const deactivation = BigInt(s.deactivationSlot);
  return {
    address: account.key.toBase58(),
    authority: s.authority?.toBase58() ?? null,
    addresses: s.addresses.map((a) => a.toBase58()),
    active: account.isActive(),
    deactivationSlot: deactivation === ACTIVE_DEACTIVATION_SLOT ? null : deactivation.toString(),
    lastExtendedSlot: s.lastExtendedSlot,
    lastExtendedSlotStartIndex: s.lastExtendedSlotStartIndex,
  };
}

/** Re-exported for callers building their own messages. */
export { AddressLookupTableAccount };
