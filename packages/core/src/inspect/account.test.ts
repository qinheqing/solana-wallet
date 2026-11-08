import { AccountState } from "@solana/spl-token";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { resolveClusterTarget } from "../connection/cluster.js";
import { ClusterConnection } from "../connection/connection.js";
import { accountBase, ext, legacyAccountInfo, mintBase, token2022AccountInfo, token2022MintInfo } from "./__fixtures__/accounts.js";
import { decodeTokenAccount, inspectTokenAccount } from "./account.js";

const k = () => Keypair.generate().publicKey;

describe("inspectTokenAccount / decodeTokenAccount (T-A)", () => {
  it("legacy account: base fields, raw amount string, no extensions", () => {
    const mint = k(), owner = k(), delegate = k();
    const info = legacyAccountInfo(accountBase({ mint, owner, amount: 10n ** 18n, delegate, delegatedAmount: 5n }));
    const r = decodeTokenAccount(k(), info);
    expect(r).toMatchObject({
      program: "spl-token",
      mint: mint.toBase58(),
      owner: owner.toBase58(),
      amount: (10n ** 18n).toString(),
      delegate: delegate.toBase58(),
      delegatedAmount: "5",
      state: "initialized",
      closeAuthority: null,
      isNative: false,
      extensions: [],
      dataLength: 165,
    });
  });

  it("Token-2022 account: every account-level extension + frozen state", () => {
    const mint = k(), owner = k(), closer = k();
    const info = token2022AccountInfo(
      accountBase({ mint, owner, amount: 7n, state: AccountState.Frozen, closeAuthority: closer }),
      [
        ext.immutableOwner(),
        ext.transferFeeAmount(42n),
        ext.memoTransfer(true),
        ext.cpiGuard(true),
        ext.nonTransferableAccount(),
        ext.transferHookAccount(false),
        ext.unknown(201, 2),
      ],
    );
    const r = decodeTokenAccount(k(), info);
    expect(r.state).toBe("frozen");
    expect(r.closeAuthority).toBe(closer.toBase58());
    expect(r.extensions).toEqual([
      { type: "ImmutableOwner" },
      { type: "TransferFeeAmount", withheldAmount: "42" },
      { type: "MemoTransfer", requireIncomingTransferMemos: true },
      { type: "CpiGuard", lockCpi: true },
      { type: "NonTransferableAccount" },
      { type: "TransferHookAccount", transferring: false },
      { type: "unknown", rawType: 201, length: 2 },
    ]);
    expect(r.dataLength).toBe(info.data.length);
  });

  it("inspectTokenAccount: ACCOUNT_NOT_FOUND / NOT_A_TOKEN_ACCOUNT (mint passed)", async () => {
    const ata = k(), mint = k();
    const infos = new Map<string, unknown>([
      [ata.toBase58(), token2022AccountInfo(accountBase({ mint, owner: k(), amount: 1n }), [ext.immutableOwner()])],
      [mint.toBase58(), token2022MintInfo(mintBase({}), [])],
    ]);
    const fake = { getAccountInfo: vi.fn((a: PublicKey) => Promise.resolve(infos.get(a.toBase58()) ?? null)) };
    const conn = new ClusterConnection(resolveClusterTarget("devnet"), { connection: fake as unknown as Connection });
    expect((await inspectTokenAccount(conn, ata)).amount).toBe("1");
    await expect(inspectTokenAccount(conn, k())).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    await expect(inspectTokenAccount(conn, mint)).rejects.toMatchObject({ code: "NOT_A_TOKEN_ACCOUNT" });
  });
});
