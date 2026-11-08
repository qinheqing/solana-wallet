/**
 * PRD T-H: approveDelegate / revokeDelegate — instruction bytes, accounts,
 * program dispatch and in-band error reporting (fake connection).
 */
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { ClusterConnection } from "../connection/connection.js";
import { approveDelegate, revokeDelegate } from "./delegate.js";

const owner = Keypair.generate();
const delegate = Keypair.generate().publicKey;

function fakeConn(mintOwner: PublicKey, sendRawTransaction?: () => Promise<string>) {
  const mint = Keypair.generate().publicKey;
  const fake = {
    getAccountInfo: vi.fn().mockImplementation((addr: PublicKey) =>
      Promise.resolve(addr.equals(mint) ? { owner: mintOwner, data: Buffer.alloc(0) } : null),
    ),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 9 }),
    sendRawTransaction: vi.fn(sendRawTransaction ?? (() => Promise.resolve("SIG_TX"))),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null }, context: { slot: 42 } }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
  };
  const conn = new ClusterConnection({ cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" }, { connection: fake as unknown as Connection });
  return { conn, fake, mint };
}

/** Decode the single instruction of the transaction that was sent. */
function sentInstruction(fake: { sendRawTransaction: ReturnType<typeof vi.fn> }) {
  const raw = fake.sendRawTransaction.mock.calls[0]![0] as Uint8Array;
  const tx = VersionedTransaction.deserialize(raw);
  const msg = tx.message;
  expect(msg.compiledInstructions).toHaveLength(1);
  const ci = msg.compiledInstructions[0]!;
  return {
    programId: msg.staticAccountKeys[ci.programIdIndex]!,
    keys: ci.accountKeyIndexes.map((i) => msg.staticAccountKeys[i]!),
    data: Buffer.from(ci.data),
    signers: msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58()),
  };
}

describe("approveDelegate (T-H)", () => {
  it("Token-2022: ApproveChecked data [13, amount, decimals], accounts [ata, mint, delegate, owner(signer)]", async () => {
    const { conn, fake, mint } = fakeConn(TOKEN_2022_PROGRAM_ID);
    const res = await approveDelegate(conn, { owner, mint, delegate, amount: 1_500n, decimals: 6 });
    expect(res.error).toBeUndefined();
    expect(res.signature).toBe("SIG_TX");
    expect(res.slot).toBe(42);
    expect(res.feeLamports).toBe(5000);
    expect(res.program).toBe("token-2022");
    const ata = getAssociatedTokenAddressSync(mint, owner.publicKey, true, TOKEN_2022_PROGRAM_ID);
    expect(res.tokenAccount).toBe(ata.toBase58());

    const ix = sentInstruction(fake);
    expect(ix.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    const expected = Buffer.alloc(10);
    expected[0] = 13;
    expected.writeBigUInt64LE(1_500n, 1);
    expected[9] = 6;
    expect(ix.data.equals(expected)).toBe(true);
    expect(ix.keys.map((k) => k.toBase58())).toEqual([
      ata.toBase58(),
      mint.toBase58(),
      delegate.toBase58(),
      owner.publicKey.toBase58(),
    ]);
    expect(ix.signers).toEqual([owner.publicKey.toBase58()]);
  });

  it("classic SPL mint dispatches to the Token program and accepts string addresses", async () => {
    const { conn, fake, mint } = fakeConn(TOKEN_PROGRAM_ID);
    const res = await approveDelegate(conn, { owner, mint: mint.toBase58(), delegate: delegate.toBase58(), amount: 1n, decimals: 0 });
    expect(res.program).toBe("spl-token");
    expect(sentInstruction(fake).programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  it("rejects a zero allowance before touching the network; unknown mint → MINT_NOT_FOUND", async () => {
    const { conn, fake } = fakeConn(TOKEN_PROGRAM_ID);
    await expect(approveDelegate(conn, { owner, mint: Keypair.generate().publicKey, delegate, amount: 0n, decimals: 6 }))
      .rejects.toMatchObject({ code: "AMOUNT_ZERO_OR_NEGATIVE" });
    expect(fake.getAccountInfo).not.toHaveBeenCalled();
    await expect(approveDelegate(conn, { owner, mint: Keypair.generate().publicKey, delegate, amount: 1n, decimals: 6 }))
      .rejects.toMatchObject({ code: "MINT_NOT_FOUND" });
  });

  it("send failure is returned in-band as a parsed error, not thrown", async () => {
    const { conn, mint } = fakeConn(TOKEN_PROGRAM_ID, () => Promise.reject(new Error("Error: insufficient funds for rent")));
    const res = await approveDelegate(conn, { owner, mint, delegate, amount: 1n, decimals: 6, policy: { retries: 1 } });
    expect(res.error?.code).toBe("INSUFFICIENT_FUNDS");
    expect(res.signature).toBe("");
    expect(res.tokenAccount).toBe(getAssociatedTokenAddressSync(mint, owner.publicKey).toBase58());
  });
});

describe("revokeDelegate (T-H)", () => {
  it("Revoke data [5], accounts [ata, owner(signer)]", async () => {
    const { conn, fake, mint } = fakeConn(TOKEN_2022_PROGRAM_ID);
    const res = await revokeDelegate(conn, { owner, mint });
    expect(res.error).toBeUndefined();
    expect(res.signature).toBe("SIG_TX");
    const ata = getAssociatedTokenAddressSync(mint, owner.publicKey, true, TOKEN_2022_PROGRAM_ID);
    expect(res.tokenAccount).toBe(ata.toBase58());
    const ix = sentInstruction(fake);
    expect(ix.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect([...ix.data]).toEqual([5]);
    expect(ix.keys.map((k) => k.toBase58())).toEqual([ata.toBase58(), owner.publicKey.toBase58()]);
    expect(ix.signers).toEqual([owner.publicKey.toBase58()]);
  });
});
