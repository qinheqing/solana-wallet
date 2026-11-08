import {
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { describe, expect, it, vi } from "vitest";

// ESM named exports are non-configurable — vi.spyOn can't redefine
// node:fs/promises.readFile in place. Mock the module at the top level
// instead, delegating to the real implementation except where overridden.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

import { ClusterConnection } from "../connection/connection.js";
import {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  CPI_BATCH_TRANSFER_DISCRIMINANT,
  CPI_FORWARD_TRANSFER_CHECKED_DATA_BYTES,
  CPI_FORWARD_TRANSFER_CHECKED_DISCRIMINANT,
  CPI_INITIALIZE_VAULT_DATA_BYTES,
  CPI_INITIALIZE_VAULT_DISCRIMINANT,
  CPI_ITEM_BYTES,
  DEFAULT_DEPLOY_CHUNK_BYTES,
  buildCpiBatchTransferInstruction,
  buildCpiInitializeVaultInstruction,
  buildForwardTransferCheckedInstruction,
  cpiTokenTransfer,
  deployCpiProgram,
  executeCpiBatchTransfer,
  findCpiVaultPda,
  findProgramDataAddress,
  initializeCpiVault,
  serializeCpiBatchTransferData,
  serializeCpiForwardTransferCheckedData,
  serializeCpiInitializeVaultData,
} from "./cpi.js";

// Decoded v0 instruction `data` is a plain Uint8Array (no Buffer methods) —
// wrap it to read little-endian u32s without copying.
function u32le(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

// ---------------------------------------------------------------------------
// Fake connection (same pattern as transfer.test.ts).
// ---------------------------------------------------------------------------

function fakeConn(cluster: "devnet" | "mainnet-beta" = "devnet") {
  const fake = {
    getLatestBlockhash: vi
      .fn()
      .mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 999 }),
    sendRawTransaction: vi.fn().mockImplementation((_raw: Buffer) => {
      sentTransactions.push(_raw);
      return Promise.resolve(`SIG_${sentTransactions.length}`);
    }),
    simulateTransaction: vi.fn().mockResolvedValue({
      value: { err: null, logs: ["Program log: Simulated ok"], unitsConsumed: 4242 },
    }),
    confirmTransaction: vi
      .fn()
      .mockResolvedValue({ value: { err: null }, context: { slot: 42 } }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
    getMinimumBalanceForRentExemption: vi.fn().mockResolvedValue(1_000_000),
  };
  const sentTransactions: Buffer[] = [];
  const conn = new ClusterConnection(
    {
      cluster,
      rpcUrl:
        cluster === "mainnet-beta"
          ? "https://api.mainnet-beta.solana.com"
          : "https://api.devnet.solana.com",
    },
    { connection: fake as unknown as Connection },
  );
  return { conn, fake, sentTransactions };
}

/** Decode every sent raw transaction back into readable messages. */
function sentMessages(raws: readonly Buffer[]): VersionedTransaction[] {
  return raws.map((raw) => VersionedTransaction.deserialize(new Uint8Array(raw)));
}

const authority = Keypair.generate();
const programId = Keypair.generate().publicKey;
const r1 = Keypair.generate().publicKey;
const r2 = Keypair.generate().publicKey;

// ---------------------------------------------------------------------------
// Instruction-data serialization (round-trip / binary layout)
// ---------------------------------------------------------------------------

describe("serializeCpiBatchTransferData", () => {
  it("produces the exact documented binary layout", () => {
    const data = serializeCpiBatchTransferData([
      { to: r1, lamports: 1_000_000_000n },
      { to: r2, lamports: 42 },
    ]);
    expect(data.length).toBe(3 + 2 * CPI_ITEM_BYTES); // header + 2 × (32 + 8)
    expect(data.readUInt8(0)).toBe(CPI_BATCH_TRANSFER_DISCRIMINANT);
    expect(data.readUInt16LE(1)).toBe(2);
    // Item 0: raw pubkey bytes then u64 LE lamports.
    expect(data.subarray(3, 35).equals(r1.toBytes())).toBe(true);
    expect(data.readBigUInt64LE(35)).toBe(1_000_000_000n);
    // Item 1 immediately follows.
    expect(data.subarray(43, 75).equals(r2.toBytes())).toBe(true);
    expect(data.readBigUInt64LE(75)).toBe(42n);
  });

  it("round-trips mixed number/bigint lamports identically", () => {
    const viaNumber = serializeCpiBatchTransferData([{ to: r1, lamports: 7 }]);
    const viaBigint = serializeCpiBatchTransferData([{ to: r1, lamports: 7n }]);
    expect(viaNumber.equals(viaBigint)).toBe(true);
    expect(viaNumber.readBigUInt64LE(35)).toBe(7n);
  });

  it("rejects empty and negative inputs", () => {
    expect(() => serializeCpiBatchTransferData([])).toThrowError(
      expect.objectContaining({ code: "CPI_BATCH_EMPTY" }),
    );
    expect(() =>
      serializeCpiBatchTransferData([{ to: r1, lamports: -1n }]),
    ).toThrowError(expect.objectContaining({ code: "CPI_BATCH_INVALID_LAMPORTS" }));
  });
});

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

describe("findCpiVaultPda", () => {
  it("is deterministic and matches findProgramAddressSync([b'vault'])", () => {
    const a = findCpiVaultPda(programId);
    const b = findCpiVaultPda(programId);
    expect(a.vault.equals(b.vault)).toBe(true);
    expect(a.bump).toBe(b.bump);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      programId,
    );
    expect(a.vault.equals(expected)).toBe(true);
  });

  it("differs per program id", () => {
    const other = findCpiVaultPda(Keypair.generate().publicKey);
    expect(other.vault.equals(findCpiVaultPda(programId).vault)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Instruction construction
// ---------------------------------------------------------------------------

describe("buildCpiBatchTransferInstruction", () => {
  it("lays out accounts [authority(signer), vault, systemProgram, recipients…] and data", () => {
    const vault = findCpiVaultPda(programId).vault;
    const ix = buildCpiBatchTransferInstruction(programId, authority.publicKey, [
      { to: r1, lamports: 5n },
      { to: r2, lamports: 6n },
    ]);
    expect(ix.programId.equals(programId)).toBe(true);
    expect(ix.keys).toHaveLength(5);
    expect(ix.keys[0]).toMatchObject({
      pubkey: authority.publicKey,
      isSigner: true,
      isWritable: true,
    });
    expect(ix.keys[1]).toMatchObject({ pubkey: vault, isSigner: false, isWritable: true });
    expect(ix.keys[2]).toMatchObject({
      pubkey: SystemProgram.programId,
      isSigner: false,
      isWritable: false,
    });
    expect(ix.keys[3]).toMatchObject({ pubkey: r1, isSigner: false, isWritable: true });
    expect(ix.keys[4]).toMatchObject({ pubkey: r2, isSigner: false, isWritable: true });
    expect(ix.data.equals(serializeCpiBatchTransferData([
      { to: r1, lamports: 5n },
      { to: r2, lamports: 6n },
    ]))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// initialize_vault serialization + instruction construction
// ---------------------------------------------------------------------------

describe("serializeCpiInitializeVaultData", () => {
  it("produces the exact documented binary layout", () => {
    const data = serializeCpiInitializeVaultData(authority.publicKey);
    expect(data.length).toBe(CPI_INITIALIZE_VAULT_DATA_BYTES);
    expect(data.readUInt8(0)).toBe(CPI_INITIALIZE_VAULT_DISCRIMINANT);
    expect(data.subarray(1, 33).equals(authority.publicKey.toBytes())).toBe(true);
  });
});

describe("buildCpiInitializeVaultInstruction", () => {
  it("lays out accounts [payer(signer), vault, systemProgram] and data", () => {
    const vault = findCpiVaultPda(programId).vault;
    const payer = Keypair.generate().publicKey;
    const ix = buildCpiInitializeVaultInstruction(programId, payer, authority.publicKey);
    expect(ix.programId.equals(programId)).toBe(true);
    expect(ix.keys).toHaveLength(3);
    expect(ix.keys[0]).toMatchObject({ pubkey: payer, isSigner: true, isWritable: true });
    expect(ix.keys[1]).toMatchObject({ pubkey: vault, isSigner: false, isWritable: true });
    expect(ix.keys[2]).toMatchObject({
      pubkey: SystemProgram.programId,
      isSigner: false,
      isWritable: false,
    });
    expect(ix.data.equals(serializeCpiInitializeVaultData(authority.publicKey))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executeCpiBatchTransfer orchestration (fake connection, no real chain)
// ---------------------------------------------------------------------------

describe("executeCpiBatchTransfer", () => {
  it("derives the vault, sends one transaction, reports signature/slot/fee", async () => {
    const { conn, fake, sentTransactions } = fakeConn();
    const result = await executeCpiBatchTransfer(
      conn,
      authority,
      programId,
      [
        { to: r1, lamports: 1n },
        { to: r2, lamports: 2n },
      ],
      { policy: { retries: 1 } },
    );
    expect(result.signature).toBe("SIG_1");
    expect(result.slot).toBe(42);
    expect(result.feeLamports).toBe(5000);
    expect(result.vault).toBe(findCpiVaultPda(programId).vault.toBase58());
    expect(result.recipientCount).toBe(2);
    expect(result.totalLamports).toBe(3n);
    expect(result.simulatedOnly).toBe(false);
    expect(result.error).toBeUndefined();
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();

    // The single sent transaction carries exactly our CPI instruction. The
    // compiler re-sorts static account keys by (signer, writable) grouping,
    // so verify logical account order via the compiled instruction's own
    // accountKeyIndexes (matching our `keys` array order) rather than raw
    // staticAccountKeys positions.
    const [tx] = sentMessages(sentTransactions);
    const compiled = tx.message.compiledInstructions;
    expect(compiled).toHaveLength(1);
    const ix = compiled[0]!;
    const resolved = ix.accountKeyIndexes.map((i) => tx.message.staticAccountKeys[i]!);
    expect(tx.message.staticAccountKeys[ix.programIdIndex].equals(programId)).toBe(true);
    // account keys: payer, vault, system program, then both recipients
    expect(resolved[0]!.equals(authority.publicKey)).toBe(true);
    expect(resolved[1]!.equals(findCpiVaultPda(programId).vault)).toBe(true);
    expect(resolved[2]!.equals(SystemProgram.programId)).toBe(true);
    expect(resolved[3]!.equals(r1)).toBe(true);
    expect(resolved[4]!.equals(r2)).toBe(true);
  });

  it("dry-run simulates instead of sending and reports logs", async () => {
    const { conn, fake } = fakeConn();
    const result = await executeCpiBatchTransfer(
      conn,
      authority,
      programId,
      [{ to: r1, lamports: 1n }],
      { dryRun: true },
    );
    expect(result.simulatedOnly).toBe(true);
    expect(result.signature).toBe("");
    expect(result.logs).toEqual(["Program log: Simulated ok"]);
    expect(result.unitsConsumed).toBe(4242);
    expect(result.error).toBeUndefined();
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("dry-run returns a parsed error when simulation fails", async () => {
    const { conn, fake } = fakeConn();
    fake.simulateTransaction.mockResolvedValueOnce({
      value: { err: { InstructionError: [0, { Custom: 5 }] }, logs: ["Program log: unauthorized"] },
    });
    const result = await executeCpiBatchTransfer(
      conn,
      authority,
      programId,
      [{ to: r1, lamports: 1n }],
      { dryRun: true },
    );
    expect(result.simulatedOnly).toBe(true);
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe("SIMULATION_FAILED");
  });

  it("send failure returns a parsed error instead of throwing", async () => {
    const { conn, fake } = fakeConn();
    fake.sendRawTransaction.mockRejectedValueOnce(
      new Error("Error: insufficient funds for rent"),
    );
    const result = await executeCpiBatchTransfer(
      conn,
      authority,
      programId,
      [{ to: r1, lamports: 1n }],
      { policy: { retries: 1 } },
    );
    expect(result.signature).toBe("");
    expect(result.simulatedOnly).toBe(false);
    expect(result.error?.code).toBe("INSUFFICIENT_FUNDS");
  });
});

// ---------------------------------------------------------------------------
// initializeCpiVault orchestration (fake connection, no real chain)
// ---------------------------------------------------------------------------

describe("initializeCpiVault", () => {
  it("derives the vault, sends one transaction, reports signature/slot/fee", async () => {
    const { conn, fake, sentTransactions } = fakeConn();
    const payer = Keypair.generate();
    const result = await initializeCpiVault(
      conn,
      payer,
      programId,
      authority.publicKey,
      { policy: { retries: 1 } },
    );
    expect(result.signature).toBe("SIG_1");
    expect(result.slot).toBe(42);
    expect(result.feeLamports).toBe(5000);
    expect(result.vault).toBe(findCpiVaultPda(programId).vault.toBase58());
    expect(result.authority).toBe(authority.publicKey.toBase58());
    expect(result.simulatedOnly).toBe(false);
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();

    const [tx] = sentMessages(sentTransactions);
    const compiled = tx.message.compiledInstructions;
    expect(compiled).toHaveLength(1);
    const ix = compiled[0]!;
    const resolved = ix.accountKeyIndexes.map((i) => tx.message.staticAccountKeys[i]!);
    expect(tx.message.staticAccountKeys[ix.programIdIndex].equals(programId)).toBe(true);
    expect(resolved[0]!.equals(payer.publicKey)).toBe(true);
    expect(resolved[1]!.equals(findCpiVaultPda(programId).vault)).toBe(true);
    expect(resolved[2]!.equals(SystemProgram.programId)).toBe(true);
  });

  it("dry-run simulates instead of sending", async () => {
    const { conn, fake } = fakeConn();
    const payer = Keypair.generate();
    const result = await initializeCpiVault(conn, payer, programId, authority.publicKey, {
      dryRun: true,
    });
    expect(result.simulatedOnly).toBe(true);
    expect(result.signature).toBe("");
    expect(result.logs).toEqual(["Program log: Simulated ok"]);
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deployCpiProgram orchestration (fake connection)
// ---------------------------------------------------------------------------

describe("deployCpiProgram", () => {
  const elf = Buffer.alloc(DEFAULT_DEPLOY_CHUNK_BYTES + 100, 0xab); // 2 chunks

  it("refuses mainnet-beta before touching the RPC", async () => {
    const { conn, fake } = fakeConn("mainnet-beta");
    await expect(
      deployCpiProgram(conn, authority, elf, { policy: { retries: 1 } }),
    ).rejects.toMatchObject({ code: "MAINNET_NOT_ALLOWED" });
    expect(fake.getMinimumBalanceForRentExemption).not.toHaveBeenCalled();
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("forwards allowMainnet to every send (deploy on mainnet-beta succeeds when acknowledged)", async () => {
    const { conn, sentTransactions } = fakeConn("mainnet-beta");
    const result = await deployCpiProgram(conn, authority, elf, {
      allowMainnet: true,
      policy: { retries: 1 },
    });
    expect(sentTransactions).toHaveLength(5);
    expect(result.deploySignature).toBe("SIG_4");
  });

  it("the mainnet guard uses the genesis-hash probe for custom endpoints", async () => {
    const { conn, fake } = fakeConn();
    (conn as unknown as { target: { cluster: string } }).target.cluster = "custom";
    (fake as unknown as { getGenesisHash: unknown }).getGenesisHash = vi
      .fn()
      .mockResolvedValue("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
    await expect(
      deployCpiProgram(conn, authority, elf, { policy: { retries: 1 } }),
    ).rejects.toMatchObject({ code: "MAINNET_NOT_ALLOWED", message: expect.stringContaining("custom(mainnet-beta)") });
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("runs create+init → chunked writes → deploy → close", async () => {
    const { conn, sentTransactions } = fakeConn();
    const programKeypair = Keypair.generate();
    const bufferKeypair = Keypair.generate();
    const result = await deployCpiProgram(conn, authority, elf, {
      programKeypair,
      bufferKeypair,
      policy: { retries: 1 },
    });

    // 1 (create+init) + 2 (chunks) + 1 (deploy) + 1 (close) = 5 transactions.
    expect(sentTransactions).toHaveLength(5);
    expect(result.programId).toBe(programKeypair.publicKey.toBase58());
    expect(result.bufferPubkey).toBe(bufferKeypair.publicKey.toBase58());
    expect(result.bytesWritten).toBe(elf.length);
    expect(result.deploySignature).toBe("SIG_4");
    expect(result.closeBufferSignature).toBe("SIG_5");

    const txs = sentMessages(sentTransactions);

    // Tx 0: system CreateAccount for the buffer + loader InitializeBuffer(0).
    const tx0 = txs[0]!.message.compiledInstructions;
    expect(tx0[0]!.data[3]).toBe(0); // system CreateAccount discriminant (LE u32)
    expect(txs[0]!.message.staticAccountKeys[tx0[1]!.programIdIndex].equals(BPF_LOADER_UPGRADEABLE_PROGRAM_ID)).toBe(true);
    expect(u32le(tx0[1]!.data, 0)).toBe(0); // InitializeBuffer

    // Tx 1–2: loader Write(1) with sequential offsets and full payload bytes.
    const writes = [txs[1]!, txs[2]!].map((tx) => tx.message.compiledInstructions[0]!);
    for (const [i, ix] of writes.entries()) {
      expect(u32le(ix.data, 0)).toBe(1); // Write
      expect(u32le(ix.data, 4)).toBe(i * DEFAULT_DEPLOY_CHUNK_BYTES); // offset
      const len = u32le(ix.data, 8);
      const chunk = ix.data.subarray(12, 12 + len);
      const expected = elf.subarray(
        i * DEFAULT_DEPLOY_CHUNK_BYTES,
        i * DEFAULT_DEPLOY_CHUNK_BYTES + len,
      );
      expect(Buffer.from(chunk).equals(Buffer.from(expected))).toBe(true);
    }
    expect(u32le(writes[1]!.data, 8)).toBe(100); // second chunk is the remainder

    // Tx 3: system CreateAccount for the program + loader DeployWithMaxDataLen(2).
    const deployIxs = txs[3]!.message.compiledInstructions;
    expect(u32le(deployIxs[1]!.data, 0)).toBe(2);
    expect(u32le(deployIxs[1]!.data, 4)).toBe(elf.length); // maxDataLen
    expect(u32le(deployIxs[1]!.data, 8)).toBe(0); // padding slot
    // Deploy account keys include the derived programdata PDA.
    const keys = txs[3]!.message.staticAccountKeys;
    expect(keys.some((k) => k.equals(findProgramDataAddress(programKeypair.publicKey)))).toBe(true);

    // Tx 4: loader Close(5): [buffer(w) → recipient(payer, w), authority(signer)].
    const closeIx = txs[4]!.message.compiledInstructions[0]!;
    const closeKeys = txs[4]!.message.staticAccountKeys;
    expect(closeKeys[closeIx.accountKeyIndexes[0]!]!.equals(bufferKeypair.publicKey)).toBe(true);
    expect(closeKeys[closeIx.accountKeyIndexes[1]!]!.equals(authority.publicKey)).toBe(true);

    expect(conn.connection.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(
      37 + elf.length,
    );
  });

  it("accepts a .so file path", async () => {
    const { conn, sentTransactions } = fakeConn();
    const fakePath = "/tmp/fake-solwallet_cpi.so";
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from(elf));
    const result = await deployCpiProgram(conn, authority, fakePath, {
      policy: { retries: 1 },
    });
    expect(result.bytesWritten).toBe(elf.length);
    expect(sentTransactions).toHaveLength(5);
  });

  it("rejects empty program bytes", async () => {
    const { conn } = fakeConn();
    await expect(
      deployCpiProgram(conn, authority, Buffer.alloc(0), { policy: { retries: 1 } }),
    ).rejects.toMatchObject({ code: "CPI_DEPLOY_EMPTY_PROGRAM" });
  });
});

// ---------------------------------------------------------------------------
// forward_transfer_checked (PRD T-I)
// ---------------------------------------------------------------------------

describe("serializeCpiForwardTransferCheckedData", () => {
  it("produces the exact documented binary layout", () => {
    const data = serializeCpiForwardTransferCheckedData(1_234_567n, 6);
    expect(data.length).toBe(CPI_FORWARD_TRANSFER_CHECKED_DATA_BYTES);
    expect(data.readUInt8(0)).toBe(CPI_FORWARD_TRANSFER_CHECKED_DISCRIMINANT);
    expect(data.readBigUInt64LE(1)).toBe(1_234_567n);
    expect(data.readUInt8(9)).toBe(6);
  });

  it("rejects negative / oversized amounts and bad decimals", () => {
    expect(() => serializeCpiForwardTransferCheckedData(-1, 0)).toThrow(
      expect.objectContaining({ code: "CPI_FORWARD_INVALID_AMOUNT" }),
    );
    expect(() => serializeCpiForwardTransferCheckedData(1n << 64n, 0)).toThrow(
      expect.objectContaining({ code: "CPI_FORWARD_INVALID_AMOUNT" }),
    );
    expect(() => serializeCpiForwardTransferCheckedData(1, 256)).toThrow(
      expect.objectContaining({ code: "CPI_FORWARD_INVALID_DECIMALS" }),
    );
  });
});

describe("buildForwardTransferCheckedInstruction", () => {
  const mint = Keypair.generate().publicKey;
  const source = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;

  it("lays out [authority(s), source(w), mint, destination(w), tokenProgram] + extras", () => {
    const hook = Keypair.generate().publicKey;
    const ix = buildForwardTransferCheckedInstruction({
      programId,
      authority: authority.publicKey,
      source,
      mint,
      destination,
      tokenProgramId: TOKEN_2022_PROGRAM_ID,
      amount: 5,
      decimals: 2,
      extraAccounts: [{ pubkey: hook, isWritable: true }],
    });
    expect(ix.programId.equals(programId)).toBe(true);
    expect(ix.keys).toEqual([
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: hook, isSigner: false, isWritable: true },
    ]);
    expect(Buffer.from(ix.data).readUInt8(0)).toBe(CPI_FORWARD_TRANSFER_CHECKED_DISCRIMINANT);
    expect(Buffer.from(ix.data).readBigUInt64LE(1)).toBe(5n);
  });
});

describe("cpiTokenTransfer", () => {
  const mint = Keypair.generate().publicKey;
  const destOwner = Keypair.generate().publicKey;

  function withMint(conn: ReturnType<typeof fakeConn>, owner: PublicKey, destAtaExists: boolean) {
    const destAta = getAssociatedTokenAddressSync(mint, destOwner, true, owner);
    conn.fake.getAccountInfo = vi.fn().mockImplementation((addr: PublicKey) => {
      if (addr.equals(mint)) return Promise.resolve({ owner, data: Buffer.alloc(82) });
      if (destAtaExists && addr.equals(destAta)) {
        return Promise.resolve({ owner, data: Buffer.alloc(165) });
      }
      return Promise.resolve(null);
    });
    return destAta;
  }

  it("dryRun: resolves the token program, prepends idempotent ATA create, simulates only", async () => {
    const c = fakeConn();
    const destAta = withMint(c, TOKEN_PROGRAM_ID, false);
    const res = await cpiTokenTransfer(c.conn, {
      programId,
      from: authority,
      destination: destOwner,
      mint,
      amount: 1_000n,
      decimals: 6,
      dryRun: true,
    });
    expect(res.simulatedOnly).toBe(true);
    expect(res.signature).toBe("");
    expect(res.error).toBeUndefined();
    expect(res.program).toBe("spl-token");
    expect(res.destinationAtaCreated).toBe(true);
    expect(res.destinationAta).toBe(destAta.toBase58());
    expect(res.sourceAta).toBe(
      getAssociatedTokenAddressSync(mint, authority.publicKey, true, TOKEN_PROGRAM_ID).toBase58(),
    );
    expect(res.amount).toBe(1_000n);
    expect(res.logs).toEqual(["Program log: Simulated ok"]);
    expect(res.plan.instructions.map((i) => i.label)).toEqual([
      "createAssociatedTokenAccountIdempotent",
      "cpiForwardTransferChecked",
    ]);
    expect(res.plan.instructions[1]!.programId).toBe(programId.toBase58());
    expect(res.plan.instructions[1]!.accounts[4]!.pubkey).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(c.sentTransactions).toHaveLength(0);
    expect(c.fake.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("skips ATA creation when the destination ATA exists and uses Token-2022 for 2022 mints", async () => {
    const c = fakeConn();
    withMint(c, TOKEN_2022_PROGRAM_ID, true);
    const res = await cpiTokenTransfer(c.conn, {
      programId,
      from: authority,
      destination: destOwner,
      mint,
      amount: 7,
      decimals: 0,
      policy: { retries: 1 },
    });
    expect(res.error).toBeUndefined();
    expect(res.program).toBe("token-2022");
    expect(res.destinationAtaCreated).toBe(false);
    expect(res.plan.instructions).toHaveLength(1);
    expect(res.signature).toBe("SIG_1");
    expect(res.slot).toBe(42);
    const [tx] = sentMessages(c.sentTransactions);
    const ix = tx!.message.compiledInstructions[0]!;
    const keys = tx!.message.staticAccountKeys;
    expect(keys[ix.accountKeyIndexes[4]!]!.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it("refuses a missing destination ATA when allowAtaCreation is false", async () => {
    const c = fakeConn();
    withMint(c, TOKEN_PROGRAM_ID, false);
    await expect(
      cpiTokenTransfer(c.conn, {
        programId,
        from: authority,
        destination: destOwner,
        mint,
        amount: 1,
        decimals: 0,
        allowAtaCreation: false,
      }),
    ).rejects.toMatchObject({ code: "DESTINATION_ATA_MISSING" });
  });

  it("dryRun with a failing simulation returns the parsed error in-band", async () => {
    const c = fakeConn();
    withMint(c, TOKEN_PROGRAM_ID, true);
    c.fake.simulateTransaction.mockResolvedValueOnce({
      value: { err: { InstructionError: [0, { Custom: 8 }] }, logs: ["Program log: bad token program"], unitsConsumed: 1 },
    });
    const res = await cpiTokenTransfer(c.conn, {
      programId,
      from: authority,
      destination: destOwner,
      mint,
      amount: 1,
      decimals: 0,
      dryRun: true,
    });
    expect(res.simulatedOnly).toBe(true);
    expect(res.error).toBeDefined();
    expect(res.logs).toContain("Program log: bad token program");
  });
});
