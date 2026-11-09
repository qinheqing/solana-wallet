/**
 * Squads V4 multisig orchestration (task #10 / F6).
 *
 * Wraps the low-level `@sqds/multisig` instruction builders so every on-chain
 * action flows through our own ClusterConnection pipeline (dryRun +
 * sendWithRetry + mainnet guard). The SDK's high-level `rpc.*` helpers send
 * transactions themselves, which would bypass that pipeline — so we use the
 * `instructions.*` layer exclusively.
 *
 * Errors follow the SolwalletError {code, hint} taxonomy:
 *  - MULTISIG_NOT_FOUND  — unknown multisig address (wrong cluster / typo)
 *  - NOT_A_MEMBER        — signer is not in the member set (or lacks permission)
 *  - PROPOSAL_*          — proposal state machine violations
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  PROGRAM_ID as SQUADS_PROGRAM_ID,
  accounts,
  getMultisigPda,
  getProgramConfigPda,
  getProposalPda,
  getTransactionPda,
  getVaultPda,
  instructions,
  types,
  utils,
} from "@sqds/multisig";

import type { ClusterConnection, ConfirmPolicy } from "../connection/connection.js";
import { SolwalletError } from "../connection/errors.js";
import type { ParsedProgramError } from "../utils/parse-error.js";
import { parseTransactionError } from "../utils/parse-error.js";
import { describeVaultMessage, type ProposalAction } from "./describe.js";
import { dryRun } from "../transfer/dryrun.js";

const { Multisig, ProgramConfig, Proposal } = accounts;
const { Permissions } = types;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The multisig account does not exist at the given address. */
export class MultisigNotFoundError extends SolwalletError {
  constructor(multisigPda: PublicKey) {
    super(`No Squads V4 multisig found at ${multisigPda.toBase58()}.`, {
      code: "MULTISIG_NOT_FOUND",
      hint: "Check the multisigPda address and that you are on the cluster where it was created (devnet/mainnet have separate states). Use getMultisigState to inspect.",
    });
  }
}

/** The signer is not a member of the multisig (or lacks the needed permission). */
export class NotAMemberError extends SolwalletError {
  constructor(signer: PublicKey, multisigPda: PublicKey) {
    super(`${signer.toBase58()} is not a member of multisig ${multisigPda.toBase58()}.`, {
      code: "NOT_A_MEMBER",
      hint: "Only multisig members can perform this action. Load a member wallet (list_wallets) or ask an existing member to run it.",
    });
  }
}

/** members array is empty or contains duplicates. */
export class InvalidMembersError extends SolwalletError {
  constructor(reason: string) {
    super(`Invalid multisig members: ${reason}`, {
      code: "INVALID_MEMBERS",
      hint: "Provide 1+ distinct member public keys; duplicates are rejected because they silently weaken M-of-N semantics.",
    });
  }
}

/** threshold outside [1, members.length]. */
export class InvalidThresholdError extends SolwalletError {
  constructor(threshold: number, memberCount: number) {
    super(`threshold ${threshold} is invalid for ${memberCount} member(s): need 1 <= M <= N.`, {
      code: "INVALID_THRESHOLD",
      hint: "Pick M between 1 and the number of members, e.g. 2-of-3 → threshold=2.",
    });
  }
}

/** No proposal account exists for the given transaction index. */
export class ProposalNotFoundError extends SolwalletError {
  constructor(multisigPda: PublicKey, transactionIndex: bigint) {
    super(
      `No proposal #${transactionIndex} on multisig ${multisigPda.toBase58()}.`,
      {
        code: "PROPOSAL_NOT_FOUND",
        hint: "The transaction was created without a proposal (or never created). Use listProposals to see existing indexes.",
      },
    );
  }
}

/** Proposal exists but is in a state that cannot be approved. */
export class ProposalNotActiveError extends SolwalletError {
  constructor(status: string) {
    super(`Proposal status is "${status}" — approving is only possible while it is active.`, {
      code: "PROPOSAL_NOT_ACTIVE",
      hint: "Draft proposals must be activated first; rejected/cancelled/executed proposals are final.",
    });
  }
}

/** Proposal reached quorum already but then left the approved state. */
export class ProposalNotApprovedError extends SolwalletError {
  constructor(approved: number, threshold: number) {
    super(
      `Proposal is not approved yet (${approved}/${threshold} approvals).`,
      {
        code: "PROPOSAL_NOT_APPROVED",
        hint: `Collect ${threshold - approved} more approval(s) via approveMultisigProposal before executing.`,
      },
    );
  }
}

/** Proposal was already executed — idempotent rejection. */
export class ProposalAlreadyExecutedError extends SolwalletError {
  constructor(transactionIndex: bigint) {
    super(`Proposal #${transactionIndex} was already executed.`, {
      code: "PROPOSAL_ALREADY_EXECUTED",
      hint: "Check its signature in the earlier execution result; create a new proposal for further actions.",
    });
  }
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type ProposalStatusName =
  | "draft"
  | "active"
  | "rejected"
  | "approved"
  | "executing"
  | "executed"
  | "cancelled";

export interface MultisigSendOptions {
  dryRun?: boolean;
  allowMainnet?: boolean;
  policy?: Partial<ConfirmPolicy>;
}

/** Fields shared by every multisig send result (mirrors TransferResult). */
export interface MultisigTxResult {
  signature: string;
  slot: number;
  feeLamports: number;
  simulatedOnly: boolean;
  logs?: string[];
  unitsConsumed?: number;
  error?: ParsedProgramError;
}

// ---------------------------------------------------------------------------
// Account helpers
// ---------------------------------------------------------------------------

async function fetchMultisig(
  conn: ClusterConnection,
  multisigPda: PublicKey,
): Promise<accounts.Multisig> {
  const info = await conn.connection.getAccountInfo(multisigPda);
  if (!info) throw new MultisigNotFoundError(multisigPda);
  try {
    return Multisig.fromAccountInfo(info)[0];
  } catch (cause) {
    throw new SolwalletError(
      `Account at ${multisigPda.toBase58()} is not a Squads V4 multisig account.`,
      {
        code: "MULTISIG_NOT_FOUND",
        hint: "The address exists but holds different data — verify it is a Squads V4 multisig PDA.",
        cause,
      },
    );
  }
}

async function fetchProposal(
  conn: ClusterConnection,
  multisigPda: PublicKey,
  transactionIndex: bigint,
): Promise<accounts.Proposal> {
  const [proposalPda] = getProposalPda({ multisigPda, transactionIndex });
  const info = await conn.connection.getAccountInfo(proposalPda);
  if (!info) throw new ProposalNotFoundError(multisigPda, transactionIndex);
  return Proposal.fromAccountInfo(info)[0];
}

/** Require `signer` to be a member with `permission`; returns the member entry. */
function requireMember(
  multisig: accounts.Multisig,
  multisigPda: PublicKey,
  signer: PublicKey,
  permission: types.Permission,
): types.Member {
  const member = multisig.members.find((m) => m.key.equals(signer));
  if (!member) throw new NotAMemberError(signer, multisigPda);
  if (!Permissions.has(member.permissions, permission)) {
    throw new SolwalletError(
      `Member ${signer.toBase58()} lacks the required permission (mask ${permission}).`,
      {
        code: "NOT_A_MEMBER",
        hint: "The member key is in the set but its permission mask excludes this action (initiate=1, vote=2, execute=4).",
      },
    );
  }
  return member;
}

function statusName(status: accounts.Proposal["status"]): ProposalStatusName {
  return status.__kind.toLowerCase() as ProposalStatusName;
}

function normalizeIndex(index: number | bigint): bigint {
  return typeof index === "bigint" ? index : BigInt(index);
}

/** Build + sign + (dry-run | send) a multisig transaction through our pipeline. */
async function sendInstructions(
  conn: ClusterConnection,
  signer: Keypair,
  ixs: TransactionInstruction[],
  opts: MultisigSendOptions,
  lookupTableAccounts?: AddressLookupTableAccount[],
): Promise<MultisigTxResult> {
  const { blockhash, lastValidBlockHeight } = await conn.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(lookupTableAccounts);
  const tx = new VersionedTransaction(message);
  tx.sign([signer]);

  if (opts.dryRun) {
    const sim = await dryRun(conn, tx);
    const base: MultisigTxResult = {
      signature: "",
      slot: 0,
      feeLamports: 0,
      simulatedOnly: true,
      logs: sim.logs,
      unitsConsumed: sim.unitsConsumed,
    };
    if (!sim.ok) {
      return {
        ...base,
        error: parseTransactionError({
          message: `Transaction simulation failed: ${JSON.stringify(sim.err)}`,
          logs: sim.logs,
        }),
      };
    }
    return base;
  }

  try {
    const sent = await conn.sendWithRetry(tx, {
      lastValidBlockHeight,
      allowMainnet: opts.allowMainnet,
      policy: opts.policy,
    });
    return {
      signature: sent.signature,
      slot: sent.slot,
      feeLamports: sent.feeLamports,
      simulatedOnly: false,
    };
  } catch (error) {
    return {
      signature: "",
      slot: 0,
      feeLamports: 0,
      simulatedOnly: false,
      error: parseTransactionError(error),
    };
  }
}

/** Validate member set + threshold, throwing structured errors. */
export function validateMultisigParams(members: PublicKey[], threshold: number): void {
  if (members.length === 0) {
    throw new InvalidMembersError("at least one member is required");
  }
  const seen = new Set<string>();
  for (const m of members) {
    const key = m.toBase58();
    if (seen.has(key)) throw new InvalidMembersError(`duplicate member ${key}`);
    seen.add(key);
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > members.length) {
    throw new InvalidThresholdError(threshold, members.length);
  }
}

// --- pure PDA derivations (usable without a connection, e.g. UI previews) ---

export function deriveMultisigPda(createKey: PublicKey): [PublicKey, number] {
  return getMultisigPda({ createKey });
}

export function deriveVaultPda(multisigPda: PublicKey, index = 0): [PublicKey, number] {
  return getVaultPda({ multisigPda, index });
}

export function deriveTransactionPda(
  multisigPda: PublicKey,
  index: number | bigint,
): [PublicKey, number] {
  return getTransactionPda({ multisigPda, index: normalizeIndex(index) });
}

export function deriveProposalPda(
  multisigPda: PublicKey,
  transactionIndex: number | bigint,
): [PublicKey, number] {
  return getProposalPda({ multisigPda, transactionIndex: normalizeIndex(transactionIndex) });
}

// ---------------------------------------------------------------------------
// createMultisig
// ---------------------------------------------------------------------------

export interface CreateMultisigOptions extends MultisigSendOptions {
  /** Seconds a approved proposal must wait before execution. Default 0. */
  timeLock?: number;
  /** Optional external config authority (null = members govern config). */
  configAuthority?: PublicKey | null;
  memo?: string;
}

export interface CreateMultisigResult extends MultisigTxResult {
  multisigPda: string;
  /** First vault (index 0) — the account that holds funds and signs proposals. */
  vaultPda: string;
  /** Random key whose PDA derivation defines this multisig's address. */
  createKey: string;
}

/**
 * Create a Squads V4 M-of-N multisig. All members receive full permissions
 * (initiate+vote+execute); fees and rent are paid by `creator`.
 */
export async function createMultisig(
  conn: ClusterConnection,
  creator: Keypair,
  members: PublicKey[],
  threshold: number,
  opts: CreateMultisigOptions = {},
): Promise<CreateMultisigResult> {
  validateMultisigParams(members, threshold);

  const createKey = Keypair.generate();
  const [multisigPda] = getMultisigPda({ createKey: createKey.publicKey });
  const [vaultPda] = getVaultPda({ multisigPda, index: 0 });

  // Treasury (creation-fee destination) lives in the program config account.
  const [programConfigPda] = getProgramConfigPda({});
  const configInfo = await conn.connection.getAccountInfo(programConfigPda);
  if (!configInfo) {
    throw new SolwalletError(
      "Squads program config account not found — the program may not be deployed on this cluster.",
      {
        code: "MULTISIG_PROGRAM_NOT_INITIALIZED",
        hint: "Squads V4 (SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf) ships a program config on devnet/testnet/mainnet. A custom cluster needs it bootstrapped first.",
      },
    );
  }
  const treasury = ProgramConfig.fromAccountInfo(configInfo)[0].treasury;

  const ix = instructions.multisigCreateV2({
    treasury,
    creator: creator.publicKey,
    multisigPda,
    configAuthority: opts.configAuthority ?? null,
    threshold,
    members: members.map((key) => ({ key, permissions: Permissions.all() })),
    timeLock: opts.timeLock ?? 0,
    createKey: createKey.publicKey,
    rentCollector: null,
    memo: opts.memo,
  });

  const { blockhash, lastValidBlockHeight } = await conn.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: creator.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([creator, createKey]); // createKey must sign once to prevent address replay

  const send = async (): Promise<MultisigTxResult> => {
    if (opts.dryRun) {
      const sim = await dryRun(conn, tx);
      const base: MultisigTxResult = {
        signature: "",
        slot: 0,
        feeLamports: 0,
        simulatedOnly: true,
        logs: sim.logs,
        unitsConsumed: sim.unitsConsumed,
      };
      if (!sim.ok) {
        return {
          ...base,
          error: parseTransactionError({
            message: `Transaction simulation failed: ${JSON.stringify(sim.err)}`,
            logs: sim.logs,
          }),
        };
      }
      return base;
    }
    try {
      const sent = await conn.sendWithRetry(tx, {
        lastValidBlockHeight,
        allowMainnet: opts.allowMainnet,
        policy: opts.policy,
      });
      return {
        signature: sent.signature,
        slot: sent.slot,
        feeLamports: sent.feeLamports,
        simulatedOnly: false,
      };
    } catch (error) {
      return {
        signature: "",
        slot: 0,
        feeLamports: 0,
        simulatedOnly: false,
        error: parseTransactionError(error),
      };
    }
  };

  return {
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    createKey: createKey.publicKey.toBase58(),
    ...(await send()),
  };
}

// ---------------------------------------------------------------------------
// createMultisigProposal
// ---------------------------------------------------------------------------

export interface MultisigProposalRequest extends MultisigSendOptions {
  /** Vault index (Squads supports multiple vaults per multisig). Default 0. */
  vaultIndex?: number;
  /**
   * Fully-built inner instructions whose fee payer / funds owner is the vault
   * PDA (e.g. from buildTransferInstructions with payer = vaultPda).
   * Mutually exclusive with destination/amount.
   */
  instructions?: TransactionInstruction[];
  /** SOL transfer convenience: vault → destination, `amount` in lamports. */
  destination?: string | PublicKey;
  amount?: bigint;
  memo?: string;
}

export interface CreateMultisigProposalResult extends MultisigTxResult {
  multisigPda: string;
  transactionPda: string;
  proposalPda: string;
  /** Index of the new transaction (bigint serialized as string). */
  transactionIndex: string;
  vaultPda: string;
}

/**
 * Create a vault transaction + Active proposal wrapping the given
 * instructions (SOL transfer convenience built-in; SPL transfers can be
 * pre-built with buildTransferInstructions using the vault as payer).
 */
export async function createMultisigProposal(
  conn: ClusterConnection,
  proposer: Keypair,
  multisigPda: PublicKey,
  req: MultisigProposalRequest,
): Promise<CreateMultisigProposalResult> {
  const multisig = await fetchMultisig(conn, multisigPda);
  requireMember(multisig, multisigPda, proposer.publicKey, types.Permission.Initiate);

  const vaultIndex = req.vaultIndex ?? 0;
  const [vaultPda] = getVaultPda({ multisigPda, index: vaultIndex });

  let inner: TransactionInstruction[];
  if (req.instructions && req.instructions.length > 0) {
    inner = req.instructions;
  } else if (req.destination !== undefined && req.amount !== undefined) {
    const destination =
      req.destination instanceof PublicKey ? req.destination : new PublicKey(req.destination);
    inner = [
      SystemProgram.transfer({
        fromPubkey: vaultPda,
        toPubkey: destination,
        lamports: req.amount,
      }),
    ];
  } else {
    throw new SolwalletError(
      "Proposal needs either `instructions` or `destination` + `amount` (lamports).",
      {
        code: "INVALID_PROPOSAL_REQUEST",
        hint: "Pass destination + amount for a SOL transfer from the vault, or pre-built instructions (payer = vault PDA) for anything else.",
      },
    );
  }

  // Squads V4 indices are 1-based: multisig.transactionIndex tracks the
  // highest index CREATED SO FAR (0 on a brand-new multisig), so the next
  // transaction/proposal PDA must be derived at index+1 — using the raw
  // counter here collides with the program's own PDA derivation and the
  // instruction fails on-chain with ConstraintSeeds (error 2006).
  const transactionIndex = utils.toBigInt(multisig.transactionIndex) + 1n;

  // Inner message: the vault is the payer/signer; the multisig program
  // re-signs it with the vault PDA at execution time.
  const { blockhash } = await conn.connection.getLatestBlockhash("confirmed");
  const innerMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: blockhash,
    instructions: inner,
  });

  const ixs = [
    instructions.vaultTransactionCreate({
      multisigPda,
      transactionIndex,
      creator: proposer.publicKey,
      vaultIndex,
      ephemeralSigners: 0,
      transactionMessage: innerMessage,
      memo: req.memo,
    }),
    instructions.proposalCreate({
      multisigPda,
      creator: proposer.publicKey,
      transactionIndex,
      isDraft: false, // created directly in Active state
    }),
  ];

  const [transactionPda] = getTransactionPda({ multisigPda, index: transactionIndex });
  const [proposalPda] = getProposalPda({ multisigPda, transactionIndex });

  const result = await sendInstructions(conn, proposer, ixs, req);
  return {
    multisigPda: multisigPda.toBase58(),
    transactionPda: transactionPda.toBase58(),
    proposalPda: proposalPda.toBase58(),
    transactionIndex: transactionIndex.toString(),
    vaultPda: vaultPda.toBase58(),
    ...result,
  };
}

// ---------------------------------------------------------------------------
// approveMultisigProposal
// ---------------------------------------------------------------------------

export interface ApproveMultisigOptions extends MultisigSendOptions {
  memo?: string;
}

export interface ApproveMultisigResult extends MultisigTxResult {
  /** True when this member had already approved — nothing was sent. */
  alreadyApproved: boolean;
  approvedBy: string[];
  /** Threshold reached — executeMultisigProposal will succeed. */
  executeReady: boolean;
  status: ProposalStatusName;
}

/** Cast an approval vote on a proposal (idempotent for repeat approvers). */
export async function approveMultisigProposal(
  conn: ClusterConnection,
  approver: Keypair,
  multisigPda: PublicKey,
  transactionIndex: number | bigint,
  opts: ApproveMultisigOptions = {},
): Promise<ApproveMultisigResult> {
  const multisig = await fetchMultisig(conn, multisigPda);
  requireMember(multisig, multisigPda, approver.publicKey, types.Permission.Vote);

  const index = normalizeIndex(transactionIndex);
  const proposal = await fetchProposal(conn, multisigPda, index);
  const status = statusName(proposal.status);

  if (status === "executed" || status === "executing") {
    throw new ProposalAlreadyExecutedError(index);
  }
  if (status !== "active" && status !== "approved") {
    throw new ProposalNotActiveError(status);
  }

  const already = proposal.approved.some((k) => k.equals(approver.publicKey));
  if (already) {
    // Idempotent: nothing to send — report current vote state.
    return {
      signature: "",
      slot: 0,
      feeLamports: 0,
      simulatedOnly: false,
      alreadyApproved: true,
      approvedBy: proposal.approved.map((k) => k.toBase58()),
      executeReady: status === "approved" || proposal.approved.length >= multisig.threshold,
      status,
    };
  }

  const result = await sendInstructions(
    conn,
    approver,
    [
      instructions.proposalApprove({
        multisigPda,
        transactionIndex: index,
        member: approver.publicKey,
        memo: opts.memo,
      }),
    ],
    opts,
  );

  const approvedBy = [...proposal.approved.map((k) => k.toBase58()), approver.publicKey.toBase58()];
  return {
    alreadyApproved: false,
    approvedBy,
    executeReady: approvedBy.length >= multisig.threshold,
    status: approvedBy.length >= multisig.threshold ? "approved" : "active",
    ...result,
  };
}

// ---------------------------------------------------------------------------
// executeMultisigProposal
// ---------------------------------------------------------------------------

export type ExecuteMultisigResult = MultisigTxResult;

/**
 * Execute an approved proposal. The vault signs the inner transaction via the
 * multisig program; `member` pays the outer transaction fee.
 */
export async function executeMultisigProposal(
  conn: ClusterConnection,
  member: Keypair,
  multisigPda: PublicKey,
  transactionIndex: number | bigint,
  opts: MultisigSendOptions = {},
): Promise<ExecuteMultisigResult> {
  const multisig = await fetchMultisig(conn, multisigPda);
  requireMember(multisig, multisigPda, member.publicKey, types.Permission.Execute);

  const index = normalizeIndex(transactionIndex);
  const proposal = await fetchProposal(conn, multisigPda, index);
  const status = statusName(proposal.status);
  if (status === "executed" || status === "executing") {
    throw new ProposalAlreadyExecutedError(index);
  }
  if (status !== "approved") {
    throw new ProposalNotApprovedError(proposal.approved.length, multisig.threshold);
  }

  // The SDK helper fetches the vault transaction account + ALTs and assembles
  // remaining accounts for the execute instruction.
  const { instruction, lookupTableAccounts } = await instructions.vaultTransactionExecute({
    connection: conn.connection,
    multisigPda,
    transactionIndex: index,
    member: member.publicKey,
  });

  return sendInstructions(conn, member, [instruction], opts, lookupTableAccounts);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface MultisigState {
  multisigPda: string;
  members: string[];
  threshold: number;
  timeLock: number;
  /** Next transaction index (also the number of transactions ever created). */
  transactionIndex: string;
  staleTransactionIndex: string;
  configAuthority: string | null;
  vault0Pda: string;
}

/** Read members / threshold / current transaction index of a multisig. */
export async function getMultisigState(
  conn: ClusterConnection,
  multisigPda: PublicKey,
): Promise<MultisigState> {
  const multisig = await fetchMultisig(conn, multisigPda);
  const [vaultPda] = getVaultPda({ multisigPda, index: 0 });
  return {
    multisigPda: multisigPda.toBase58(),
    members: multisig.members.map((m) => m.key.toBase58()),
    threshold: multisig.threshold,
    timeLock: multisig.timeLock,
    transactionIndex: utils.toBigInt(multisig.transactionIndex).toString(),
    staleTransactionIndex: utils.toBigInt(multisig.staleTransactionIndex).toString(),
    configAuthority:
      multisig.configAuthority.equals(PublicKey.default)
        ? null
        : multisig.configAuthority.toBase58(),
    vault0Pda: vaultPda.toBase58(),
  };
}

export interface MultisigProposalSummary {
  transactionIndex: string;
  transactionPda: string;
  proposalPda: string;
  status: ProposalStatusName;
  /** status === "approved": quorum reached, execution unlocked. */
  executeReady: boolean;
  approvedBy: string[];
  rejectedBy: string[];
  cancelledBy: string[];
  /**
   * What the vault transaction does when executed (decoded from its stored
   * message). null when the transaction account is missing or not a vault
   * transaction (e.g. a config transaction).
   */
  actions: ProposalAction[] | null;
}

export interface MultisigProposalList {
  multisigPda: string;
  transactionIndex: string;
  proposals: MultisigProposalSummary[];
}

/**
 * List all proposals on a multisig. Probes proposal PDAs for indexes
 * 1..transactionIndex (Squads V4 indices are 1-based — transactionIndex is
 * the highest index created so far, not an exclusive upper bound; proposals
 * are optional companions of vault transactions, so gaps are simply skipped).
 */
export async function listProposals(
  conn: ClusterConnection,
  multisigPda: PublicKey,
): Promise<MultisigProposalList> {
  const state = await getMultisigState(conn, multisigPda);
  const total = BigInt(state.transactionIndex);

  const proposals = await Promise.all(
    Array.from({ length: Number(total) }, (_, i) => BigInt(i + 1)).map(async (index) => {
      const [proposalPda] = getProposalPda({ multisigPda, transactionIndex: index });
      const [transactionPda] = getTransactionPda({ multisigPda, index });
      const [info, txInfo] = await Promise.all([
        conn.connection.getAccountInfo(proposalPda),
        conn.connection.getAccountInfo(transactionPda),
      ]);
      if (!info) return null;
      const proposal = Proposal.fromAccountInfo(info)[0];
      let actions: ProposalAction[] | null = null;
      if (txInfo) {
        try {
          actions = describeVaultMessage(accounts.VaultTransaction.fromAccountInfo(txInfo)[0].message);
        } catch {
          actions = null; // not a vault transaction (config tx etc.)
        }
      }
      const status = statusName(proposal.status);
      return {
        transactionIndex: index.toString(),
        transactionPda: transactionPda.toBase58(),
        proposalPda: proposalPda.toBase58(),
        status,
        executeReady: status === "approved",
        approvedBy: proposal.approved.map((k) => k.toBase58()),
        rejectedBy: proposal.rejected.map((k) => k.toBase58()),
        cancelledBy: proposal.cancelled.map((k) => k.toBase58()),
        actions,
      } satisfies MultisigProposalSummary;
    }),
  );

  return {
    multisigPda: multisigPda.toBase58(),
    transactionIndex: state.transactionIndex,
    proposals: proposals.filter((p): p is MultisigProposalSummary => p !== null),
  };
}

export { SQUADS_PROGRAM_ID };
