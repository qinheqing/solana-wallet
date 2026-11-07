import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type Connection,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { ClusterConnection } from "../connection/connection.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { buildTransferInstructions } from "./build.js";
import { transfer } from "./transfer.js";

// ---------------------------------------------------------------------------
// Fake connection: deterministic mint/ATA account registry.
// ---------------------------------------------------------------------------

function fakeConn(opts: {
  mint?: PublicKey;
  mintOwner?: PublicKey;
  existingAtas?: Set<string>;
  /** Default true: register the payer's derived source ATA. */
  sourceAtaMissing?: boolean;
  sendRawTransaction?: () => Promise<string>;
} = {}) {
  const accounts = new Map<string, { owner: PublicKey }>();
  const mint = opts.mint ?? Keypair.generate().publicKey;
  const mintOwner =
    opts.mintOwner ?? TOKEN_PROGRAM_ID; // default: classic SPL mint
  accounts.set(mint.toBase58(), { owner: mintOwner });
  if (!opts.sourceAtaMissing) {
    const sourceAta = getAssociatedTokenAddressSync(
      mint,
      payer.publicKey,
      true,
      mintOwner,
    );
    accounts.set(sourceAta.toBase58(), { owner: payer.publicKey });
  }
  for (const ata of opts.existingAtas ?? []) {
    accounts.set(ata, { owner: PublicKey.default });
  }

  const fake = {
    getAccountInfo: vi.fn().mockImplementation((addr: PublicKey) => {
      const hit = accounts.get(addr.toBase58());
      return hit
        ? Promise.resolve({ owner: hit.owner, data: Buffer.alloc(0) })
        : Promise.resolve(null);
    }),
    // A PublicKey is a valid 32-byte base58 string — perfect fake blockhash.
    getLatestBlockhash: vi
      .fn()
      .mockResolvedValue({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 999,
      }),
    sendRawTransaction: vi.fn(opts.sendRawTransaction ?? (() => Promise.resolve("SIG_TX"))),
    simulateTransaction: vi.fn().mockResolvedValue({
      value: { err: null, logs: ["Program log: Simulated ok"], unitsConsumed: 12345 },
    }),
    confirmTransaction: vi
      .fn()
      .mockResolvedValue({ value: { err: null }, context: { slot: 42 } }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
  };

  const conn = new ClusterConnection(
    { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" },
    { connection: fake as unknown as Connection },
  );
  return { conn, fake, accounts, mint };
}

const payer = Keypair.generate();
const recipient = Keypair.generate().publicKey;

describe("buildTransferInstructions (5.1–5.3)", () => {
  it("rejects zero and negative amounts before touching the network (14.2 boundary)", async () => {
    const { conn } = fakeConn();
    await expect(
      buildTransferInstructions(conn, {
        payer: payer.publicKey,
        destination: recipient,
        amount: 0n,
      }),
    ).rejects.toMatchObject({ code: "AMOUNT_ZERO_OR_NEGATIVE" });
    await expect(
      buildTransferInstructions(conn, {
        payer: payer.publicKey,
        destination: recipient,
        amount: -1n,
      }),
    ).rejects.toMatchObject({ code: "AMOUNT_ZERO_OR_NEGATIVE" });
  });

  it("SOL transfer → single SystemProgram instruction", async () => {
    const { conn, mint } = fakeConn();
    const built = await buildTransferInstructions(conn, {
      payer: payer.publicKey,
      destination: recipient,
      amount: 1_000n,
    });
    expect(built.program).toBeNull();
    expect(built.instructions).toHaveLength(1);
    expect(built.instructions[0]!.programId).toEqual(SystemProgram.programId);
  });

  it("token transfer dispatches by mint owner (SPL vs Token-2022)", async () => {
    const mint = Keypair.generate().publicKey;
    // Register the *derived* SPL destination ATA (deterministic address).
    const destAta = getAssociatedTokenAddressSync(
      mint,
      recipient,
      true,
      TOKEN_PROGRAM_ID,
    ).toBase58();
    const { conn } = fakeConn({ mint, existingAtas: [destAta] });
    const built = await buildTransferInstructions(conn, {
      payer: payer.publicKey,
      destination: recipient,
      mint,
      amount: 1n,
      decimals: 6,
      allowAtaCreation: false,
    });
    expect(built.program?.kind).toBe("spl-token");
    expect(built.instructions).toHaveLength(1); // ATA exists → no creation ix
    expect(built.instructions[0]!.programId).toEqual(TOKEN_PROGRAM_ID);
  });

  it("Token-2022 mint uses the Token-2022 program id", async () => {
    const mint = Keypair.generate().publicKey;
    const destAta = getAssociatedTokenAddressSync(
      mint,
      recipient,
      true,
      TOKEN_2022_PROGRAM_ID,
    ).toBase58();
    const { conn } = fakeConn({
      mint,
      mintOwner: TOKEN_2022_PROGRAM_ID,
      existingAtas: [destAta],
    });
    const built = await buildTransferInstructions(conn, {
      payer: payer.publicKey,
      destination: recipient,
      mint,
      amount: 1n,
      decimals: 9,
    });
    expect(built.program?.kind).toBe("token-2022");
    expect(built.destinationAtaCreated).toBe(false);
    expect(built.instructions).toHaveLength(1);
    expect(built.instructions[0]!.programId).toEqual(TOKEN_2022_PROGRAM_ID);
  });

  it("missing destination ATA + allowed → prepends idempotent creation", async () => {
    const { conn, mint } = fakeConn();
    const built = await buildTransferInstructions(conn, {
      payer: payer.publicKey,
      destination: recipient,
      mint,
      amount: 1n,
      decimals: 6,
    });
    expect(built.destinationAtaCreated).toBe(true);
    expect(built.instructions).toHaveLength(2);
    const [ataIx, transferIx] = built.instructions;
    expect(ataIx!.programId).toEqual(ASSOCIATED_TOKEN_PROGRAM_ID);
    expect(transferIx!.programId).toEqual(TOKEN_PROGRAM_ID);
  });

  it("missing destination ATA + disallowed → structured ATA_MISSING error", async () => {
    const { conn, mint } = fakeConn();
    await expect(
      buildTransferInstructions(conn, {
        payer: payer.publicKey,
        destination: recipient,
        mint,
        amount: 1n,
        decimals: 6,
        allowAtaCreation: false,
      }),
    ).rejects.toMatchObject({ code: "ATA_MISSING" });
  });

  it("existing destination ATA → never duplicates the creation instruction (14.3 boundary)", async () => {
    const mint = Keypair.generate().publicKey;
    const destAta = getAssociatedTokenAddressSync(
      mint,
      recipient,
      true,
      TOKEN_PROGRAM_ID,
    ).toBase58();
    const { conn } = fakeConn({ mint, existingAtas: [destAta] });
    const built = await buildTransferInstructions(conn, {
      payer: payer.publicKey,
      destination: recipient,
      mint,
      amount: 1n,
      decimals: 6,
      allowAtaCreation: true, // even when allowed, an existing ATA must not be re-created
    });
    expect(built.destinationAtaCreated).toBe(false);
    expect(built.instructions).toHaveLength(1); // transferChecked only, no ATA-create ix
    expect(
      built.instructions.every((ix) => !ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)),
    ).toBe(true);
  });

  it("unknown mint → MINT_NOT_FOUND; non-mint account → NOT_A_MINT", async () => {
    const { conn, mint } = fakeConn();
    const unknown = Keypair.generate().publicKey;
    await expect(
      buildTransferInstructions(conn, {
        payer: payer.publicKey,
        destination: recipient,
        mint: unknown,
        amount: 1n,
        decimals: 6,
      }),
    ).rejects.toMatchObject({ code: "MINT_NOT_FOUND" });

    const notMint = Keypair.generate().publicKey.toBase58();
    const { conn: conn2 } = fakeConn();
    (conn2 as unknown as { connection: { getAccountInfo: (a: PublicKey) => Promise<{ owner: PublicKey; data: Buffer } | null> } }).connection.getAccountInfo = vi
      .fn()
      .mockResolvedValue({ owner: SystemProgram.programId, data: Buffer.alloc(0) });
    await expect(
      buildTransferInstructions(conn2, {
        payer: payer.publicKey,
        destination: recipient,
        mint: new PublicKey(notMint),
        amount: 1n,
        decimals: 6,
      }),
    ).rejects.toMatchObject({ code: "NOT_A_MINT" });
  });

  it("source ATA missing → SOURCE_ATA_MISSING", async () => {
    const { conn, mint } = fakeConn({ sourceAtaMissing: true });
    // Payer has no token account for this mint → fails before destination logic.
    await expect(
      buildTransferInstructions(conn, {
        payer: payer.publicKey,
        destination: recipient,
        mint,
        amount: 1n,
        decimals: 6,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_ATA_MISSING" });
  });

  it("token transfer without decimals → DECIMALS_REQUIRED", async () => {
    const destAta = Keypair.generate().publicKey.toBase58();
    const { conn, mint } = fakeConn({ existingAtas: [destAta] });
    await expect(
      buildTransferInstructions(conn, {
        payer: payer.publicKey,
        destination: recipient,
        mint,
        amount: 1n,
      }),
    ).rejects.toMatchObject({ code: "DECIMALS_REQUIRED" });
  });

  it("SOL transfer with decimals → DECIMALS_UNEXPECTED", async () => {
    const { conn, mint } = fakeConn();
    await expect(
      buildTransferInstructions(conn, {
        payer: payer.publicKey,
        destination: recipient,
        amount: 1n,
        decimals: 9,
      }),
    ).rejects.toMatchObject({ code: "DECIMALS_UNEXPECTED" });
  });
});

describe("transfer() orchestration (5.5)", () => {
  it("dry-run returns logs and never sends", async () => {
    const mint = Keypair.generate().publicKey;
    const destAta = getAssociatedTokenAddressSync(
      mint,
      recipient,
      true,
      TOKEN_PROGRAM_ID,
    ).toBase58();
    const { conn, fake } = fakeConn({ mint, existingAtas: [destAta] });
    const result = await transfer(conn, {
      from: payer,
      destination: recipient,
      mint,
      amount: 1n,
      decimals: 6,
      dryRun: true,
    });
    expect(result.simulatedOnly).toBe(true);
    expect(result.signature).toBe("");
    expect(result.program).toBe("spl-token");
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("send path returns signature/slot/fee and program kind", async () => {
    const mint = Keypair.generate().publicKey;
    const destAta = getAssociatedTokenAddressSync(
      mint,
      recipient,
      true,
      TOKEN_PROGRAM_ID,
    ).toBase58();
    const { conn, fake } = fakeConn({ mint, existingAtas: [destAta] });
    const result = await transfer(conn, {
      from: payer,
      destination: recipient,
      mint,
      amount: 1n,
      decimals: 6,
    });
    expect(result.signature).toBe("SIG_TX");
    expect(result.slot).toBe(42);
    expect(result.feeLamports).toBe(5000);
    expect(result.simulatedOnly).toBe(false);
    expect(result.error).toBeUndefined();
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("SOL transfer end-to-end", async () => {
    const { conn, mint } = fakeConn();
    const result = await transfer(conn, {
      from: payer,
      destination: recipient,
      amount: 5_000_000_000n, // 5 SOL
    });
    expect(result.program).toBe("system");
    expect(result.destinationAtaCreated).toBe(false);
    expect(result.signature).toBe("SIG_TX");
  });

  it("send failure returns parsed error instead of throwing", async () => {
    const mint = Keypair.generate().publicKey;
    const destAta = getAssociatedTokenAddressSync(
      mint,
      recipient,
      true,
      TOKEN_PROGRAM_ID,
    ).toBase58();
    const { conn } = fakeConn({
      mint,
      existingAtas: [destAta],
      sendRawTransaction: () =>
        Promise.reject(new Error("Error: insufficient funds for rent")),
    });
    const result = await transfer(conn, {
      from: payer,
      destination: recipient,
      mint,
      amount: 1n,
      decimals: 6,
      policy: { retries: 1 }, // skip exponential backoff — pure parse test
    });
    expect(result.error?.code).toBe("INSUFFICIENT_FUNDS");
    expect(result.error?.suggestion).toMatch(/airdrop|balance/i);
    expect(result.signature).toBe("");
  });
});
