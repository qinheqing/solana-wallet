/**
 * Multisig tools (task #10): Squads V4 M-of-N creation and the
 * propose → approve → execute lifecycle, plus read-only state queries.
 * All on-chain actions run through @solwallet/core (dryRun + sendWithRetry).
 */
import {
  approveMultisigProposal,
  buildTransferInstructions,
  createMultisig,
  createMultisigProposal,
  deriveVaultPda,
  executeMultisigProposal,
  getMultisigState,
  listProposals,
  parseAmount,
  solToLamports,
} from "@solwallet/core";
import { PublicKey } from "@solana/web3.js";

import type { ToolDeps } from "../types.js";

type McpServer = import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

export function registerMultisigTools(
  server: McpServer,
  deps: ToolDeps,
  z: typeof import("zod").z,
): void {
  const { connections, run } = deps;

  // propose_multisig returns transactionIndex as a numeric string (it is
  // internally a bigint, serialized that way to survive values beyond
  // Number.MAX_SAFE_INTEGER). Accept both shapes here so a client that
  // simply forwards that return value — the obvious, expected usage —
  // doesn't hit a schema-validation error.
  const transactionIndexParam = z
    .union([z.number().int().min(0), z.string().regex(/^\d+$/, "must be a non-negative integer string")])
    .transform((v) => (typeof v === "string" ? Number(v) : v))
    .describe("Proposal number (from propose_multisig's result or get_multisig's proposal list). Accepts a number or numeric string.");

  const clusterParam = z
    .string()
    .optional()
    .describe(
      `Cluster name (devnet | testnet | mainnet-beta) or RPC URL. Default: ${deps.connections.defaultCluster()} (env SOLWALLET_CLUSTER).`,
    );

  server.registerTool(
    "create_multisig",
    {
      description:
        "Create a Squads V4 M-of-N multisig: threshold approvals of `members` are required to move funds from its vault. Returns multisigPda (keep it — later tools need it), vaultPda (fund this address) and the creation signature. Fees are paid by walletName.",
      inputSchema: {
        walletName: z.string().describe("Loaded wallet of the creating member — pays fees/rent and becomes a member automatically only if listed in members."),
        members: z.array(z.string()).min(1).describe("Member public keys (include walletName's pubkey here if it should be a member)."),
        threshold: z.number().int().min(1).describe("Required approvals M (1 <= M <= number of members), e.g. 2 for 2-of-3."),
        timeLock: z.number().int().min(0).optional().describe("Seconds an approved proposal must wait before execution. Default 0."),
        dryRun: z.boolean().optional().describe("Simulate creation without sending."),
        allowMainnet: z.literal(true).optional().describe("Required literal true on mainnet-beta (creation may cost a small fee)."),
        cluster: clusterParam,
      },
    },
    run(async (args: {
      walletName: string;
      members: string[];
      threshold: number;
      timeLock?: number;
      dryRun?: boolean;
      allowMainnet?: boolean;
      cluster?: string;
    }) => {
      const conn = connections.get(args.cluster);
      const creator = deps.store.require(args.walletName).keypair;
      const result = await createMultisig(
        conn,
        creator,
        args.members.map((m) => new PublicKey(m)),
        args.threshold,
        { timeLock: args.timeLock, dryRun: args.dryRun, allowMainnet: args.allowMainnet },
      );
      return {
        ...result,
        summary: result.error
          ? `Creation failed: ${result.error.code}`
          : result.simulatedOnly
            ? `Dry-run ok — multisig ${result.multisigPda} would be created.`
            : `Multisig ${result.multisigPda} created (${args.threshold}-of-${args.members.length}). Fund its vault ${result.vaultPda} to use it.`,
      };
    }),
  );

  server.registerTool(
    "propose_multisig",
    {
      description:
        "Create a proposal on a Squads multisig: wraps a transfer from the multisig vault into a vault transaction and opens it for votes (status active). Native SOL (to + amount in SOL) or SPL/Token-2022 (add mint + decimals; destination token account is auto-created from vault funds). Threshold approvals via approve_multisig unlock execute_multisig.",
      inputSchema: {
        walletName: z.string().describe("Loaded wallet of a multisig member creating the proposal."),
        multisigPda: z.string().describe("Multisig address returned by create_multisig."),
        to: z.string().describe("Recipient wallet address (tokens go to their ATA)."),
        amount: z.string().describe('Human-readable amount: "1.5" SOL for native, token units (respecting decimals) with mint.'),
        mint: z.string().optional().describe("Token mint address — omit for native SOL."),
        decimals: z.number().int().min(0).max(18).optional().describe("Required when mint is set."),
        vaultIndex: z.number().int().min(0).optional().describe("Vault index when the multisig uses multiple vaults. Default 0."),
        dryRun: z.boolean().optional().describe("Simulate without sending."),
        allowMainnet: z.literal(true).optional().describe("Required literal true on mainnet-beta."),
        cluster: clusterParam,
      },
    },
    run(async (args: {
      walletName: string;
      multisigPda: string;
      to: string;
      amount: string;
      mint?: string;
      decimals?: number;
      vaultIndex?: number;
      dryRun?: boolean;
      allowMainnet?: boolean;
      cluster?: string;
    }) => {
      const conn = connections.get(args.cluster);
      const proposer = deps.store.require(args.walletName).keypair;
      const multisigPda = new PublicKey(args.multisigPda);
      const vaultIndex = args.vaultIndex ?? 0;
      const vaultPda = deriveVaultPda(multisigPda, vaultIndex)[0];

      // Token legs are pre-built here with the vault as payer/source owner;
      // SOL legs use core's built-in vault transfer convenience.
      let instructions;
      if (args.mint) {
        if (args.decimals === undefined) {
          throw new Error("decimals is required for token proposals (mint is set).");
        }
        const built = await buildTransferInstructions(conn, {
          payer: vaultPda,
          destination: new PublicKey(args.to),
          mint: new PublicKey(args.mint),
          amount: parseAmount(args.amount, args.decimals),
          decimals: args.decimals,
        });
        instructions = built.instructions;
      }

      const result = await createMultisigProposal(conn, proposer, multisigPda, {
        vaultIndex,
        instructions,
        destination: args.mint ? undefined : new PublicKey(args.to),
        amount: args.mint ? undefined : solToLamports(args.amount),
        dryRun: args.dryRun,
        allowMainnet: args.allowMainnet,
      });
      return {
        ...result,
        summary: result.error
          ? `Proposal failed: ${result.error.code}`
          : `Proposal #${result.transactionIndex} created (transaction ${result.transactionPda}). Collect approvals via approve_multisig, then execute_multisig.`,
      };
    }),
  );

  server.registerTool(
    "approve_multisig",
    {
      description:
        "Cast one member's approval vote on a multisig proposal. Repeat votes by the same member are no-ops. When approvals reach the threshold, status becomes approved and execute_multisig is unlocked.",
      inputSchema: {
        walletName: z.string().describe("Loaded wallet of a multisig member voting yes."),
        multisigPda: z.string().describe("Multisig address."),
        transactionIndex: transactionIndexParam,
        dryRun: z.boolean().optional().describe("Simulate without sending."),
        allowMainnet: z.literal(true).optional().describe("Required literal true on mainnet-beta."),
        cluster: clusterParam,
      },
    },
    run(async (args: {
      walletName: string;
      multisigPda: string;
      transactionIndex: number;
      dryRun?: boolean;
      allowMainnet?: boolean;
      cluster?: string;
    }) => {
      const conn = connections.get(args.cluster);
      const approver = deps.store.require(args.walletName).keypair;
      const result = await approveMultisigProposal(
        conn,
        approver,
        new PublicKey(args.multisigPda),
        args.transactionIndex,
        { dryRun: args.dryRun, allowMainnet: args.allowMainnet },
      );
      return {
        ...result,
        summary: result.error
          ? `Approval failed: ${result.error.code}`
          : result.alreadyApproved
            ? `Already approved — no transaction sent. Approved by ${result.approvedBy.length} member(s).`
            : result.executeReady
              ? `Approval recorded — threshold reached, proposal is executeReady. Call execute_multisig.`
              : `Approval recorded (${result.approvedBy.length} so far). More approvals needed before execution.`,
      };
    }),
  );

  server.registerTool(
    "execute_multisig",
    {
      description:
        "Execute an approved multisig proposal: the vault carries out the wrapped transfer, the inner transaction fee is paid from vault funds. Only possible once approval count reached the threshold (status approved).",
      inputSchema: {
        walletName: z.string().describe("Loaded wallet of a member submitting the execution (pays the outer fee)."),
        multisigPda: z.string().describe("Multisig address."),
        transactionIndex: transactionIndexParam,
        dryRun: z.boolean().optional().describe("Simulate without sending."),
        allowMainnet: z.literal(true).optional().describe("Required literal true on mainnet-beta."),
        cluster: clusterParam,
      },
    },
    run(async (args: {
      walletName: string;
      multisigPda: string;
      transactionIndex: number;
      dryRun?: boolean;
      allowMainnet?: boolean;
      cluster?: string;
    }) => {
      const conn = connections.get(args.cluster);
      const member = deps.store.require(args.walletName).keypair;
      const result = await executeMultisigProposal(
        conn,
        member,
        new PublicKey(args.multisigPda),
        args.transactionIndex,
        { dryRun: args.dryRun, allowMainnet: args.allowMainnet },
      );
      return {
        ...result,
        summary: result.error
          ? `Execution failed: ${result.error.code}`
          : `Proposal #${args.transactionIndex} executed — signature ${result.signature}.`,
      };
    }),
  );

  server.registerTool(
    "get_multisig",
    {
      description:
        "Read-only multisig inspection: members, threshold, current transaction index, vault-0 address, and every proposal with status (draft | active | approved=executeReady | executed | rejected | cancelled) and approval voter list.",
      inputSchema: {
        multisigPda: z.string().describe("Multisig address."),
        cluster: clusterParam,
      },
    },
    run(async (args: { multisigPda: string; cluster?: string }) => {
      const conn = connections.get(args.cluster);
      const multisigPda = new PublicKey(args.multisigPda);
      const [state, proposals] = await Promise.all([
        getMultisigState(conn, multisigPda),
        listProposals(conn, multisigPda),
      ]);
      const pending = proposals.proposals.filter(
        (p) => p.status === "active" || p.status === "approved",
      ).length;
      return {
        ...state,
        proposals: proposals.proposals,
        summary: `Multisig ${state.threshold}-of-${state.members.length}; ${proposals.proposals.length} proposal(s), ${pending} awaiting action.`,
      };
    }),
  );
}
