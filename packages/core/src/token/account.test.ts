/**
 * createTokenAccount — non-ATA token accounts. Offline, fake connection.
 */
import {
  ACCOUNT_SIZE,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccountLen,
} from "@solana/spl-token";
import { Keypair, SystemProgram, VersionedTransaction, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { ClusterConnection } from "../connection/connection.js";
import { ext, legacyMintInfo, mintBase, token2022MintInfo } from "../inspect/__fixtures__/accounts.js";
import { createTokenAccount } from "./account.js";

const payer = Keypair.generate();

function fakeConn(mintInfo: { owner: import("@solana/web3.js").PublicKey; data: Buffer }) {
  const mint = Keypair.generate().publicKey;
  const txs: VersionedTransaction[] = [];
  const fake = {
    getAccountInfo: vi.fn().mockImplementation((addr: import("@solana/web3.js").PublicKey) =>
      Promise.resolve(addr.equals(mint) ? { ...mintInfo, lamports: 1, executable: false } : null),
    ),
    getMinimumBalanceForRentExemption: vi.fn().mockImplementation((space: number) => Promise.resolve(space * 10)),
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 99,
    }),
    sendRawTransaction: vi.fn().mockImplementation((raw: Uint8Array) => {
      txs.push(VersionedTransaction.deserialize(raw));
      return Promise.resolve("SIG_ACCT");
    }),
    simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: ["ok"], unitsConsumed: 1 } }),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null }, context: { slot: 3 } }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
  };
  const conn = new ClusterConnection(
    { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" },
    { connection: fake as unknown as Connection },
  );
  return { conn, txs, mint };
}

const ixs = (tx: VersionedTransaction) =>
  tx.message.compiledInstructions.map((ci) => ({
    programId: tx.message.staticAccountKeys[ci.programIdIndex]!,
    keys: ci.accountKeyIndexes.map((i) => tx.message.staticAccountKeys[i]!),
    data: Buffer.from(ci.data),
  }));

describe("createTokenAccount", () => {
  it("SPL: createAccount(ACCOUNT_SIZE) + InitializeAccount3, signed by payer and the new account", async () => {
    const { conn, txs, mint } = fakeConn(legacyMintInfo(mintBase({ decimals: 6 })));
    const owner = Keypair.generate().publicKey;
    const res = await createTokenAccount(conn, payer, { mint, owner });
    expect(res).toMatchObject({
      signature: "SIG_ACCT",
      owner: owner.toBase58(),
      mint: mint.toBase58(),
      program: "spl-token",
      space: ACCOUNT_SIZE,
      rentLamports: ACCOUNT_SIZE * 10,
    });
    const [create, init] = ixs(txs[0]!);
    expect(create!.programId.equals(SystemProgram.programId)).toBe(true);
    expect(create!.keys[1]!.toBase58()).toBe(res.address);
    // SystemProgram.createAccount data: u32 ix, u64 lamports, u64 space, owner program
    expect(create!.data.readBigUInt64LE(12)).toBe(BigInt(ACCOUNT_SIZE));
    expect(create!.data.subarray(20, 52).equals(TOKEN_PROGRAM_ID.toBuffer())).toBe(true);
    expect(init!.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(init!.data[0]).toBe(18); // InitializeAccount3
    expect(init!.data.subarray(1, 33).equals(owner.toBuffer())).toBe(true);
    expect(txs[0]!.message.header.numRequiredSignatures).toBe(2);
  });

  it("Token-2022: sizes the account for the mint's extensions (TransferFeeConfig → TransferFeeAmount)", async () => {
    const authority = Keypair.generate().publicKey;
    const { conn, txs, mint } = fakeConn(
      token2022MintInfo(mintBase({ decimals: 6 }), [
        ext.transferFeeConfig({
          configAuthority: authority,
          withdrawAuthority: authority,
          withheld: 0n,
          older: { epoch: 0n, bps: 10, maxFee: 100n },
          newer: { epoch: 0n, bps: 10, maxFee: 100n },
        }),
      ]),
    );
    const res = await createTokenAccount(conn, payer, { mint });
    const expected = getAccountLen([ExtensionType.TransferFeeAmount]);
    expect(expected).toBeGreaterThan(ACCOUNT_SIZE);
    expect(res.space).toBe(expected);
    expect(res.program).toBe("token-2022");
    expect(res.owner).toBe(payer.publicKey.toBase58()); // default owner = payer
    expect(ixs(txs[0]!)[1]!.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it("uses a supplied account keypair and supports dryRun", async () => {
    const { conn, txs, mint } = fakeConn(legacyMintInfo(mintBase({})));
    const account = Keypair.generate();
    const res = await createTokenAccount(conn, payer, { mint, account }, { dryRun: true });
    expect(res.address).toBe(account.publicKey.toBase58());
    expect(res.simulatedOnly).toBe(true);
    expect(txs).toHaveLength(0);
  });
});
