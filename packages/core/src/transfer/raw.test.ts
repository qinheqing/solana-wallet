/**
 * PRD T-D: raw transaction channel — offline round-trips for v0 and legacy
 * transactions plus simulate/send through the fake-connection seam.
 */
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { ClusterConnection } from "../connection/connection.js";
import { decodeRawTransaction, messageVersionOf, parseRawTransaction, sendRaw, signTransactionHex, simulateRaw } from "./raw.js";

const payer = Keypair.generate();
const second = Keypair.generate();
const dest = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const ZERO = "0".repeat(128);

/** Two-signer instruction set: payer pays, `second` also transfers. */
function twoSignerIxs() {
  return [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest, lamports: 1 }),
    SystemProgram.transfer({ fromPubkey: second.publicKey, toPubkey: dest, lamports: 2 }),
  ];
}

function v0Hex(): string {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: twoSignerIxs(),
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("hex");
}

function legacyHex(): string {
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: BLOCKHASH }).add(
    ...twoSignerIxs(),
  );
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("hex");
}

function fakeConn(cluster: "devnet" | "mainnet-beta" = "devnet") {
  const fake = {
    sendRawTransaction: vi.fn().mockResolvedValue("SIG_RAW"),
    simulateTransaction: vi.fn().mockResolvedValue({
      value: { err: null, logs: ["Program log: raw ok"], unitsConsumed: 77 },
    }),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null }, context: { slot: 7 } }),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: BLOCKHASH, lastValidBlockHeight: 9 }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
    // Raw transactions carry no lastValidBlockHeight → polling confirmation.
    getSignatureStatuses: vi.fn().mockResolvedValue({
      context: { slot: 7 },
      value: [{ slot: 7, confirmations: 1, err: null, confirmationStatus: "confirmed" }],
    }),
    isBlockhashValid: vi.fn().mockResolvedValue({ context: { slot: 7 }, value: true }),
  };
  const conn = new ClusterConnection(
    { cluster, rpcUrl: "https://example.invalid" },
    { connection: fake as unknown as Connection },
  );
  return { conn, fake };
}

describe("decode / parse", () => {
  it("detects hex vs base64 and reports it", () => {
    const hex = v0Hex();
    expect(decodeRawTransaction(hex).encoding).toBe("hex");
    const b64 = Buffer.from(hex, "hex").toString("base64");
    const decoded = decodeRawTransaction(b64);
    expect(decoded.encoding).toBe("base64");
    expect(Buffer.from(decoded.bytes).toString("hex")).toBe(hex);
    expect(parseRawTransaction(b64).kind).toBe("v0");
    expect(parseRawTransaction(legacyHex()).kind).toBe("legacy");
  });

  it("rejects garbage with RAW_TX_INVALID", () => {
    expect(() => decodeRawTransaction("")).toThrow(expect.objectContaining({ code: "RAW_TX_INVALID" }));
    expect(() => decodeRawTransaction("zz!!")).toThrow(expect.objectContaining({ code: "RAW_TX_INVALID" }));
    expect(() => parseRawTransaction("deadbeef")).toThrow(expect.objectContaining({ code: "RAW_TX_INVALID" }));
  });

  it("reports the message version without parsing", () => {
    expect(messageVersionOf(Buffer.from(v0Hex(), "hex"))).toBe(0);
    expect(messageVersionOf(Buffer.from(legacyHex(), "hex"))).toBe("legacy");
    expect(messageVersionOf(new Uint8Array([2]))).toBeUndefined();
  });

  it("rejects a v1 message prefix with UNSUPPORTED_TX_VERSION", () => {
    const bytes = Buffer.from(v0Hex(), "hex");
    // 2 signatures: compact-u16 count (1 byte) + 2 × 64 bytes, then the prefix.
    bytes[1 + 2 * 64] = 0x81;
    expect(() => parseRawTransaction(bytes.toString("hex"))).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED_TX_VERSION", message: expect.stringContaining("version 1") }),
    );
  });
});

describe("signTransactionHex", () => {
  it.each([
    ["v0", v0Hex],
    ["legacy", legacyHex],
  ])("%s: partial then full signing round-trips", (kind, make) => {
    const first = signTransactionHex(make(), [payer]);
    expect(first.kind).toBe(kind);
    expect(first.encoding).toBe("hex");
    expect(first.fullySigned).toBe(false);
    expect(first.signatures.map((s) => s.pubkey)).toEqual([
      payer.publicKey.toBase58(),
      second.publicKey.toBase58(),
    ]);
    expect(first.signatures[0]!.signatureHex).not.toBe(ZERO);
    expect(first.signatures[1]!.signatureHex).toBe(ZERO);
    expect(first.signedBy).toEqual([payer.publicKey.toBase58()]);

    // Second party signs the output of the first — the earlier signature survives.
    const done = signTransactionHex(first.txHex, [second]);
    expect(done.fullySigned).toBe(true);
    expect(done.signatures[0]!.signatureHex).toBe(first.signatures[0]!.signatureHex);
    expect(done.txBase64).toBe(Buffer.from(done.txHex, "hex").toString("base64"));

    // The bytes are a valid transaction whose message is unchanged.
    const tx = VersionedTransaction.deserialize(Buffer.from(done.txHex, "hex"));
    expect(tx.signatures).toHaveLength(2);
    expect(Buffer.from(tx.message.serialize()).toString("hex")).toBe(
      Buffer.from(VersionedTransaction.deserialize(Buffer.from(make(), "hex")).message.serialize()).toString("hex"),
    );
  });

  it("accepts base64 input and rejects a signer the message does not need", () => {
    const b64 = Buffer.from(v0Hex(), "hex").toString("base64");
    expect(signTransactionHex(b64, [payer]).encoding).toBe("base64");
    expect(() => signTransactionHex(b64, [Keypair.generate()])).toThrow(
      expect.objectContaining({ code: "SIGNER_NOT_REQUIRED" }),
    );
  });
});

describe("simulateRaw / sendRaw", () => {
  it("simulateRaw reuses the dry-run shape", async () => {
    const { conn, fake } = fakeConn();
    const res = await simulateRaw(conn, v0Hex());
    expect(res).toMatchObject({ ok: true, logs: ["Program log: raw ok"], unitsConsumed: 77, kind: "v0", encoding: "hex" });
    expect(fake.simulateTransaction).toHaveBeenCalledOnce();
  });

  it("sendRaw refuses partially signed payloads, sends fully signed ones", async () => {
    const { conn, fake } = fakeConn();
    const partial = signTransactionHex(v0Hex(), [payer]).txHex;
    await expect(sendRaw(conn, partial)).rejects.toMatchObject({ code: "TX_NOT_FULLY_SIGNED" });
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();

    const full = signTransactionHex(partial, [second]).txBase64;
    const sent = await sendRaw(conn, full);
    expect(sent).toMatchObject({ signature: "SIG_RAW", slot: 7, feeLamports: 5000, encoding: "base64", kind: "v0" });
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();
    // A raw transaction's lastValidBlockHeight is unknown: confirmation polls
    // the signature + isBlockhashValid instead of pairing it with a fresh blockhash.
    expect(fake.getSignatureStatuses).toHaveBeenCalledWith(["SIG_RAW"]);
    expect(fake.getLatestBlockhash).not.toHaveBeenCalled();
    expect(fake.confirmTransaction).not.toHaveBeenCalled();
  });

  it("sendRaw honours the mainnet guard", async () => {
    const { conn, fake } = fakeConn("mainnet-beta");
    const full = signTransactionHex(signTransactionHex(legacyHex(), [payer]).txHex, [second]).txHex;
    await expect(sendRaw(conn, full)).rejects.toMatchObject({ code: "MAINNET_NOT_ALLOWED" });
    expect(fake.sendRawTransaction).not.toHaveBeenCalled();
    await expect(sendRaw(conn, full, { allowMainnet: true })).resolves.toMatchObject({ signature: "SIG_RAW" });
  });
});
