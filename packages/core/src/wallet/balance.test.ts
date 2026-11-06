import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { ClusterConnection } from "../connection/connection.js";
import { getWalletBalance } from "./balance.js";

function fakeConn(parsedAccounts: unknown[], solLamports = 5_000_000_000) {
  const fake = {
    getBalance: vi.fn().mockResolvedValue(solLamports),
    getParsedTokenAccountsByOwner: vi.fn().mockImplementation((_owner, filter) => {
      // Simulate RPC: each program filter returns only its own accounts.
      const want2022 = filter.programId.toBase58().startsWith("TokenzQd");
      const accounts = parsedAccounts
        .filter((a: { program: string }) =>
          want2022 ? a.program === "token-2022" : a.program === "spl-token",
        )
        .map((a: { program: string; parsed: unknown }) => ({
          pubkey: PublicKey.default,
          account: { data: { parsed: a.parsed } },
        }));
      return Promise.resolve({ value: accounts });
    }),
  };
  return {
    conn: new ClusterConnection(
      { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" },
      { connection: fake as unknown as import("@solana/web3.js").Connection },
    ),
    fake,
  };
}

const account = (
  mint: string,
  amount: string,
  decimals: number,
  uiAmount: number | null,
  program: string,
) => ({
  program,
  parsed: {
    info: {
      mint,
      tokenAmount: { amount, decimals, uiAmount },
    },
  },
});

describe("getWalletBalance (3.4)", () => {
  const owner = PublicKey.default;

  it("returns SOL balance with UI conversion", async () => {
    const { conn } = fakeConn([], 2_500_000_000);
    const b = await getWalletBalance(conn, owner);
    expect(b.solLamports).toBe(2_500_000_000);
    expect(b.solUi).toBe(2.5);
    expect(b.tokens).toHaveLength(0);
  });

  it("queries both token programs and merges results", async () => {
    const { conn, fake } = fakeConn([
      account("MINT_SPL", "1000000", 6, 1, "spl-token"),
      account("MINT_2022", "5000000000", 9, 5, "token-2022"),
    ]);
    const b = await getWalletBalance(conn, owner);
    expect(fake.getParsedTokenAccountsByOwner).toHaveBeenCalledTimes(2);
    expect(b.tokens).toHaveLength(2);
    const programs = b.tokens.map((t) => t.program).sort();
    expect(programs).toEqual(["spl-token", "token-2022"]);
    expect(b.tokens.find((t) => t.program === "spl-token")?.uiAmount).toBe(1);
  });

  it("aggregates the same mint across multiple token accounts", async () => {
    const { conn } = fakeConn([
      account("MINT_SPL", "1000000", 6, 1, "spl-token"),
      account("MINT_SPL", "2000000", 6, 2, "spl-token"),
    ]);
    const b = await getWalletBalance(conn, owner);
    expect(b.tokens).toHaveLength(1);
    expect(b.tokens[0]?.amount).toBe("3000000"); // no float precision loss
  });

  it("sorts tokens by mint for stable output", async () => {
    const { conn } = fakeConn([
      account("ZZZ", "1", 0, 1, "spl-token"),
      account("AAA", "1", 0, 1, "spl-token"),
    ]);
    const b = await getWalletBalance(conn, owner);
    expect(b.tokens.map((t) => t.mint)).toEqual(["AAA", "ZZZ"]);
  });
});
