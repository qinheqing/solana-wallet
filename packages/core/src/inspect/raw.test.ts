import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";
import { describe, expect, it, vi } from "vitest";

import { resolveClusterTarget } from "../connection/cluster.js";
import { ClusterConnection } from "../connection/connection.js";
import { decodeSignedTransaction, inspectSignedTransaction } from "./raw.js";

// Real signed testnet tx: ComputeBudget ×2 + System transfer of 0.005 SOL.
const RAW_B58 =
  "4HyFMSaVAQo5ZRVzZqJD5TNLk3tGxuv31AfonYmyHfQG2VUY7fuzM2LPZb7DYEd7ECneBgoSbQQq3fkuCMrXkLVCbBkKZjeuhnCokj9YFTDuhLtwdn9pYdVy6hjP9JgtjkbnjwF699riqBgca7vENPu2YfAxpNwxByHbDKTHzfonETwZ7RENFygGcUCABWpBeBJ4vE5fj1Jf33c5T9LYnTgDrfN2TTehgawcw9NBay9fFn6kNEiRsKoQzdAPSrwVF4D4xFbdm3r9M6qQpFfezi1Z9gbXCc6L5a8612KMRTDPVQ5Hv3cerFVxVVbshEdPEgSnbc4vPfqbsjG73KT5wUdbYNSEF9u8JQxmDEFqEvxF";
const SIG = "dGu577XYHRcJRg763xnSBKgafeBwxHPWg9DxcGAexzWJ6DL8VtmnGmKqTTeAKjDszkiT6W2wCq45avs4sNC1be9";
const PAYER = "6Y3n7Y5mH6X2XDeAecGdHCVR6r6kPZxJSJabd5kW98Vr";
const DEST = "J6ombbZhxhPBf11UPP2vdQZYKvcWB3NgcSDF27A1Hpfj";
const BLOCKHASH = "4mt7owqMB3u1aiJBMVxCkUYGhURkdGojMkXT5kLuXaCx";

describe("decodeSignedTransaction", () => {
  it("decodes the real base58 tx: signature verified, accounts flagged, all 3 instructions decoded", () => {
    const r = decodeSignedTransaction(RAW_B58);
    expect(r.encoding).toBe("base58");
    expect(r.version).toBe("legacy");
    expect(r.sizeBytes).toBe(267);
    expect(r.signature).toBe(SIG);
    expect(r.feePayer).toBe(PAYER);
    expect(r.recentBlockhash).toBe(BLOCKHASH);
    expect(r.signatures).toEqual([{ signer: PAYER, signature: SIG, valid: true }]);
    expect(r.fullySigned).toBe(true);
    expect(r.allSignaturesValid).toBe(true);
    expect(r.accounts.map((a) => [a.pubkey, a.signer, a.writable])).toEqual([
      [PAYER, true, true],
      [DEST, false, true],
      ["11111111111111111111111111111111", false, false],
      ["ComputeBudget111111111111111111111111111111", false, false],
    ]);
    expect(r.instructions.map((i) => [i.programName, i.decoded?.type])).toEqual([
      ["Compute Budget", "setComputeUnitLimit"],
      ["Compute Budget", "setComputeUnitPrice"],
      ["System Program", "transfer"],
    ]);
    expect(r.instructions[2]!.decoded!.info).toEqual({ source: PAYER, destination: DEST, lamports: "5000000" });
    expect(r.chain).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("accepts the same bytes as base64 and hex", () => {
    const bytes = Buffer.from(bs58.decode(RAW_B58));
    expect(decodeSignedTransaction(bytes.toString("base64")).encoding).toBe("base64");
    expect(decodeSignedTransaction(bytes.toString("hex")).signature).toBe(SIG);
    expect(decodeSignedTransaction(`0x${bytes.toString("hex")}`).encoding).toBe("hex");
  });

  it("flags a tampered message: signature present but invalid", () => {
    const bytes = bs58.decode(RAW_B58);
    bytes[bytes.length - 1] ^= 0x01; // flip a bit in the last instruction's data
    const r = decodeSignedTransaction(bs58.encode(bytes));
    expect(r.signatures[0]!.valid).toBe(false);
    expect(r.allSignaturesValid).toBe(false);
    expect(r.warnings.join("\n")).toMatch(/does NOT verify/);
  });

  it("rejects a bare signature and garbage with RAW_TX_INVALID", () => {
    expect(() => decodeSignedTransaction(SIG)).toThrow(expect.objectContaining({ code: "RAW_TX_INVALID" }));
    expect(() => decodeSignedTransaction("not a tx!")).toThrow(expect.objectContaining({ code: "RAW_TX_INVALID" }));
    expect(() => decodeSignedTransaction("  ")).toThrow(expect.objectContaining({ code: "RAW_TX_INVALID" }));
  });

  it("unsigned v0 tx with token / ATA / memo instructions and an unresolved lookup table", () => {
    const payer = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const src = Keypair.generate().publicKey;
    const dst = Keypair.generate().publicKey;
    const looked = Keypair.generate().publicKey;
    const table = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [looked] },
    });
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      createAssociatedTokenAccountIdempotentInstruction(payer, dst, owner, mint, TOKEN_2022_PROGRAM_ID),
      createTransferCheckedInstruction(src, mint, dst, payer, 1_500_000n, 6, [], TOKEN_2022_PROGRAM_ID),
      new TransactionInstruction({
        programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        keys: [],
        data: Buffer.from("hello 你好"),
      }),
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: looked, lamports: 1 }),
    ];
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message([table]);
    const tx = new VersionedTransaction(msg);
    const r = decodeSignedTransaction(Buffer.from(tx.serialize()).toString("base64"));

    expect(r.version).toBe(0);
    expect(r.signature).toBeNull();
    expect(r.fullySigned).toBe(false);
    expect(r.signatures).toEqual([{ signer: payer.toBase58(), signature: null, valid: null }]);
    expect(r.addressTableLookups).toHaveLength(1);
    const lookupAcct = r.accounts.find((a) => a.source === "lookup")!;
    expect(lookupAcct).toMatchObject({ pubkey: null, writable: true, lookup: { table: table.key.toBase58(), index: 0 } });

    const [cb, ata, xfer, memo, sol] = r.instructions;
    expect(cb!.decoded).toEqual({ type: "setComputeUnitLimit", info: { units: 200000 } });
    expect(ata!.decoded).toMatchObject({ type: "createIdempotent", info: { payer: payer.toBase58(), account: dst.toBase58(), mint: mint.toBase58() } });
    expect(xfer!.programName).toBe("Token-2022");
    expect(xfer!.decoded).toMatchObject({
      type: "transferChecked",
      info: { source: src.toBase58(), mint: mint.toBase58(), destination: dst.toBase58(), owner: payer.toBase58(), amount: "1500000", decimals: 6 },
    });
    expect(memo!.decoded).toEqual({ type: "memo", info: { memo: "hello 你好" } });
    // Touches an unresolved lookup account → not decoded, raw data kept.
    expect(sol!.decoded).toBeNull();
    expect(sol!.dataHex).toMatch(/^02000000/);
    expect(r.warnings.join("\n")).toMatch(/required signature/);
    expect(r.warnings.join("\n")).toMatch(/lookup tables/);

    // With the table resolved the System transfer decodes.
    const resolved = decodeSignedTransaction(Buffer.from(tx.serialize()).toString("base64"), {
      resolvedLookups: new Map([[table.key.toBase58(), [looked]]]),
    });
    expect(resolved.instructions[4]!.decoded).toMatchObject({ type: "transfer", info: { destination: looked.toBase58(), lamports: "1" } });
  });
});

describe("inspectSignedTransaction (fake RPC)", () => {
  it("not on chain + expired blockhash → not-found, blockhashValid false, warning", async () => {
    const fake = {
      getSignatureStatuses: vi.fn().mockResolvedValue({ value: [null] }),
      isBlockhashValid: vi.fn().mockResolvedValue({ value: false }),
    };
    const conn = new ClusterConnection(resolveClusterTarget("devnet"), { connection: fake as never });
    const r = await inspectSignedTransaction(RAW_B58, conn);
    expect(fake.getSignatureStatuses).toHaveBeenCalledWith([SIG], { searchTransactionHistory: true });
    expect(r.chain).toEqual({ status: "not-found", slot: null, err: null, blockhashValid: false });
    expect(r.warnings.join("\n")).toMatch(/not valid there/);
  });

  it("landed → status from RPC, blockhash not checked", async () => {
    const fake = {
      getSignatureStatuses: vi.fn().mockResolvedValue({ value: [{ slot: 460432607, confirmationStatus: "finalized", err: null, confirmations: null }] }),
      isBlockhashValid: vi.fn(),
    };
    const conn = new ClusterConnection(resolveClusterTarget("testnet"), { connection: fake as never });
    const r = await inspectSignedTransaction(RAW_B58, conn);
    expect(r.chain).toEqual({ status: "finalized", slot: 460432607, err: null, blockhashValid: null });
    expect(fake.isBlockhashValid).not.toHaveBeenCalled();
  });

  it("RPC failure degrades to a warning, decode still returned", async () => {
    const fake = { getSignatureStatuses: vi.fn().mockRejectedValue(new Error("boom")) };
    const conn = new ClusterConnection(resolveClusterTarget("devnet"), { connection: fake as never });
    const r = await inspectSignedTransaction(RAW_B58, conn);
    expect(r.chain).toBeNull();
    expect(r.instructions).toHaveLength(3);
    expect(r.warnings.join("\n")).toMatch(/boom/);
  });
});
