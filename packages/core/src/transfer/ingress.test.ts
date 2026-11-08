/**
 * PRD T-H: ingress-side scenarios end-to-end through transfer() on a fake
 * connection seeded with byte-faithful Token-2022 fixtures (so the preflight
 * really decodes the mint and source account). Each test pins the exact
 * instruction data, account roles and signer set.
 */
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { ClusterConnection } from "../connection/connection.js";
import {
  accountBase,
  ext,
  mintBase,
  token2022AccountInfo,
  token2022MintInfo,
  type TlvEntry,
} from "../inspect/__fixtures__/accounts.js";
import { MEMO_PROGRAM_ID } from "./build.js";
import { transfer, type TransferResult } from "./transfer.js";

const victim = Keypair.generate();
const delegateKp = Keypair.generate();
const recipient = Keypair.generate().publicKey;
const mintKey = Keypair.generate().publicKey;
const T22 = TOKEN_2022_PROGRAM_ID;
const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mintKey, owner, true, T22);

function seed(o: {
  mintExt?: TlvEntry[];
  sourceOwner?: PublicKey;
  delegate?: PublicKey;
  delegatedAmount?: bigint;
  destExists?: boolean;
}) {
  const reg = new Map<string, AccountInfo<Buffer>>();
  reg.set(mintKey.toBase58(), token2022MintInfo(mintBase({ decimals: 6 }), o.mintExt ?? []));
  const owner = o.sourceOwner ?? victim.publicKey;
  reg.set(
    ata(owner).toBase58(),
    token2022AccountInfo(
      accountBase({ mint: mintKey, owner, amount: 10_000n, delegate: o.delegate ?? null, delegatedAmount: o.delegatedAmount ?? 0n }),
      [ext.immutableOwner()],
    ),
  );
  if (o.destExists !== false) {
    reg.set(ata(recipient).toBase58(), token2022AccountInfo(accountBase({ mint: mintKey, owner: recipient }), [ext.immutableOwner()]));
  }
  const fake = {
    getAccountInfo: vi.fn().mockImplementation((addr: PublicKey) => Promise.resolve(reg.get(addr.toBase58()) ?? null)),
    getEpochInfo: vi.fn().mockResolvedValue({ epoch: 100, slotIndex: 0, slotsInEpoch: 432_000, absoluteSlot: 1 }),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 9 }),
    sendRawTransaction: vi.fn().mockResolvedValue("SIG_TX"),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null }, context: { slot: 42 } }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000n }),
  };
  const conn = new ClusterConnection({ cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" }, { connection: fake as unknown as Connection });
  return { conn, fake };
}

const codes = (r: TransferResult) => r.preflight?.findings.map((f) => f.code) ?? [];
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const hex = (...parts: Array<number | Buffer>) =>
  Buffer.concat(parts.map((p) => (typeof p === "number" ? Buffer.from([p]) : p))).toString("hex");

/** Shared shape: delegate pays, victim's ATA is the source, delegate signs as authority. */
const delegated = {
  from: delegateKp,
  sourceOwner: victim.publicKey,
  authority: delegateKp.publicKey,
  destination: recipient,
  mint: mintKey,
  amount: 1_000n,
  decimals: 6,
};

describe("ingress scenarios through transfer() (T-H)", () => {
  it("delegate transfer: authority account is the delegate, only the delegate signs", async () => {
    const { conn, fake } = seed({ delegate: delegateKp.publicKey, delegatedAmount: 5_000n });
    const res = await transfer(conn, delegated);
    expect(res.error).toBeUndefined();
    expect(res.signature).toBe("SIG_TX");
    expect(codes(res)).toContain("DELEGATE_TRANSFER");
    expect(codes(res)).toContain("NON_STANDARD_CONSTRUCTION");

    const plan = res.plan!;
    expect(plan.signers).toEqual([delegateKp.publicKey.toBase58()]);
    expect(plan.feePayer).toBe(delegateKp.publicKey.toBase58());
    expect(plan.instructions.map((i) => i.label)).toEqual(["transferChecked"]);
    const ix = plan.instructions[0]!;
    expect(ix.programId).toBe(T22.toBase58());
    expect(ix.dataHex).toBe(hex(12, u64(1_000n), 6));
    expect(ix.accounts).toEqual([
      { pubkey: ata(victim.publicKey).toBase58(), isSigner: false, isWritable: true },
      { pubkey: mintKey.toBase58(), isSigner: false, isWritable: false },
      { pubkey: ata(recipient).toBase58(), isSigner: false, isWritable: true },
      { pubkey: delegateKp.publicKey.toBase58(), isSigner: true, isWritable: false },
    ]);
    expect(fake.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("delegate transfer: allowance too small → INSUFFICIENT_DELEGATED_AMOUNT blocks; not approved → AUTHORITY_NOT_DELEGATE", async () => {
    const small = await transfer(seed({ delegate: delegateKp.publicKey, delegatedAmount: 10n }).conn, delegated);
    expect(small.error?.code).toBe("PREFLIGHT_BLOCKED");
    expect(codes(small)).toContain("INSUFFICIENT_DELEGATED_AMOUNT");

    const none = await transfer(seed({}).conn, delegated);
    expect(none.error?.code).toBe("PREFLIGHT_BLOCKED");
    expect(codes(none)).toContain("AUTHORITY_NOT_DELEGATE");
    expect(none.plan?.signers).toEqual([delegateKp.publicKey.toBase58()]);
  });

  it("PermanentDelegate forced transfer: info finding, no owner signature, delegate as authority", async () => {
    const { conn } = seed({ mintExt: [ext.permanentDelegate(delegateKp.publicKey)] });
    const res = await transfer(conn, delegated);
    expect(res.error).toBeUndefined();
    const pd = res.preflight!.findings.find((f) => f.code === "PERMANENT_DELEGATE_TRANSFER");
    expect(pd).toMatchObject({
      severity: "info",
      data: { authority: delegateKp.publicKey.toBase58(), sourceOwner: victim.publicKey.toBase58(), permanentDelegate: delegateKp.publicKey.toBase58() },
    });
    expect(codes(res)).not.toContain("AUTHORITY_NOT_DELEGATE");
    expect(res.plan!.signers).toEqual([delegateKp.publicKey.toBase58()]);
    const ix = res.plan!.instructions[0]!;
    expect(ix.label).toBe("transferChecked");
    expect(ix.accounts[0]!.pubkey).toBe(ata(victim.publicKey).toBase58());
    expect(ix.accounts[3]).toEqual({ pubkey: delegateKp.publicKey.toBase58(), isSigner: true, isWritable: false });
  });

  it("authority ≠ from without its keypair → SIGNER_MISSING (owner's forced transfer cannot be faked)", async () => {
    const { conn } = seed({ mintExt: [ext.permanentDelegate(delegateKp.publicKey)] });
    await expect(transfer(conn, { ...delegated, from: victim })).rejects.toMatchObject({ code: "SIGNER_MISSING" });
  });

  it("transferCheckedWithFee: data [26, 1, amount, decimals, fee]", async () => {
    const { conn } = seed({
      sourceOwner: victim.publicKey,
      mintExt: [
        ext.transferFeeConfig({
          configAuthority: victim.publicKey,
          withdrawAuthority: victim.publicKey,
          withheld: 0n,
          older: { epoch: 0n, maxFee: 1_000n, bps: 100 },
          newer: { epoch: 0n, maxFee: 1_000n, bps: 100 },
        }),
      ],
    });
    const res = await transfer(conn, {
      from: victim, destination: recipient, mint: mintKey, amount: 1_000n, decimals: 6,
      instruction: "transferCheckedWithFee", fee: 10n,
    });
    expect(res.error).toBeUndefined();
    expect(codes(res)).toContain("TRANSFER_FEE");
    expect(codes(res)).not.toContain("FEE_MISMATCH");
    const ix = res.plan!.instructions[0]!;
    expect(ix.label).toBe("transferCheckedWithFee");
    expect(ix.dataHex).toBe(hex(26, 1, u64(1_000n), 6, u64(10n)));
    expect(ix.accounts.map((a) => a.pubkey)).toEqual([
      ata(victim.publicKey).toBase58(), mintKey.toBase58(), ata(recipient).toBase58(), victim.publicKey.toBase58(),
    ]);
  });

  it("plain transfer: data [3, amount], accounts [source, dest, authority]", async () => {
    const res = await transfer(seed({}).conn, {
      from: victim, destination: recipient, mint: mintKey, amount: 7n, decimals: 6, instruction: "transfer",
    });
    expect(res.error).toBeUndefined();
    const ix = res.plan!.instructions[0]!;
    expect(ix.label).toBe("transfer");
    expect(ix.dataHex).toBe(hex(3, u64(7n)));
    expect(ix.accounts).toEqual([
      { pubkey: ata(victim.publicKey).toBase58(), isSigner: false, isWritable: true },
      { pubkey: ata(recipient).toBase58(), isSigner: false, isWritable: true },
      { pubkey: victim.publicKey.toBase58(), isSigner: true, isWritable: false },
    ]);
  });

  it("memo attached: Memo instruction signed by the authority immediately precedes the transfer", async () => {
    const { conn } = seed({ delegate: delegateKp.publicKey, delegatedAmount: 5_000n });
    const res = await transfer(conn, { ...delegated, memo: "invoice 42" });
    expect(res.error).toBeUndefined();
    const [memo, xfer] = res.plan!.instructions;
    expect(res.plan!.instructions.map((i) => i.label)).toEqual(["memo", "transferChecked"]);
    expect(memo).toMatchObject({
      programId: MEMO_PROGRAM_ID.toBase58(),
      dataHex: Buffer.from("invoice 42", "utf8").toString("hex"),
      accounts: [{ pubkey: delegateKp.publicKey.toBase58(), isSigner: true, isWritable: false }],
    });
    expect(xfer!.accounts[3]!.pubkey).toBe(delegateKp.publicKey.toBase58());
    expect(res.plan!.signers).toEqual([delegateKp.publicKey.toBase58()]);
  });
});
