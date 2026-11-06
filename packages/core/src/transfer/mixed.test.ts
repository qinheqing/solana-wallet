/**
 * Mixed transfer tests (6.4, 6.5): SOL + SPL + Token-2022 legs merged into
 * one transaction in input order, program-id dispatch, dry-run, size guard,
 * structured validation errors.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { ClusterConnection } from "../connection/connection.js";
import { executeMixedTransfer, type MixedLeg } from "./mixed.js";

// ---------------------------------------------------------------------------
// Fake connection: deterministic multi-mint account registry.
// ---------------------------------------------------------------------------

const payer = Keypair.generate();

function fakeConn(opts: {
  mints: Array<{ mint: PublicKey; owner: PublicKey }>;
  existingAtas?: string[];
  simulateErr?: unknown;
  sendRawTransaction?: () => Promise<string>;
} ) {
  const accounts = new Map<string, { owner: PublicKey }>();
  for (const m of opts.mints) {
    accounts.set(m.mint.toBase58(), { owner: m.owner });
    // Payer's derived source ATA holds the tokens for each mint.
    const src = getAssociatedTokenAddressSync(m.mint, payer.publicKey, true, m.owner);
    accounts.set(src.toBase58(), { owner: payer.publicKey });
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
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 999,
    }),
    sendRawTransaction: vi.fn(opts.sendRawTransaction ?? (() => Promise.resolve("SIG_TX"))),
    simulateTransaction: vi.fn().mockResolvedValue({
      value: {
        err: opts.simulateErr ?? null,
        logs: ["Program log: Simulated ok"],
        unitsConsumed: 12345,
      },
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
  return { conn, fake };
}

/** SOL + classic SPL + Token-2022 mint fixture, destination ATAs pre-created. */
function mixedFixture(opts: { withDestAtas?: boolean } = {}) {
  const solRecipient = Keypair.generate().publicKey;
  const splMint = Keypair.generate().publicKey;
  const t22Mint = Keypair.generate().publicKey;
  const splOwner = Keypair.generate().publicKey;
  const t22Owner = Keypair.generate().publicKey;
  const destAtas =
    opts.withDestAtas === false
      ? []
      : [
          getAssociatedTokenAddressSync(splMint, splOwner, true, TOKEN_PROGRAM_ID).toBase58(),
          getAssociatedTokenAddressSync(t22Mint, t22Owner, true, TOKEN_2022_PROGRAM_ID).toBase58(),
        ];

  const legs: MixedLeg[] = [
    { kind: "sol", to: solRecipient, amount: 1_000n },
    { kind: "token", to: splOwner, amount: 5n, mint: splMint, decimals: 6 },
    { kind: "token", to: t22Owner, amount: 7n, mint: t22Mint, decimals: 9 },
  ];
  return { legs, solRecipient, splMint, t22Mint, splOwner, t22Owner, destAtas };
}

describe("executeMixedTransfer (6.4)", () => {
  it("merges SOL + SPL + Token-2022 legs into ONE sent transaction, input order", async () => {
    const fx = mixedFixture();
    const { conn, fake } = fakeConn({ mints: [
      { mint: fx.splMint, owner: TOKEN_PROGRAM_ID },
      { mint: fx.t22Mint, owner: TOKEN_2022_PROGRAM_ID },
    ], existingAtas: fx.destAtas });

    const result = await executeMixedTransfer(conn, payer, fx.legs);
    expect(result.error).toBeUndefined();
    expect(result.simulatedOnly).toBe(false);
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce(); // one tx, one signature
    expect(result.signature).toBe("SIG_TX");
    expect(result.slot).toBe(42);
    expect(result.feeLamports).toBe(5000);

    // Decode the sent transaction: exactly 3 instructions, input order,
    // each leg using its own program. (v0 messages expose compiledInstructions.)
    const raw = fake.sendRawTransaction.mock.calls[0]![0] as Uint8Array;
    const decoded = VersionedTransaction.deserialize(raw);
    const compiled = decoded.message.compiledInstructions;
    expect(compiled.length).toBe(3);
    const programs = compiled.map(
      (ix) => decoded.message.staticAccountKeys[ix.programIdIndex]!,
    );
    expect(programs[0]).toEqual(SystemProgram.programId);
    expect(programs[1]).toEqual(TOKEN_PROGRAM_ID);
    expect(programs[2]).toEqual(TOKEN_2022_PROGRAM_ID);

    // Per-leg summaries echo order, programs, amounts, ATA state.
    expect(result.legs.map((l) => l.program)).toEqual(["system", "spl-token", "token-2022"]);
    expect(result.legs[0]!.to).toBe(fx.solRecipient.toBase58());
    expect(result.legs[0]!.amountBaseUnits).toBe("1000");
    expect(result.legs[1]!.amountBaseUnits).toBe("5");
    expect(result.legs[1]!.destinationAtaCreated).toBe(false);
    expect(result.legs[2]!.destinationAta).toBe(fx.destAtas[1]);
  });

  it("prepends idempotent ATA creation for token legs missing an account", async () => {
    const fx = mixedFixture({ withDestAtas: false });
    const { conn, fake } = fakeConn({ mints: [
      { mint: fx.splMint, owner: TOKEN_PROGRAM_ID },
      { mint: fx.t22Mint, owner: TOKEN_2022_PROGRAM_ID },
    ] });

    const result = await executeMixedTransfer(conn, payer, fx.legs);
    const raw = fake.sendRawTransaction.mock.calls[0]![0] as Uint8Array;
    const decoded = VersionedTransaction.deserialize(raw);
    const programs = decoded.message.compiledInstructions.map(
      (ix) => decoded.message.staticAccountKeys[ix.programIdIndex]!,
    );
    // SOL, then [ATA-create, transfer] per token leg — creation precedes transfer.
    expect(programs.map((p) => p.toBase58())).toEqual([
      SystemProgram.programId.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
    ]);
    expect(result.legs[1]!.destinationAtaCreated).toBe(true);
    expect(result.legs[2]!.destinationAtaCreated).toBe(true);
  });

  it("dryRun: simulates the merged tx and never sends", async () => {
    const fx = mixedFixture();
    const { conn, fake } = fakeConn({ mints: [
      { mint: fx.splMint, owner: TOKEN_PROGRAM_ID },
      { mint: fx.t22Mint, owner: TOKEN_2022_PROGRAM_ID },
    ], existingAtas: fx.destAtas });

    const result = await executeMixedTransfer(conn, payer, fx.legs, { dryRun: true });
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
    expect(result.simulatedOnly).toBe(true);
    expect(result.signature).toBe("");
    expect(result.logs?.length).toBeGreaterThan(0);
    expect(result.unitsConsumed).toBe(12345);
    expect(result.legs.length).toBe(3);
  });

  it("oversized merged transaction → structured TX_TOO_LARGE pointing at batching", async () => {
    const { conn } = fakeConn({ mints: [] });
    const legs: MixedLeg[] = Array.from({ length: 60 }, () => ({
      kind: "sol" as const,
      to: Keypair.generate().publicKey,
      amount: 1n,
    }));
    await expect(executeMixedTransfer(conn, payer, legs)).rejects.toMatchObject({
      code: "TX_TOO_LARGE",
      hint: expect.stringMatching(/batch/i), // points the caller at batching
    });
  });

  it("SOL amount above MAX_SAFE_INTEGER → structured AMOUNT_OVERFLOW", async () => {
    const { conn } = fakeConn({ mints: [] });
    await expect(
      executeMixedTransfer(conn, payer, [
        { kind: "sol", to: Keypair.generate().publicKey, amount: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
      ]),
    ).rejects.toMatchObject({ code: "AMOUNT_OVERFLOW" });
  });

  it("leg validation: kind/mint mismatches and empty legs are structured errors", async () => {
    const { conn } = fakeConn({ mints: [] });
    const to = Keypair.generate().publicKey;
    await expect(
      executeMixedTransfer(conn, payer, [{ kind: "sol", to, amount: 1n, mint: Keypair.generate().publicKey }]),
    ).rejects.toMatchObject({ code: "MIXED_LEG_INVALID" });
    await expect(
      executeMixedTransfer(conn, payer, [{ kind: "token", to, amount: 1n, decimals: 6 }]),
    ).rejects.toMatchObject({ code: "MIXED_LEG_INVALID" });
    await expect(executeMixedTransfer(conn, payer, [])).rejects.toMatchObject({
      code: "LEGS_EMPTY",
    });
  });

  it("send failure returns parsed error instead of throwing", async () => {
    const fx = mixedFixture();
    const { conn } = fakeConn({
      mints: [{ mint: fx.splMint, owner: TOKEN_PROGRAM_ID }],
      existingAtas: fx.destAtas.slice(0, 1),
      sendRawTransaction: () =>
        Promise.reject(new Error("Error: insufficient funds for rent")),
    });
    const result = await executeMixedTransfer(conn, payer, fx.legs.slice(0, 2), {
      policy: { retries: 1 },
    });
    expect(result.error?.code).toBe("INSUFFICIENT_FUNDS");
    expect(result.signature).toBe("");
    expect(result.legs.length).toBe(2); // summaries still echo what was attempted
  });
});
