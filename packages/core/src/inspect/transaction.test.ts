/**
 * T-E fixtures: real mainnet transactions fetched read-only via
 * getTransaction(jsonParsed, maxSupportedTransactionVersion: 0), plus three
 * hand-crafted variants derived from them (see `_fixtureNote` inside each).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { resolveClusterTarget } from "../connection/cluster.js";
import { ClusterConnection } from "../connection/connection.js";
import bs58 from "bs58";

import { explorerUrl, inspectParsedTransaction, inspectTransaction, resolveSignature } from "./transaction.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), "utf8"));

const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const BERN = "CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo";
const BERN_BOT = "BeRNwDN8aGHvxYRVhNyMkF1wsxuEeceux2xn5deFWyEe";

describe("inspectTransaction (T-E) — real mainnet fixtures", () => {
  it("transferChecked on a TransferFee mint: fee from balance-delta, owners from token balances", () => {
    const r = inspectParsedTransaction(fixture("transfer-checked-fee-mint"), { cluster: "mainnet-beta" });
    expect(r.signature).toBe("4UybrykVtyeBy3H4Ghz3PPG1sxp6EgzbhshvAnRiaNqucvjwSvheWzXTRiYqirQ63DVraELAUz3EfeCti2cuuE1u");
    expect(r.slot).toBe(466538504);
    expect(r.blockTime).toBe(1794060109);
    expect(r.fee).toBe(1008000);
    expect(r.err).toBeNull();
    expect(r.decodedError).toBeNull();
    expect(r.explorerUrl).toBe(`https://explorer.solana.com/tx/${r.signature}`);
    expect(r.warnings).toEqual([]);
    expect(r.movements).toHaveLength(5);
    expect(r.movements[0]).toEqual({
      program: "token-2022",
      programId: T22,
      instructionIndex: 1,
      innerIndex: null,
      isInner: false,
      instructionType: "transferChecked",
      rawType: null,
      sourceAccount: "2SQN7ucyFAZhAouWteRXaAa1GiwF47xFyJkUVoUUJXYe",
      sourceOwner: BERN_BOT,
      destAccount: "2yrqgGHamfBU3sitsiXAeB8c7vDR5Z5HNFAf1imN5KU9",
      destOwner: "DBR2ZUvjZTcgy6R9US64t96pBEZMyr9DPW6G2scrctQK",
      authority: BERN_BOT,
      mint: BERN,
      amount: "28280643",
      decimals: 5,
      fee: { amount: "760750", source: "balance-delta" },
      balanceDelta: "27519893",
    });
    // 84841930 − 82559682 = 2282248 withheld on instruction 3
    expect(r.movements[2].fee).toEqual({ amount: "2282248", source: "balance-delta" });
    const src = r.balanceChanges.find((b) => b.account === "2SQN7ucyFAZhAouWteRXaAa1GiwF47xFyJkUVoUUJXYe")!;
    expect(src.delta).toBe((-28280643n * 3n - 84841930n - 84741930n).toString());
    expect(src.programId).toBe(T22);
    expect(src.decimals).toBe(5);
  });

  it("legacy transferChecked (USDC): no fee, destination created in this tx (pre = 0)", () => {
    const r = inspectParsedTransaction(fixture("transfer-checked-spl"), { cluster: "devnet" });
    expect(r.explorerUrl).toMatch(/\?cluster=devnet$/);
    expect(r.movements).toHaveLength(1);
    expect(r.movements[0]).toMatchObject({
      program: "spl-token",
      programId: SPL,
      instructionType: "transferChecked",
      isInner: false,
      sourceAccount: "7dQmths1cyCQ4xaC5KcVfXz4BvVWtnHc3hcgnfnE1PBx",
      sourceOwner: "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS",
      destAccount: "FjH2JQFTmkuobX4udrUjWVWmFsXbDfdhvc5jDmRH8Hqk",
      destOwner: "33RBBrMvYi39aNAxMvzZeN7uD5PCPUAJrTeJdmyRX18R",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "16367850",
      decimals: 6,
      fee: null,
      balanceDelta: "16367850",
    });
    const dest = r.balanceChanges.find((b) => b.account === "FjH2JQFTmkuobX4udrUjWVWmFsXbDfdhvc5jDmRH8Hqk")!;
    expect(dest).toMatchObject({ pre: "0", post: "16367850", delta: "16367850" });
  });

  it("CPI (Jupiter swap): inner movements, owner of a same-tx WSOL account resolved from createIdempotent", () => {
    const r = inspectParsedTransaction(fixture("cpi-inner-transfer"), { cluster: "mainnet-beta" });
    expect(r.movements.every((m) => m.isInner)).toBe(true);
    const types = r.movements.map((m) => `${m.instructionIndex}.${m.innerIndex}:${m.instructionType}`);
    expect(types).toEqual(["3.1:transferChecked", "3.2:mintTo", "3.3:transferChecked", "3.5:transfer"]);
    // BERN leg inside the swap still shows the transfer fee via balance delta.
    expect(r.movements[0]).toMatchObject({
      program: "token-2022",
      mint: BERN,
      amount: "3685259",
      balanceDelta: "3586125",
      fee: { amount: "99134", source: "balance-delta" },
      sourceOwner: "6AG8iWF95yLmEXoh87ptDSfwMqbyYY1tBC24cLaz51Vw",
      destOwner: "GZHYAsikiCAAeMzJ6wX2oUx8Z9eh78wKUA9WyabB53tB",
    });
    expect(r.movements[1]).toMatchObject({ instructionType: "mintTo", sourceAccount: null, destAccount: "AMnF3iSQ2Z7yQRaKneUUwtdt9aF6kg6pxS2waqoJ57mX", amount: "0", authority: "GZHYAsikiCAAeMzJ6wX2oUx8Z9eh78wKUA9WyabB53tB" });
    // WSOL ATA 8u4RD… is created + closed in the same tx: no token balances, owner from the ATA create instruction.
    const wsol = "8u4RD4NpTUSD9TfDad4qfXaS4tF563m1eeKZPUVbC2sf";
    expect(r.movements[2]).toMatchObject({ program: "spl-token", destAccount: wsol, destOwner: "6AG8iWF95yLmEXoh87ptDSfwMqbyYY1tBC24cLaz51Vw", mint: "So11111111111111111111111111111111111111112", balanceDelta: null, fee: null });
    // Unchecked `transfer` has no mint in parsed.info: resolved from the create hint of its source.
    expect(r.movements[3]).toMatchObject({ instructionType: "transfer", sourceAccount: wsol, sourceOwner: "6AG8iWF95yLmEXoh87ptDSfwMqbyYY1tBC24cLaz51Vw", mint: "So11111111111111111111111111111111111111112", amount: "898", decimals: null, balanceDelta: "898" });
    expect(r.warnings).toEqual([]);
  });

  it("withdrawWithheldTokensFromAccounts: 8 sources, recipient delta, no declared amount", () => {
    const r = inspectParsedTransaction(fixture("withdraw-withheld-from-accounts"), { cluster: "mainnet-beta" });
    expect(r.movements).toHaveLength(1);
    const m = r.movements[0];
    expect(m).toMatchObject({
      program: "token-2022",
      instructionType: "withdrawWithheldTokensFromAccounts",
      isInner: false,
      sourceAccount: null,
      destAccount: "2SQN7ucyFAZhAouWteRXaAa1GiwF47xFyJkUVoUUJXYe",
      destOwner: BERN_BOT,
      authority: BERN_BOT,
      mint: BERN,
      amount: null,
      fee: null,
      balanceDelta: "242085167",
    });
    expect(m.sourceAccounts).toHaveLength(8);
    expect(m.sourceAccounts![0]).toBe("DKfbmLxtfcQZDZWycxzBPxDsC7xLqLVZY28qNtncMkPe");
  });

  it("harvestWithheldTokensToMint (inner): destination is the mint", () => {
    const r = inspectParsedTransaction(fixture("harvest-withheld"), { cluster: "mainnet-beta" });
    const h = r.movements.find((m) => m.instructionType === "harvestWithheldTokensToMint")!;
    expect(h).toMatchObject({ isInner: true, instructionIndex: 3, innerIndex: 0, destAccount: BERN, mint: BERN, sourceAccounts: ["HS1QtLzczyYGoa9J9jCNXMNYZk55Ve11eDr4pXSvqD3C"], amount: null });
  });

  it("failed tx with InstructionError Custom(20) in a non-token program: decoded, unnamed, warned", () => {
    const r = inspectParsedTransaction(fixture("failed-custom"), { cluster: "mainnet-beta" });
    expect(r.err).toEqual({ InstructionError: [2, { Custom: 20 }] });
    expect(r.decodedError).toEqual({
      instructionIndex: 2,
      programId: "FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X",
      customCode: 20,
    });
    expect(r.decodedError?.name).toBeUndefined();
    expect(r.warnings).toEqual([
      "Transaction failed: custom error 20 in instruction 2 of program FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X. No token or SOL movement took effect.",
    ]);
    expect(r.movements).toEqual([]);
    expect(r.balanceChanges.every((b) => b.delta === "0")).toBe(true);
  });
});

describe("inspectTransaction (T-E) — hand-crafted variants (see _fixtureNote)", () => {
  it("transferCheckedWithFee: fee comes from the instruction, not the delta", () => {
    const r = inspectParsedTransaction(fixture("transfer-checked-with-fee"));
    expect(r.explorerUrl).toBeNull(); // cluster unknown
    expect(r.movements).toHaveLength(1);
    expect(r.movements[0]).toMatchObject({
      instructionType: "transferCheckedWithFee",
      amount: "28280643",
      decimals: 5,
      fee: { amount: "760750", source: "instruction" },
      balanceDelta: "27519893",
    });
  });

  it("PermanentDelegate forced transfer: authority ≠ sourceOwner", () => {
    const r = inspectParsedTransaction(fixture("permanent-delegate-transfer"), { cluster: "custom", rpcUrl: "http://127.0.0.1:8899" });
    expect(r.explorerUrl).toBe(`https://explorer.solana.com/tx/${r.signature}?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899`);
    const m = r.movements[0];
    expect(m.authority).toBe("De1egateXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    expect(m.sourceOwner).toBe(BERN_BOT);
    expect(m.authority).not.toBe(m.sourceOwner);
    expect(m.fee).toEqual({ amount: "760750", source: "balance-delta" });
  });

  it("plain spl `transfer`: mint resolved from token balances, decimals unknown", () => {
    const r = inspectParsedTransaction(fixture("spl-transfer"), { cluster: "testnet" });
    expect(r.movements[0]).toMatchObject({
      program: "spl-token",
      instructionType: "transfer",
      amount: "16367850",
      decimals: null,
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      sourceOwner: "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS",
      destOwner: "33RBBrMvYi39aNAxMvzZeN7uD5PCPUAJrTeJdmyRX18R",
      fee: null,
      balanceDelta: "16367850",
    });
  });
});

describe("inspectTransaction — plumbing", () => {
  it("rejects non-transaction JSON", () => {
    expect(() => inspectParsedTransaction({ hello: 1 })).toThrowError(expect.objectContaining({ code: "INVALID_TRANSACTION_JSON" }));
  });

  it("warns on ConfidentialTransfer and unparsable token instructions", () => {
    const base = fixture("transfer-checked-spl") as { transaction: { message: { instructions: unknown[] } } };
    base.transaction.message.instructions.push(
      { program: "spl-token", programId: T22, parsed: { type: "confidentialTransferTransfer", info: {} } },
      { programId: T22, accounts: [], data: "abc" },
    );
    const r = inspectParsedTransaction(base);
    expect(r.warnings).toEqual([
      expect.stringMatching(/^ConfidentialTransfer instruction \(confidentialTransferTransfer\) at instruction 2/),
      expect.stringMatching(/^Unparsable token-2022 instruction 3/),
    ]);
    expect(r.movements).toHaveLength(1);
  });

  it("signature variant fetches with maxSupportedTransactionVersion 0 then delegates; TRANSACTION_NOT_FOUND", async () => {
    const json = fixture("transfer-checked-spl");
    const SIG_A = "4UybrykVtyeBy3H4Ghz3PPG1sxp6EgzbhshvAnRiaNqucvjwSvheWzXTRiYqirQ63DVraELAUz3EfeCti2cuuE1u";
    const fake = { getParsedTransaction: vi.fn().mockResolvedValueOnce(json).mockResolvedValueOnce(null) };
    const conn = new ClusterConnection(resolveClusterTarget("devnet"), { connection: fake as never });
    const r = await inspectTransaction({ conn, signature: SIG_A });
    expect(fake.getParsedTransaction).toHaveBeenCalledWith(SIG_A, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    expect(r.movements).toHaveLength(1);
    expect(r.explorerUrl).toContain("?cluster=devnet");
    await expect(inspectTransaction({ conn, signature: SIG_A })).rejects.toMatchObject({ code: "TRANSACTION_NOT_FOUND" });
  });

  it("explorerUrl forms", () => {
    expect(explorerUrl("S", { cluster: "mainnet-beta" })).toBe("https://explorer.solana.com/tx/S");
    expect(explorerUrl("S", { cluster: "testnet" })).toBe("https://explorer.solana.com/tx/S?cluster=testnet");
    expect(explorerUrl("S", { cluster: "custom" })).toBe("https://explorer.solana.com/tx/S?cluster=custom");
    expect(explorerUrl("S", {})).toBeNull();
  });
});

describe("native SOL", () => {
  it("system transfer (testnet fixture): solMovements + solBalanceChanges, no token rows", () => {
    const r = inspectParsedTransaction(fixture("sol-transfer"), { cluster: "testnet" });
    expect(r.movements).toEqual([]);
    expect(r.balanceChanges).toEqual([]);
    expect(r.solMovements).toEqual([
      {
        instructionIndex: 2,
        innerIndex: null,
        isInner: false,
        instructionType: "transfer",
        source: "6Y3n7Y5mH6X2XDeAecGdHCVR6r6kPZxJSJabd5kW98Vr",
        destination: "J6ombbZhxhPBf11UPP2vdQZYKvcWB3NgcSDF27A1Hpfj",
        lamports: "5000000",
      },
    ]);
    expect(r.solBalanceChanges).toEqual([
      { account: "6Y3n7Y5mH6X2XDeAecGdHCVR6r6kPZxJSJabd5kW98Vr", isFeePayer: true, pre: "20805240", post: "15800240", delta: "-5005000" },
      { account: "J6ombbZhxhPBf11UPP2vdQZYKvcWB3NgcSDF27A1Hpfj", isFeePayer: false, pre: "0", post: "5000000", delta: "5000000" },
    ]);
    // payer delta = −(amount + fee)
    expect(BigInt(r.solBalanceChanges[0]!.delta)).toBe(-(5000000n + BigInt(r.fee)));
  });
});

describe("resolveSignature", () => {
  // Serialized (signed, legacy) transaction pasted where a signature was expected —
  // getTransaction rejects it with "-32602 Invalid param: WrongSize".
  const RAW_TX_B58 =
    "4HyFMSaVAQo5ZRVzZqJD5TNLk3tGxuv31AfonYmyHfQG2VUY7fuzM2LPZb7DYEd7ECneBgoSbQQq3fkuCMrXkLVCbBkKZjeuhnCokj9YFTDuhLtwdn9pYdVy6hjP9JgtjkbnjwF699riqBgca7vENPu2YfAxpNwxByHbDKTHzfonETwZ7RENFygGcUCABWpBeBJ4vE5fj1Jf33c5T9LYnTgDrfN2TTehgawcw9NBay9fFn6kNEiRsKoQzdAPSrwVF4D4xFbdm3r9M6qQpFfezi1Z9gbXCc6L5a8612KMRTDPVQ5Hv3cerFVxVVbshEdPEgSnbc4vPfqbsjG73KT5wUdbYNSEF9u8JQxmDEFqEvxF";
  const SIG = "dGu577XYHRcJRg763xnSBKgafeBwxHPWg9DxcGAexzWJ6DL8VtmnGmKqTTeAKjDszkiT6W2wCq45avs4sNC1be9";

  it("passes a real signature through (trimmed)", () => {
    expect(resolveSignature(`  ${SIG}\n`)).toBe(SIG);
  });

  it("extracts the fee-payer signature from a base58 serialized transaction", () => {
    expect(resolveSignature(RAW_TX_B58)).toBe(SIG);
  });

  it("extracts it from a base64 serialized transaction too", () => {
    const b64 = Buffer.from(bs58.decode(RAW_TX_B58)).toString("base64");
    expect(resolveSignature(b64)).toBe(SIG);
  });

  it("rejects garbage with INVALID_SIGNATURE", () => {
    expect(() => resolveSignature("abc")).toThrow(expect.objectContaining({ code: "INVALID_SIGNATURE" }));
    expect(() => resolveSignature("")).toThrow(expect.objectContaining({ code: "INVALID_SIGNATURE" }));
  });

  it("inspectTransaction queries RPC with the extracted signature", async () => {
    const fake = { getParsedTransaction: vi.fn().mockResolvedValue(null) };
    const conn = new ClusterConnection(resolveClusterTarget("devnet"), { connection: fake as never });
    await expect(inspectTransaction({ conn, signature: RAW_TX_B58 })).rejects.toMatchObject({
      code: "TRANSACTION_NOT_FOUND",
    });
    expect(fake.getParsedTransaction.mock.calls[0]?.[0]).toBe(SIG);
  });
});
