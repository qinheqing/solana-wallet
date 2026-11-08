import { AccountState, ExtensionType, getAccountLen } from "@solana/spl-token";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { resolveClusterTarget } from "../connection/cluster.js";
import { ClusterConnection } from "../connection/connection.js";
import { ext, legacyMintInfo, mintBase, token2022MintInfo } from "./__fixtures__/accounts.js";
import { decodeMintAccount, impliedAccountExtensions, inspectMint } from "./mint.js";

const k = () => Keypair.generate().publicKey;

function fakeConn(infoByAddress: Map<string, unknown>) {
  const fake = {
    getAccountInfo: vi.fn((addr: PublicKey) => Promise.resolve(infoByAddress.get(addr.toBase58()) ?? null)),
  };
  return new ClusterConnection(resolveClusterTarget("devnet"), { connection: fake as unknown as Connection });
}

describe("inspectMint / decodeMintAccount (T-A)", () => {
  it("legacy SPL mint → no extensions, accountLen 165", () => {
    const auth = k();
    const info = legacyMintInfo(mintBase({ mintAuthority: auth, supply: 123n, decimals: 9 }));
    const r = decodeMintAccount(k(), info);
    expect(r.program).toBe("spl-token");
    expect(r.decimals).toBe(9);
    expect(r.supply).toBe("123");
    expect(r.mintAuthority).toBe(auth.toBase58());
    expect(r.freezeAuthority).toBeNull();
    expect(r.extensions).toEqual([]);
    expect(r.accountLen).toBe(165);
    expect(r.dataLength).toBe(82);
  });

  it("Token-2022 mint decodes every extension with raw amounts as strings", () => {
    const mint = k();
    const cfgAuth = k(), wdAuth = k(), delegate = k(), hookAuth = k(), hookProg = k();
    const scaleAuth = k(), metaAuth = k(), rateAuth = k();
    const info = token2022MintInfo(mintBase({ mintAuthority: null, freezeAuthority: cfgAuth, supply: 2n ** 63n, decimals: 5 }), [
      ext.transferFeeConfig({
        configAuthority: cfgAuth, withdrawAuthority: wdAuth, withheld: 999n,
        older: { epoch: 10n, bps: 100, maxFee: 5_000n },
        newer: { epoch: 12n, bps: 250, maxFee: 10_000n },
      }),
      ext.permanentDelegate(delegate),
      ext.transferHook(hookAuth, hookProg),
      ext.scaledUiAmount({ authority: scaleAuth, multiplier: 1.5, newMultiplier: 2, effectiveAt: 1_800_000_000n }),
      ext.metadataPointer(metaAuth, mint),
      ext.tokenMetadata({ updateAuthority: metaAuth, mint, name: "Fee Token", symbol: "FEE", uri: "https://x/y.json" }),
      ext.interestBearing({ rateAuthority: rateAuth, currentRate: 500, avg: 250, init: 1n, last: 2n }),
      ext.defaultAccountState(AccountState.Frozen),
      ext.nonTransferable(),
      ext.confidentialTransferMint(),
      ext.unknown(200, 3),
    ]);
    const r = decodeMintAccount(mint, info);
    expect(r.program).toBe("token-2022");
    expect(r.supply).toBe((2n ** 63n).toString());
    expect(r.mintAuthority).toBeNull();
    expect(r.freezeAuthority).toBe(cfgAuth.toBase58());
    expect(r.extensions).toEqual([
      {
        type: "TransferFeeConfig",
        transferFeeConfigAuthority: cfgAuth.toBase58(),
        withdrawWithheldAuthority: wdAuth.toBase58(),
        withheldAmount: "999",
        olderTransferFee: { epoch: "10", transferFeeBasisPoints: 100, maximumFee: "5000" },
        newerTransferFee: { epoch: "12", transferFeeBasisPoints: 250, maximumFee: "10000" },
      },
      { type: "PermanentDelegate", delegate: delegate.toBase58() },
      { type: "TransferHook", authority: hookAuth.toBase58(), programId: hookProg.toBase58() },
      { type: "ScaledUiAmount", authority: scaleAuth.toBase58(), multiplier: 1.5, newMultiplier: 2, newMultiplierEffectiveTimestamp: "1800000000" },
      { type: "MetadataPointer", authority: metaAuth.toBase58(), metadataAddress: mint.toBase58() },
      {
        type: "TokenMetadata", updateAuthority: metaAuth.toBase58(), mint: mint.toBase58(),
        name: "Fee Token", symbol: "FEE", uri: "https://x/y.json", additionalMetadata: [["tier", "gold"]],
      },
      { type: "InterestBearingConfig", rateAuthority: rateAuth.toBase58(), currentRate: 500, preUpdateAverageRate: 250, initializationTimestamp: "1", lastUpdateTimestamp: "2" },
      { type: "DefaultAccountState", state: "frozen" },
      { type: "NonTransferable" },
      { type: "ConfidentialTransferMint" },
      { type: "unknown", rawType: 200, length: 3 },
    ]);
    // ATA sizing: ImmutableOwner + TransferFeeAmount + NonTransferableAccount + TransferHookAccount + ConfidentialTransferAccount
    expect(r.accountLen).toBe(
      getAccountLen([
        ExtensionType.ImmutableOwner, ExtensionType.TransferFeeAmount, ExtensionType.NonTransferableAccount,
        ExtensionType.TransferHookAccount, ExtensionType.ConfidentialTransferAccount,
      ]),
    );
    expect(r.dataLength).toBe(info.data.length);
  });

  it("TransferHook with null program id and zero-key authorities decode as null", () => {
    const info = token2022MintInfo(mintBase({}), [ext.transferHook(PublicKey.default, PublicKey.default)]);
    expect(decodeMintAccount(k(), info).extensions).toEqual([{ type: "TransferHook", authority: null, programId: null }]);
  });

  it("impliedAccountExtensions always includes ImmutableOwner; plain T22 ATA is 170 bytes", () => {
    expect(impliedAccountExtensions([])).toEqual([ExtensionType.ImmutableOwner]);
    expect(decodeMintAccount(k(), token2022MintInfo(mintBase({}), [])).accountLen).toBe(170);
    expect(impliedAccountExtensions([ExtensionType.TransferFeeConfig])).toEqual([
      ExtensionType.ImmutableOwner, ExtensionType.TransferFeeAmount,
    ]);
  });

  it("inspectMint: MINT_NOT_FOUND / NOT_A_MINT via fake connection", async () => {
    const mint = k();
    const wallet = k();
    const conn = fakeConn(new Map([
      [mint.toBase58(), token2022MintInfo(mintBase({ decimals: 2 }), [])],
      [wallet.toBase58(), { owner: new PublicKey("11111111111111111111111111111111"), data: Buffer.alloc(0), lamports: 1, executable: false }],
    ]));
    const r = await inspectMint(conn, mint.toBase58());
    expect(r.decimals).toBe(2);
    await expect(inspectMint(conn, k())).rejects.toMatchObject({ code: "MINT_NOT_FOUND" });
    await expect(inspectMint(conn, wallet)).rejects.toMatchObject({ code: "NOT_A_MINT" });
  });
});
