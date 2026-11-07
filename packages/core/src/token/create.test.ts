/**
 * Task #8 tests: SPL + Token-2022 mint creation. Uses the fake-connection
 * pattern from transfer.test.ts: a deterministic account registry behind a
 * mocked web3.js Connection, with instruction-object assertions (program
 * id / key layout / order) — no serialization needed.
 */
import { ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMintLen } from "@solana/spl-token";
import { pack } from "@solana/spl-token-metadata";
import {
  Keypair,
  SystemProgram,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { ClusterConnection } from "../connection/connection.js";
import { createSplToken, createToken2022 } from "./create.js";

// ---------------------------------------------------------------------------
// Fake connection (no mint registry needed — creation touches fresh keys).
// ---------------------------------------------------------------------------

const payer = Keypair.generate();

function fakeConn() {
  const fake = {
    getAccountInfo: vi.fn().mockResolvedValue(null),
    getLatestBlockhash: vi
      .fn()
      .mockResolvedValue({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 999,
      }),
    sendRawTransaction: vi.fn().mockResolvedValue("SIG_MINT"),
    simulateTransaction: vi.fn().mockResolvedValue({
      value: { err: null, logs: ["Program log: ok"], unitsConsumed: 2000 },
    }),
    confirmTransaction: vi
      .fn()
      .mockResolvedValue({ value: { err: null }, context: { slot: 7 } }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
    getMinimumBalanceForRentExemption: vi.fn().mockResolvedValue(1_500_000),
  };
  const conn = new ClusterConnection(
    { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" },
    { connection: fake as unknown as Connection },
  );
  return { conn, fake };
}

/**
 * The compiled v0 message hides instructions behind serialization — decode
 * them back from the recorded raw transaction for object-level assertions.
 */
function decodeInstructions(tx: VersionedTransaction): TransactionInstruction[] {
  return tx.message.compiledInstructions.map((ci) => {
    const programId = tx.message.staticAccountKeys[ci.programIdIndex];
    return {
      programId,
      keys: ci.accountKeyIndexes.map((i) => ({
        pubkey: tx.message.staticAccountKeys[i],
        isSigner: tx.message.isAccountSigner(i),
        isWritable: tx.message.isAccountWritable(i),
      })),
      data: Buffer.from(ci.data),
    } as TransactionInstruction;
  });
}

/** fakeConn variant that records every sent transaction for decoding. */
function recordingConn() {
  const base = fakeConn();
  const txs: VersionedTransaction[] = [];
  base.fake.sendRawTransaction.mockImplementation((raw: Uint8Array) => {
    txs.push(VersionedTransaction.deserialize(raw));
    return Promise.resolve("SIG_MINT");
  });
  return { ...base, txs };
}

describe("createSplToken (8.1)", () => {
  it("builds createAccount + initializeMint on the SPL Token program", async () => {
    const { conn, txs, fake } = recordingConn();
    const result = await createSplToken(conn, payer, { decimals: 6 });
    expect(result.mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(result.extensions).toEqual([]);
    expect(result.signature).toBe("SIG_MINT");
    expect(result.slot).toBe(7);
    expect(result.feeLamports).toBe(5000);
    expect(txs).toHaveLength(1);
    const ixs = decodeInstructions(txs[0]!);
    expect(ixs).toHaveLength(2);
    expect(ixs[0]!.programId).toEqual(SystemProgram.programId);
    expect(ixs[1]!.programId).toEqual(TOKEN_PROGRAM_ID);
    // initializeMint data: [InitializeMint=0, decimals, ...]
    expect(ixs[1]!.data[0]).toBe(0);
    expect(ixs[1]!.data[1]).toBe(6);
    expect(fake.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(82);
  });

  it("defaults authorities to the payer", async () => {
    const { conn, txs } = recordingConn();
    await createSplToken(conn, payer, { decimals: 9 });
    const ixs = decodeInstructions(txs[0]!);
    const mintKey = ixs[0]!.keys[1]!.pubkey; // createAccount newAccountPubkey
    expect(mintKey).toBeDefined();
    // initializeMint carries authorities in DATA: [0, decimals, mintAuthority(32), option, ...]
    const data = ixs[1]!.data;
    expect(data[1]).toBe(9);
    expect(data.subarray(2, 34).equals(payer.publicKey.toBuffer())).toBe(true);
  });

  it("rejects decimals out of bounds with a structured error", async () => {
    const { conn } = recordingConn();
    await expect(createSplToken(conn, payer, { decimals: -1 })).rejects.toMatchObject({ code: "DECIMALS_INVALID" });
    await expect(createSplToken(conn, payer, { decimals: 19 })).rejects.toMatchObject({ code: "DECIMALS_INVALID" });
    await expect(createSplToken(conn, payer, { decimals: 2.5 })).rejects.toMatchObject({ code: "DECIMALS_INVALID" });
  });

  it("dryRun simulates and never sends", async () => {
    const { conn, fake } = recordingConn();
    const result = await createSplToken(conn, payer, { decimals: 6, dryRun: true });
    expect(result.simulatedOnly).toBe(true);
    expect(result.signature).toBe("");
    expect(result.logs).toContain("Program log: ok");
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("createToken2022 (8.2–8.4)", () => {
  it("no extensions → createAccount + initializeMint2 only", async () => {
    const { conn, txs } = recordingConn();
    const result = await createToken2022(conn, payer, { decimals: 9 });
    expect(result.extensions).toEqual([]);
    const ixs = decodeInstructions(txs[0]!);
    expect(ixs).toHaveLength(2);
    expect(ixs[0]!.programId).toEqual(SystemProgram.programId);
    expect(ixs[1]!.programId).toEqual(TOKEN_2022_PROGRAM_ID);
    expect(ixs[1]!.data[0]).toBe(20); // TokenInstruction.InitializeMint2
  });

  it("transferFeeConfig → 3 instructions, fee params encoded", async () => {
    const { conn, txs, fake } = recordingConn();
    const result = await createToken2022(conn, payer, {
      decimals: 6,
      extensions: { transferFeeConfig: { transferFeeBasisPoints: 250, maximumFee: 1000n } },
    });
    expect(result.extensions).toEqual(["transferFeeConfig"]);
    const ixs = decodeInstructions(txs[0]!);
    expect(ixs).toHaveLength(3);
    expect(ixs[0]!.programId).toEqual(SystemProgram.programId);
    expect(ixs[1]!.programId).toEqual(TOKEN_2022_PROGRAM_ID);
    expect(ixs[2]!.data[0]).toBe(20); // InitializeMint2 last-but-metadata
    // space must cover the TransferFeeConfig extension
    const expectedSpace = getMintLen([ExtensionType.TransferFeeConfig]);
    expect(fake.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(expectedSpace);
  });

  it("transferHook + interestBearingConfig extension instructions", async () => {
    const { conn, txs } = recordingConn();
    const hook = Keypair.generate().publicKey;
    await createToken2022(conn, payer, {
      decimals: 2,
      extensions: {
        transferHook: { programId: hook },
        interestBearingConfig: { rate: 100 },
      },
    });
    const ixs = decodeInstructions(txs[0]!);
    // createAccount + 2 extension inits + initializeMint2
    expect(ixs).toHaveLength(4);
    expect(ixs.slice(1).every((ix) => ix.programId.equals(TOKEN_2022_PROGRAM_ID))).toBe(true);
    // Real opcodes: TransferHookExtension=36 (sub 0=Initialize),
    // InterestBearingMintExtension=33, InitializeMint2=20
    const opcodes = ixs.map((ix) => ix.data[0]);
    expect(opcodes).toEqual([0, 36, 33, 20]);
    expect(ixs[1]!.data[1]).toBe(0); // TransferHookInstruction.Initialize
  });

  it("nonTransferable + permanentDelegate + defaultAccountState", async () => {
    const { conn, txs } = recordingConn();
    const delegate = Keypair.generate().publicKey;
    await createToken2022(conn, payer, {
      decimals: 0,
      extensions: {
        nonTransferable: true,
        permanentDelegate: { delegate },
        defaultAccountState: { accountState: "frozen" },
      },
    });
    const ixs = decodeInstructions(txs[0]!);
    expect(ixs).toHaveLength(5); // createAccount + 3 ext inits + mint2
    // InitializeNonTransferableMint=32, InitializePermanentDelegate=35,
    // DefaultAccountStateExtension=28 (sub 0=Initialize), InitializeMint2=20
    expect(ixs.map((ix) => ix.data[0])).toEqual([0, 32, 35, 28, 20]);
  });

  it("tokenMetadata → pointer init + metadata init last, space includes TLV", async () => {
    const { conn, txs, fake } = recordingConn();
    await createToken2022(conn, payer, {
      decimals: 0,
      extensions: { tokenMetadata: { name: "Test Token", symbol: "TST", uri: "https://x.example/t.json" } },
    });
    const ixs = decodeInstructions(txs[0]!);
    // createAccount + metadataPointer init + initializeMint2 + metadata init
    expect(ixs).toHaveLength(4);
    // metadata init targets the Token-2022 program (it CPIs through it)
    expect(ixs[3]!.programId).toEqual(TOKEN_2022_PROGRAM_ID);
    expect(ixs[3]!.data.toString("utf8", 8)).toContain("Test Token");
    // Variable-length TokenMetadata goes through the second getMintLen param.
    const expectedSpace = getMintLen(
      [ExtensionType.MetadataPointer],
      {
        [ExtensionType.TokenMetadata]: pack({
          mint: Keypair.generate().publicKey, // length-only: same name/symbol/uri sizes
          updateAuthority: payer.publicKey,
          name: "Test Token",
          symbol: "TST",
          uri: "https://x.example/t.json",
          additionalMetadata: [],
        }).length,
      },
    );
    // mint pubkey length in TLV is identical for any 32-byte key
    expect(fake.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(expectedSpace);
  });

  it("all extensions combined in one transaction", async () => {
    const { conn, txs } = recordingConn();
    const result = await createToken2022(conn, payer, {
      decimals: 4,
      extensions: {
        transferFeeConfig: { transferFeeBasisPoints: 0, maximumFee: 0n },
        interestBearingConfig: { rate: 0 },
        permanentDelegate: { delegate: payer.publicKey },
        tokenMetadata: { name: "A", symbol: "B", uri: "" },
        defaultAccountState: { accountState: "frozen" },
      },
    });
    expect(result.extensions.sort()).toEqual(
      ["defaultAccountState", "interestBearingConfig", "permanentDelegate", "tokenMetadata", "transferFeeConfig"].sort(),
    );
    // createAccount + 4 ext inits (fee, interest, delegate, pointer) + mint2 + metadata init
    expect(txs[0]!.message.compiledInstructions).toHaveLength(8);
  });

  it("validates extension parameters with structured errors", async () => {
    const { conn } = recordingConn();
    await expect(
      createToken2022(conn, payer, {
        decimals: 6,
        extensions: { transferFeeConfig: { transferFeeBasisPoints: 10_001, maximumFee: 0n } },
      }),
    ).rejects.toMatchObject({ code: "TRANSFER_FEE_INVALID" });
    await expect(
      createToken2022(conn, payer, {
        decimals: 6,
        extensions: { transferFeeConfig: { transferFeeBasisPoints: 100, maximumFee: -5n } },
      }),
    ).rejects.toMatchObject({ code: "TRANSFER_FEE_INVALID" });
    await expect(
      createToken2022(conn, payer, {
        decimals: 6,
        extensions: { interestBearingConfig: { rate: 40_000 } },
      }),
    ).rejects.toMatchObject({ code: "INTEREST_RATE_INVALID" });
    await expect(
      createToken2022(conn, payer, {
        decimals: 6,
        extensions: { tokenMetadata: { name: "", symbol: "X", uri: "" } },
      }),
    ).rejects.toMatchObject({ code: "METADATA_INVALID" });
    await expect(
      createToken2022(conn, payer, {
        decimals: 6,
        extensions: {
          nonTransferable: true,
          transferFeeConfig: { transferFeeBasisPoints: 1, maximumFee: 0n },
        },
      }),
    ).rejects.toMatchObject({ code: "EXTENSIONS_INCOMPATIBLE" });
  });

  it("dryRun simulates the full extension pipeline", async () => {
    const { conn, fake } = recordingConn();
    const result = await createToken2022(conn, payer, {
      decimals: 6,
      dryRun: true,
      extensions: { transferFeeConfig: { transferFeeBasisPoints: 100, maximumFee: 1n } },
    });
    expect(result.simulatedOnly).toBe(true);
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
  });
});
