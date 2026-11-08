/**
 * PRD T-B: construction knobs + TransactionPlan. Offline — fake connection.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { ClusterConnection } from "../connection/connection.js";
import {
  buildTransferInstructions,
  buildTransferPlan,
  MEMO_PROGRAM_ID,
  type BuildTransferOptions,
} from "./build.js";
import { describeInstructions, planFromInstructions } from "./plan.js";
import { transfer } from "./transfer.js";

const payer = Keypair.generate();
const recipient = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

function fakeConn(opts: {
  mint?: PublicKey;
  mintOwner?: PublicKey;
  existingAtas?: string[];
  sourceOwner?: PublicKey;
} = {}) {
  const accounts = new Map<string, { owner: PublicKey }>();
  const mint = opts.mint ?? Keypair.generate().publicKey;
  const mintOwner = opts.mintOwner ?? TOKEN_PROGRAM_ID;
  accounts.set(mint.toBase58(), { owner: mintOwner });
  const sourceOwner = opts.sourceOwner ?? payer.publicKey;
  accounts.set(getAssociatedTokenAddressSync(mint, sourceOwner, true, mintOwner).toBase58(), {
    owner: sourceOwner,
  });
  for (const ata of opts.existingAtas ?? []) accounts.set(ata, { owner: PublicKey.default });

  const fake = {
    getAccountInfo: vi.fn().mockImplementation((addr: PublicKey) => {
      const hit = accounts.get(addr.toBase58());
      return Promise.resolve(hit ? { owner: hit.owner, data: Buffer.alloc(0) } : null);
    }),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: BLOCKHASH, lastValidBlockHeight: 9 }),
    sendRawTransaction: vi.fn().mockResolvedValue("SIG_TX"),
    simulateTransaction: vi.fn().mockResolvedValue({
      value: { err: null, logs: ["ok"], unitsConsumed: 1 },
    }),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null }, context: { slot: 42 } }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
  };
  const conn = new ClusterConnection(
    { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" },
    { connection: fake as unknown as Connection },
  );
  return { conn, fake, mint };
}

const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

function tokenOpts(mint: PublicKey, extra: Partial<BuildTransferOptions> = {}): BuildTransferOptions {
  return { payer: payer.publicKey, destination: recipient, mint, amount: 1_000n, decimals: 6, ...extra };
}

describe("buildTransferInstructions knobs (T-B)", () => {
  it("defaults: unchanged shape, labels parallel to instructions", async () => {
    const { conn, mint } = fakeConn();
    const built = await buildTransferInstructions(conn, tokenOpts(mint));
    expect(built.labels).toEqual(["createAssociatedTokenAccountIdempotent", "transferChecked"]);
    expect(built.instructions).toHaveLength(2);
    // transferChecked data = [12, amount u64 LE, decimals]
    const data = Buffer.from(built.instructions[1]!.data);
    expect(data).toEqual(Buffer.concat([Buffer.from([12]), u64le(1_000n), Buffer.from([6])]));
    // CreateIdempotent data = [1]
    expect(Buffer.from(built.instructions[0]!.data)).toEqual(Buffer.from([1]));
  });

  it("SOL default: single systemTransfer", async () => {
    const { conn } = fakeConn();
    const built = await buildTransferInstructions(conn, {
      payer: payer.publicKey,
      destination: recipient,
      amount: 5n,
    });
    expect(built.labels).toEqual(["systemTransfer"]);
  });

  it("computeBudget: limit then price prepended, discriminators 2 and 3", async () => {
    const { conn, mint } = fakeConn();
    const built = await buildTransferInstructions(
      conn,
      tokenOpts(mint, { computeBudget: { unitLimit: 200_000, unitPrice: 1_000 }, ataMode: "none" }),
    );
    expect(built.labels).toEqual(["setComputeUnitLimit", "setComputeUnitPrice", "transferChecked"]);
    expect(built.instructions[0]!.programId).toEqual(ComputeBudgetProgram.programId);
    expect(built.instructions[0]!.data[0]).toBe(2);
    expect(built.instructions[1]!.data[0]).toBe(3);

    const onlyPrice = await buildTransferInstructions(
      conn,
      tokenOpts(mint, { computeBudget: { unitPrice: 7 }, ataMode: "none" }),
    );
    expect(onlyPrice.labels).toEqual(["setComputeUnitPrice", "transferChecked"]);
  });

  it("computeBudget + memo also work for SOL", async () => {
    const { conn } = fakeConn();
    const built = await buildTransferInstructions(conn, {
      payer: payer.publicKey,
      destination: recipient,
      amount: 5n,
      computeBudget: { unitLimit: 1 },
      memo: "hi",
    });
    expect(built.labels).toEqual(["setComputeUnitLimit", "memo", "systemTransfer"]);
    expect(built.instructions[2]!.programId).toEqual(SystemProgram.programId);
  });

  it("ataMode always-idempotent: creation added even when the ATA exists, but reported as not created", async () => {
    const mint = Keypair.generate().publicKey;
    const destAta = getAssociatedTokenAddressSync(mint, recipient, true, TOKEN_PROGRAM_ID);
    const { conn, fake } = fakeConn({ mint, existingAtas: [destAta.toBase58()] });
    const built = await buildTransferInstructions(conn, tokenOpts(mint, { ataMode: "always-idempotent" }));
    expect(built.labels).toEqual(["createAssociatedTokenAccountIdempotent", "transferChecked"]);
    // The idempotent create is a no-op on an existing account → nothing is created.
    expect(built.destinationAtaCreated).toBe(false);
    expect(built.destinationAtaExisted).toBe(true);
    expect(built.destinationAta).toEqual(destAta);
    // Exactly one lookup of the destination ATA decides that.
    const looked = fake.getAccountInfo.mock.calls.map((c) => (c[0] as PublicKey).toBase58());
    expect(looked.filter((a) => a === destAta.toBase58())).toHaveLength(1);
  });

  it("ataMode always-idempotent on a missing ATA → created: true", async () => {
    const { conn, mint } = fakeConn();
    const built = await buildTransferInstructions(conn, tokenOpts(mint, { ataMode: "always-idempotent" }));
    expect(built.labels[0]).toBe("createAssociatedTokenAccountIdempotent");
    expect(built.destinationAtaCreated).toBe(true);
    expect(built.destinationAtaExisted).toBe(false);
  });

  it("ataMode create: non-idempotent Create with empty data; existing ATA → created: false (fails on chain)", async () => {
    const { conn, mint } = fakeConn();
    const built = await buildTransferInstructions(conn, tokenOpts(mint, { ataMode: "create" }));
    expect(built.labels[0]).toBe("createAssociatedTokenAccount");
    expect(built.instructions[0]!.programId).toEqual(ASSOCIATED_TOKEN_PROGRAM_ID);
    expect(built.instructions[0]!.data).toHaveLength(0);
    expect(built.destinationAtaCreated).toBe(true);
    expect(built.destinationAtaExisted).toBe(false);

    const mint2 = Keypair.generate().publicKey;
    const destAta = getAssociatedTokenAddressSync(mint2, recipient, true, TOKEN_PROGRAM_ID);
    const existing = fakeConn({ mint: mint2, existingAtas: [destAta.toBase58()] });
    const clash = await buildTransferInstructions(existing.conn, tokenOpts(mint2, { ataMode: "create" }));
    expect(clash.labels[0]).toBe("createAssociatedTokenAccount");
    expect(clash.destinationAtaCreated).toBe(false);
    expect(clash.destinationAtaExisted).toBe(true);
  });

  it("ataMode none: no creation, no lookup, no ATA_MISSING even when missing", async () => {
    const { conn, mint, fake } = fakeConn();
    const built = await buildTransferInstructions(conn, tokenOpts(mint, { ataMode: "none" }));
    expect(built.labels).toEqual(["transferChecked"]);
    expect(built.destinationAtaCreated).toBe(false);
    expect(built.destinationAtaExisted).toBeNull();
    const destAta = getAssociatedTokenAddressSync(mint, recipient, true, TOKEN_PROGRAM_ID).toBase58();
    expect(fake.getAccountInfo.mock.calls.map((c) => (c[0] as PublicKey).toBase58())).not.toContain(destAta);
  });

  it("preloaded accounts skip every RPC read the caller already did", async () => {
    const mint = Keypair.generate().publicKey;
    const destAta = getAssociatedTokenAddressSync(mint, recipient, true, TOKEN_PROGRAM_ID);
    const { conn, fake } = fakeConn({ mint, existingAtas: [destAta.toBase58()] });
    const built = await buildTransferInstructions(conn, tokenOpts(mint, {}), {
      mintProgram: { kind: "spl-token", programId: TOKEN_PROGRAM_ID },
      sourceExists: true,
      destinationExists: false, // caller's view wins: creation is added
    });
    expect(fake.getAccountInfo).not.toHaveBeenCalled();
    expect(built.labels).toEqual(["createAssociatedTokenAccountIdempotent", "transferChecked"]);
    expect(built.destinationAtaCreated).toBe(true);
    expect(built.destinationAtaExisted).toBe(false);
  });

  it("allowAtaCreation:false still throws ATA_MISSING in auto mode; conflicts with create modes", async () => {
    const { conn, mint } = fakeConn();
    await expect(
      buildTransferInstructions(conn, tokenOpts(mint, { allowAtaCreation: false })),
    ).rejects.toMatchObject({ code: "ATA_MISSING" });
    await expect(
      buildTransferInstructions(conn, tokenOpts(mint, { allowAtaCreation: false, ataMode: "create" })),
    ).rejects.toMatchObject({ code: "ATA_MODE_CONFLICT" });
  });

  it("instruction transfer: legacy Transfer data [3, amount]", async () => {
    const { conn, mint } = fakeConn();
    const built = await buildTransferInstructions(conn, tokenOpts(mint, { instruction: "transfer", ataMode: "none" }));
    expect(built.labels).toEqual(["transfer"]);
    expect(Buffer.from(built.instructions[0]!.data)).toEqual(
      Buffer.concat([Buffer.from([3]), u64le(1_000n)]),
    );
  });

  it("instruction transferCheckedWithFee: requires fee; data [26, 1, amount, decimals, fee]", async () => {
    const mint = Keypair.generate().publicKey;
    const { conn } = fakeConn({ mint, mintOwner: TOKEN_2022_PROGRAM_ID });
    await expect(
      buildTransferInstructions(conn, tokenOpts(mint, { instruction: "transferCheckedWithFee", ataMode: "none" })),
    ).rejects.toMatchObject({ code: "FEE_REQUIRED" });

    const built = await buildTransferInstructions(
      conn,
      tokenOpts(mint, { instruction: "transferCheckedWithFee", fee: 10n, ataMode: "none" }),
    );
    expect(built.labels).toEqual(["transferCheckedWithFee"]);
    expect(built.instructions[0]!.programId).toEqual(TOKEN_2022_PROGRAM_ID);
    expect(Buffer.from(built.instructions[0]!.data)).toEqual(
      Buffer.concat([Buffer.from([26, 1]), u64le(1_000n), Buffer.from([6]), u64le(10n)]),
    );

    await expect(
      buildTransferInstructions(conn, tokenOpts(mint, { fee: 1n, ataMode: "none" })),
    ).rejects.toMatchObject({ code: "FEE_UNEXPECTED" });
  });

  it("memo: Memo program ix immediately before the transfer, after ATA creation", async () => {
    const { conn, mint } = fakeConn();
    const built = await buildTransferInstructions(conn, tokenOpts(mint, { memo: "hello" }));
    expect(built.labels).toEqual(["createAssociatedTokenAccountIdempotent", "memo", "transferChecked"]);
    const memoIx = built.instructions[1]!;
    expect(memoIx.programId).toEqual(MEMO_PROGRAM_ID);
    expect(MEMO_PROGRAM_ID.toBase58()).toBe("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    expect(Buffer.from(memoIx.data).toString("utf8")).toBe("hello");
    expect(memoIx.keys[0]!.pubkey).toEqual(payer.publicKey);
  });

  it("authority + sourceOwner: source ATA from sourceOwner, authority signs, appears in plan.signers", async () => {
    const owner = Keypair.generate().publicKey;
    const delegate = Keypair.generate();
    const { conn, mint } = fakeConn({ sourceOwner: owner });
    const { built, plan } = await buildTransferPlan(conn, {
      ...tokenOpts(mint, { ataMode: "none", authority: delegate.publicKey, sourceOwner: owner }),
      blockhash: BLOCKHASH,
    });
    const ix = built.instructions[0]!;
    expect(ix.keys[0]!.pubkey).toEqual(getAssociatedTokenAddressSync(mint, owner, true));
    const auth = ix.keys.find((k) => k.pubkey.equals(delegate.publicKey));
    expect(auth?.isSigner).toBe(true);
    expect(plan.signers).toEqual([payer.publicKey.toBase58(), delegate.publicKey.toBase58()]);
    expect(plan.feePayer).toBe(payer.publicKey.toBase58());
  });

  it("sourceOwner without an ATA → SOURCE_ATA_MISSING", async () => {
    const { conn, mint } = fakeConn();
    await expect(
      buildTransferInstructions(conn, tokenOpts(mint, { sourceOwner: Keypair.generate().publicKey })),
    ).rejects.toMatchObject({ code: "SOURCE_ATA_MISSING" });
  });

  it("token-only knobs on a SOL transfer → OPTION_TOKEN_ONLY", async () => {
    const { conn } = fakeConn();
    await expect(
      buildTransferInstructions(conn, {
        payer: payer.publicKey,
        destination: recipient,
        amount: 1n,
        ataMode: "none",
      }),
    ).rejects.toMatchObject({ code: "OPTION_TOKEN_ONLY" });
  });
});

describe("TransactionPlan (T-B)", () => {
  it("describeInstructions: accounts, dataHex, labels with fallback", () => {
    const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports: 1 });
    const [d] = describeInstructions([ix], []);
    expect(d).toMatchObject({
      index: 0,
      label: "unknown",
      programId: SystemProgram.programId.toBase58(),
    });
    expect(d!.accounts).toEqual([
      { pubkey: payer.publicKey.toBase58(), isSigner: true, isWritable: true },
      { pubkey: recipient.toBase58(), isSigner: false, isWritable: true },
    ]);
    expect(d!.dataHex).toBe(Buffer.from(ix.data).toString("hex"));
  });

  it("buildTransferPlan: messageHex round-trips, estimatedBytes = wire size, fetches blockhash when absent", async () => {
    const { conn, mint, fake } = fakeConn();
    const { built, plan } = await buildTransferPlan(conn, tokenOpts(mint, { memo: "m" }));
    expect(fake.getLatestBlockhash).toHaveBeenCalledOnce();
    expect(plan.blockhash).toBe(BLOCKHASH);
    expect(plan.instructions.map((i) => i.label)).toEqual(built.labels);
    expect(plan.signers).toEqual([payer.publicKey.toBase58()]);

    const { message } = planFromInstructions(payer.publicKey, BLOCKHASH, built.instructions, built.labels);
    expect(plan.messageHex).toBe(Buffer.from(message.serialize()).toString("hex"));
    expect(plan.estimatedBytes).toBe(new VersionedTransaction(message).serialize().length);
    expect(plan.estimatedBytes).toBe(1 + 64 + message.serialize().length);
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("transfer() with knobs (T-B)", () => {
  it("result carries plan; extraSigners satisfies a foreign authority", async () => {
    const owner = Keypair.generate().publicKey;
    const delegate = Keypair.generate();
    const { conn, mint, fake } = fakeConn({ sourceOwner: owner });
    const result = await transfer(conn, {
      from: payer,
      destination: recipient,
      mint,
      amount: 1n,
      decimals: 6,
      ataMode: "none",
      memo: "x",
      authority: delegate.publicKey,
      sourceOwner: owner,
      extraSigners: [delegate],
    });
    expect(result.error).toBeUndefined();
    expect(result.signature).toBe("SIG_TX");
    expect(result.plan.instructions.map((i) => i.label)).toEqual(["memo", "transferChecked"]);
    expect(result.plan.signers).toContain(delegate.publicKey.toBase58());
    // The sent bytes carry two real signatures.
    const raw = fake.sendRawTransaction.mock.calls[0]![0] as Uint8Array;
    const tx = VersionedTransaction.deserialize(raw);
    expect(tx.signatures).toHaveLength(2);
    expect(tx.signatures.every((s) => s.some((b) => b !== 0))).toBe(true);
  });

  it("foreign authority without its keypair → SIGNER_MISSING before any send", async () => {
    const owner = Keypair.generate().publicKey;
    const { conn, mint, fake } = fakeConn({ sourceOwner: owner });
    await expect(
      transfer(conn, {
        from: payer,
        destination: recipient,
        mint,
        amount: 1n,
        decimals: 6,
        ataMode: "none",
        authority: Keypair.generate().publicKey,
        sourceOwner: owner,
      }),
    ).rejects.toMatchObject({ code: "SIGNER_MISSING" });
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("dry-run result also carries plan", async () => {
    const { conn } = fakeConn();
    const result = await transfer(conn, { from: payer, destination: recipient, amount: 1n, dryRun: true });
    expect(result.simulatedOnly).toBe(true);
    expect(result.plan.instructions[0]!.label).toBe("systemTransfer");
  });
});
