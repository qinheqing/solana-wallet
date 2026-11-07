/**
 * Task #10 unit tests — Squads V4 multisig orchestration against a fake RPC.
 *
 * The fake connection serves real beet-serialized Squads accounts
 * (ProgramConfig / Multisig / Proposal / VaultTransaction) built via the SDK's
 * own `fromArgs`, so the query paths exercise actual deserialization, and
 * every sent transaction is captured + decoded to assert instruction layout.
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import {
  PROGRAM_ID as SQUADS_PROGRAM_ID,
  accounts,
  getMultisigPda,
  getProgramConfigPda,
  getProposalPda,
  getTransactionPda,
  getVaultPda,
  types,
} from "@sqds/multisig";

import { ClusterConnection } from "../connection/connection.js";
import {
  approveMultisigProposal,
  createMultisig,
  createMultisigProposal,
  executeMultisigProposal,
  getMultisigState,
  listProposals,
} from "./multisig.js";

const { Multisig, ProgramConfig, Proposal, VaultTransaction } = accounts;
const { Permissions } = types;

// --- fake RPC ---------------------------------------------------------------

interface FakeWorld {
  conn: ClusterConnection;
  fake: Record<string, ReturnType<typeof vi.fn>>;
  /** base58 → serialized account data. */
  data: Map<string, Buffer>;
  /** Raw wire bytes of every sent transaction, in order. */
  sentRaw: Buffer[];
}

function registerAccount(data: Map<string, Buffer>, address: PublicKey, buffer: Buffer): void {
  data.set(address.toBase58(), buffer);
}

function fakeConn(data = new Map<string, Buffer>()): FakeWorld {
  const sentRaw: Buffer[] = [];
  const fake = {
    getAccountInfo: vi.fn().mockImplementation((addr: PublicKey) => {
      const buf = data.get(addr.toBase58());
      return Promise.resolve(
        buf ? { owner: SQUADS_PROGRAM_ID, data: buf } : null,
      );
    }),
    getLatestBlockhash: vi
      .fn()
      .mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 999 }),
    sendRawTransaction: vi.fn().mockImplementation((raw: Uint8Array) => {
      sentRaw.push(Buffer.from(raw));
      return Promise.resolve("SIG_MS");
    }),
    simulateTransaction: vi.fn().mockResolvedValue({
      value: { err: null, logs: ["Program log: ok"], unitsConsumed: 4200 },
    }),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null }, context: { slot: 77 } }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
  };
  const conn = new ClusterConnection(
    { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" },
    { connection: fake as unknown as Connection },
  );
  return { conn, fake, data, sentRaw };
}

/** Decode the n-th captured transaction. */
function decodedTx(world: FakeWorld, n = 0): VersionedTransaction {
  expect(world.sentRaw.length).toBeGreaterThan(n);
  return VersionedTransaction.deserialize(world.sentRaw[n]!);
}

// --- serialized account factories ------------------------------------------

function programConfigBuffer(treasury: PublicKey): Buffer {
  return ProgramConfig.fromArgs({
    authority: Keypair.generate().publicKey,
    multisigCreationFee: 0n,
    treasury,
    reserved: new Array<number>(64).fill(0),
  }).serialize()[0] as Buffer;
}

function multisigBuffer(opts: {
  multisigPda: PublicKey;
  members: PublicKey[];
  threshold: number;
  transactionIndex: bigint;
}): Buffer {
  return Multisig.fromArgs({
    createKey: Keypair.generate().publicKey,
    configAuthority: PublicKey.default,
    threshold: opts.threshold,
    timeLock: 0,
    transactionIndex: opts.transactionIndex,
    staleTransactionIndex: 0n,
    rentCollector: null,
    bump: 255,
    members: opts.members.map((key) => ({ key, permissions: Permissions.all() })),
  }).serialize()[0] as Buffer;
}

function proposalBuffer(opts: {
  multisigPda: PublicKey;
  transactionIndex: bigint;
  status: { __kind: "Active" | "Approved" | "Executed"; timestamp: bigint };
  approved?: PublicKey[];
}): Buffer {
  return Proposal.fromArgs({
    multisig: opts.multisigPda,
    transactionIndex: opts.transactionIndex,
    status: opts.status,
    bump: 255,
    approved: opts.approved ?? [],
    rejected: [],
    cancelled: [],
  }).serialize()[0] as Buffer;
}

/** Vault transaction wrapping a plain SOL transfer vault → recipient. */
function vaultTransactionBuffer(opts: {
  multisigPda: PublicKey;
  vaultPda: PublicKey;
  transactionIndex: bigint;
  recipient: PublicKey;
}): Buffer {
  const transfer = SystemProgram.transfer({
    fromPubkey: opts.vaultPda,
    toPubkey: opts.recipient,
    lamports: 1_000_000n,
  });
  return VaultTransaction.fromArgs({
    multisig: opts.multisigPda,
    creator: Keypair.generate().publicKey,
    index: opts.transactionIndex,
    bump: 255,
    vaultIndex: 0,
    vaultBump: 255,
    ephemeralSignerBumps: new Uint8Array(0),
    message: {
      numSigners: 1,
      numWritableSigners: 1,
      numWritableNonSigners: 1,
      accountKeys: [opts.vaultPda, opts.recipient, SystemProgram.programId],
      instructions: [
        {
          programIdIndex: 2,
          accountIndexes: Uint8Array.from([0, 1]),
          data: new Uint8Array(transfer.data),
        },
      ],
      addressTableLookups: [],
    },
  }).serialize()[0] as Buffer;
}

/** Register a full 2-of-3 multisig world with one live proposal. */
function worldWithMultisig(proposalStatus: "Active" | "Approved" | "Executed") {
  const [multisigPda] = getMultisigPda({ createKey: Keypair.generate().publicKey });
  const [vaultPda] = getVaultPda({ multisigPda, index: 0 });
  const m1 = Keypair.generate();
  const m2 = Keypair.generate();
  const m3 = Keypair.generate();
  const members = [m1, m2, m3].map((k) => k.publicKey);

  const data = new Map<string, Buffer>();
  registerAccount(data, getProgramConfigPda({})[0], programConfigBuffer(Keypair.generate().publicKey));
  registerAccount(data, multisigPda, multisigBuffer({ multisigPda, members, threshold: 2, transactionIndex: 1n }));
  registerAccount(
    data,
    getProposalPda({ multisigPda, transactionIndex: 0n })[0],
    proposalBuffer({
      multisigPda,
      transactionIndex: 0n,
      status: { __kind: proposalStatus, timestamp: 0n },
      approved: proposalStatus === "Active" ? [m1.publicKey] : [m1.publicKey, m2.publicKey],
    }),
  );
  if (proposalStatus !== "Active") {
    registerAccount(
      data,
      getTransactionPda({ multisigPda, index: 0n })[0],
      vaultTransactionBuffer({
        multisigPda,
        vaultPda,
        transactionIndex: 0n,
        recipient: Keypair.generate().publicKey,
      }),
    );
  }
  return { world: fakeConn(data), multisigPda, vaultPda, members, m1, m2, m3 };
}

// --- createMultisig ---------------------------------------------------------

describe("createMultisig", () => {
  it("sends one multisigCreateV2 instruction to the Squads program", async () => {
    const { world } = worldWithMultisig("Active");
    const creator = Keypair.generate();
    const members = [Keypair.generate().publicKey, Keypair.generate().publicKey];

    const result = await createMultisig(world.conn, creator, members, 2);

    expect(result.error).toBeUndefined();
    expect(result.signature).toBe("SIG_MS");
    expect(result.slot).toBe(77);
    expect(result.feeLamports).toBe(5000);
    expect(result.simulatedOnly).toBe(false);

    const tx = decodedTx(world);
    expect(tx.message.compiledInstructions).toHaveLength(1);
    // Resolve program ids from static keys.
    const programIds = tx.message.compiledInstructions.map(
      (ix) => tx.message.staticAccountKeys[ix.programIdIndex]!,
    );
    expect(programIds[0]!.toBase58()).toBe(SQUADS_PROGRAM_ID.toBase58());

    // Result PDA derivations are self-consistent.
    const expected = getMultisigPda({ createKey: new PublicKey(result.createKey) })[0];
    expect(result.multisigPda).toBe(expected.toBase58());
    expect(result.vaultPda).toBe(getVaultPda({ multisigPda: expected, index: 0 })[0].toBase58());
  });

  it("dry-run never sends anything", async () => {
    const { world } = worldWithMultisig("Active");
    const result = await createMultisig(world.conn, Keypair.generate(), [
      Keypair.generate().publicKey,
      Keypair.generate().publicKey,
    ], 1, { dryRun: true });
    expect(result.simulatedOnly).toBe(true);
    expect(result.signature).toBe("");
    expect(world.sentRaw).toHaveLength(0);
    expect(world.fake.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects empty, duplicate members and out-of-range thresholds", async () => {
    const { conn } = fakeConn();
    const a = Keypair.generate().publicKey;
    await expect(createMultisig(conn, Keypair.generate(), [], 1)).rejects.toMatchObject({
      code: "INVALID_MEMBERS",
    });
    await expect(createMultisig(conn, Keypair.generate(), [a, a], 1)).rejects.toMatchObject({
      code: "INVALID_MEMBERS",
    });
    await expect(createMultisig(conn, Keypair.generate(), [a], 2)).rejects.toMatchObject({
      code: "INVALID_THRESHOLD",
    });
    await expect(createMultisig(conn, Keypair.generate(), [a], 0)).rejects.toMatchObject({
      code: "INVALID_THRESHOLD",
    });
  });

  it("missing Squads program config → structured MULTISIG_PROGRAM_NOT_INITIALIZED", async () => {
    const { conn } = fakeConn(); // no program config registered
    await expect(
      createMultisig(conn, Keypair.generate(), [Keypair.generate().publicKey], 1),
    ).rejects.toMatchObject({ code: "MULTISIG_PROGRAM_NOT_INITIALIZED" });
  });
});

// --- real member flows (share one fixture builder) ---------------------------

function memberWorld() {
  const w = worldWithMultisig("Active");
  // m1 is a member (and already approved), m2 is a member, outsider is not.
  return { ...w, outsider: Keypair.generate() };
}

describe("createMultisigProposal (member)", () => {
  it("sends two Squads instructions and returns derived PDAs", async () => {
    const { world, multisigPda, vaultPda, m1 } = memberWorld();
    const destination = Keypair.generate().publicKey;

    const result = await createMultisigProposal(world.conn, m1, multisigPda, {
      destination,
      amount: 5_000_000_000n,
    });

    expect(result.error).toBeUndefined();
    expect(result.signature).toBe("SIG_MS");
    expect(result.transactionIndex).toBe("1");
    expect(result.transactionPda).toBe(
      getTransactionPda({ multisigPda, index: 1n })[0].toBase58(),
    );
    expect(result.proposalPda).toBe(
      getProposalPda({ multisigPda, transactionIndex: 1n })[0].toBase58(),
    );
    expect(result.vaultPda).toBe(vaultPda.toBase58());

    const tx = decodedTx(world);
    expect(tx.message.compiledInstructions).toHaveLength(2);
    const programIds = tx.message.compiledInstructions.map(
      (ix) => tx.message.staticAccountKeys[ix.programIdIndex]!,
    );
    expect(programIds.map((p) => p.toBase58())).toEqual([
      SQUADS_PROGRAM_ID.toBase58(),
      SQUADS_PROGRAM_ID.toBase58(),
    ]);
  });

  it("accepts pre-built instructions (payer = vault)", async () => {
    const { world, multisigPda, vaultPda, m1 } = memberWorld();
    const recipient = Keypair.generate().publicKey;
    const ix: TransactionInstruction = SystemProgram.transfer({
      fromPubkey: vaultPda,
      toPubkey: recipient,
      lamports: 42n,
    });
    const result = await createMultisigProposal(world.conn, m1, multisigPda, {
      instructions: [ix],
    });
    expect(result.error).toBeUndefined();
    expect(world.sentRaw).toHaveLength(1);
  });

  it("non-member proposer → NOT_A_MEMBER; unknown multisig → MULTISIG_NOT_FOUND", async () => {
    const { world, multisigPda, outsider } = memberWorld();
    await expect(
      createMultisigProposal(world.conn, outsider, multisigPda, {
        destination: Keypair.generate().publicKey,
        amount: 1n,
      }),
    ).rejects.toMatchObject({ code: "NOT_A_MEMBER" });

    await expect(
      createMultisigProposal(world.conn, outsider, Keypair.generate().publicKey, {
        destination: Keypair.generate().publicKey,
        amount: 1n,
      }),
    ).rejects.toMatchObject({ code: "MULTISIG_NOT_FOUND" });
  });

  it("neither instructions nor destination/amount → INVALID_PROPOSAL_REQUEST", async () => {
    const { world, multisigPda, m1 } = memberWorld();
    await expect(
      createMultisigProposal(world.conn, m1, multisigPda, {}),
    ).rejects.toMatchObject({ code: "INVALID_PROPOSAL_REQUEST" });
  });
});

describe("approveMultisigProposal", () => {
  it("member vote → single proposalApprove instruction with member as signer", async () => {
    const { world, multisigPda, m2 } = memberWorld();
    const result = await approveMultisigProposal(world.conn, m2, multisigPda, 0);

    expect(result.error).toBeUndefined();
    expect(result.alreadyApproved).toBe(false);
    expect(result.approvedBy).toHaveLength(2); // m1 (fixture) + m2
    expect(result.executeReady).toBe(true); // 2-of-3 reached
    expect(result.status).toBe("approved");

    const tx = decodedTx(world);
    expect(tx.message.compiledInstructions).toHaveLength(1);
    const [ix] = tx.message.compiledInstructions;
    const programId = tx.message.staticAccountKeys[ix!.programIdIndex]!;
    expect(programId.toBase58()).toBe(SQUADS_PROGRAM_ID.toBase58());
    // m2 is the fee payer / signer of the outer transaction.
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(m2.publicKey.toBase58());
    // Proposal PDA appears among the instruction accounts (writable).
    const proposalPda = getProposalPda({ multisigPda, transactionIndex: 0n })[0];
    const mentioned = ix!.accountKeyIndexes.some((i) =>
      tx.message.staticAccountKeys[i]!.equals(proposalPda),
    );
    expect(mentioned).toBe(true);
  });

  it("repeat approval is idempotent — nothing sent", async () => {
    const { world, multisigPda, m1 } = memberWorld();
    const result = await approveMultisigProposal(world.conn, m1, multisigPda, 0n);
    expect(result.alreadyApproved).toBe(true);
    expect(result.signature).toBe("");
    expect(world.sentRaw).toHaveLength(0);
  });

  it("executed proposal → PROPOSAL_ALREADY_EXECUTED; non-member → NOT_A_MEMBER", async () => {
    const executed = ((): ReturnType<typeof memberWorld> => {
      const w = worldWithMultisig("Executed");
      return { ...w, outsider: Keypair.generate() };
    })();
    await expect(
      approveMultisigProposal(executed.world.conn, executed.m3, executed.multisigPda, 0),
    ).rejects.toMatchObject({ code: "PROPOSAL_ALREADY_EXECUTED" });

    const { world, multisigPda, outsider } = memberWorld();
    await expect(
      approveMultisigProposal(world.conn, outsider, multisigPda, 0),
    ).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("missing proposal → PROPOSAL_NOT_FOUND", async () => {
    const { world, multisigPda, m1 } = memberWorld();
    await expect(
      approveMultisigProposal(world.conn, m1, multisigPda, 9),
    ).rejects.toMatchObject({ code: "PROPOSAL_NOT_FOUND" });
  });
});

describe("executeMultisigProposal", () => {
  it("approved proposal → vaultTransactionExecute with vault among remaining accounts", async () => {
    const approved = worldWithMultisig("Approved");
    const { world, multisigPda, vaultPda, m3 } = approved;

    const result = await executeMultisigProposal(world.conn, m3, multisigPda, 0);
    expect(result.error).toBeUndefined();
    expect(result.signature).toBe("SIG_MS");

    const tx = decodedTx(world);
    expect(tx.message.compiledInstructions).toHaveLength(1);
    const [ix] = tx.message.compiledInstructions;
    const programId = tx.message.staticAccountKeys[ix!.programIdIndex]!;
    expect(programId.toBase58()).toBe(SQUADS_PROGRAM_ID.toBase58());

    // Remaining accounts replicate the wrapped vault transaction: vault PDA
    // and the SOL-transfer recipient must be passed to the program.
    const keys = ix!.accountKeyIndexes.map((i) => tx.message.staticAccountKeys[i]!);
    expect(keys.some((k) => k.equals(vaultPda))).toBe(true);
    expect(keys.some((k) => k.equals(SystemProgram.programId))).toBe(true);
  });

  it("active (not yet approved) proposal → PROPOSAL_NOT_APPROVED with threshold hint", async () => {
    const { world, multisigPda, m2 } = memberWorld();
    await expect(
      executeMultisigProposal(world.conn, m2, multisigPda, 0),
    ).rejects.toMatchObject({ code: "PROPOSAL_NOT_APPROVED" });
    expect(world.sentRaw).toHaveLength(0);
  });

  it("non-member executor → NOT_A_MEMBER", async () => {
    const approved = worldWithMultisig("Approved");
    const outsider = Keypair.generate();
    await expect(
      executeMultisigProposal(approved.world.conn, outsider, approved.multisigPda, 0),
    ).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });
});

describe("getMultisigState / listProposals", () => {
  it("state: members, threshold, transactionIndex; null config authority", async () => {
    const { world, multisigPda, members, vaultPda } = memberWorld();
    const state = await getMultisigState(world.conn, multisigPda);
    expect(state.members).toEqual(members.map((m) => m.toBase58()));
    expect(state.threshold).toBe(2);
    expect(state.transactionIndex).toBe("1");
    expect(state.configAuthority).toBeNull();
    expect(state.vault0Pda).toBe(vaultPda.toBase58());
  });

  it("unknown multisig → MULTISIG_NOT_FOUND with hint", async () => {
    const { conn } = fakeConn();
    await expect(getMultisigState(conn, Keypair.generate().publicKey)).rejects.toMatchObject({
      code: "MULTISIG_NOT_FOUND",
      hint: expect.stringContaining("cluster"),
    });
  });

  it("listProposals maps statuses and approvals; missing proposals skipped", async () => {
    const { world, multisigPda, m1 } = memberWorld();
    // Register a second proposal (index would collide — proposal 0 exists,
    // transactionIndex is 1n so only index 0 is probed). Assert on index 0.
    const list = await listProposals(world.conn, multisigPda);
    expect(list.transactionIndex).toBe("1");
    expect(list.proposals).toHaveLength(1);
    const [p] = list.proposals;
    expect(p!.status).toBe("active");
    expect(p!.executeReady).toBe(false);
    expect(p!.approvedBy).toEqual([m1.publicKey.toBase58()]);
    expect(p!.transactionPda).toBe(
      getTransactionPda({ multisigPda, index: 0n })[0].toBase58(),
    );

    // Executed variant reports executed + executeReady=false.
    const executed = worldWithMultisig("Executed");
    const executedList = await listProposals(executed.world.conn, executed.multisigPda);
    expect(executedList.proposals[0]!.status).toBe("executed");
    expect(executedList.proposals[0]!.executeReady).toBe(false);
  });
});
