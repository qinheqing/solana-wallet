/**
 * Mint info for the transfer UI: decimals + program + display name/symbol.
 *
 * Name/symbol come from the Token-2022 TokenMetadata extension when present,
 * else from the Metaplex Token Metadata PDA (classic SPL tokens). Mint
 * accounts and metadata PDAs are fetched together via getMultipleAccountsInfo.
 */
import {
  decodeMetaplexMetadata,
  decodeMintAccount,
  metaplexMetadataPda,
  PublicKey,
  type ClusterConnection,
  type MintInspection,
} from "./coreShim";

export interface MintInfo {
  mint: string;
  decimals: number;
  program: MintInspection["program"];
  name: string | null;
  symbol: string | null;
}

function t22NameSymbol(info: MintInspection): { name: string; symbol: string } | null {
  for (const ext of info.extensions) {
    if (ext.type === "TokenMetadata") return { name: ext.name.trim(), symbol: ext.symbol.trim() };
  }
  return null;
}

export type MintFetchResult = { ok: true; info: MintInfo } | { ok: false; error: unknown; notFound: boolean };

/** Fetch mint info for many mints (2 accounts per mint, chunked to the 100-account RPC limit). */
export async function fetchMintInfos(conn: ClusterConnection, mints: string[]): Promise<Map<string, MintFetchResult>> {
  const out = new Map<string, MintFetchResult>();
  const CHUNK = 50;
  for (let i = 0; i < mints.length; i += CHUNK) {
    const slice = mints.slice(i, i + CHUNK);
    const keys = slice.map((m) => new PublicKey(m));
    const pdas = keys.map(metaplexMetadataPda);
    const accounts = await conn.connection.getMultipleAccountsInfo([...keys, ...pdas], "confirmed");
    slice.forEach((mint, j) => {
      const acc = accounts[j];
      if (!acc) {
        out.set(mint, { ok: false, error: new Error("MINT_NOT_FOUND"), notFound: true });
        return;
      }
      try {
        const decoded = decodeMintAccount(keys[j]!, acc);
        const meta = t22NameSymbol(decoded) ?? (() => {
          const pda = accounts[slice.length + j];
          return pda ? decodeMetaplexMetadata(pda.data) : null;
        })();
        out.set(mint, {
          ok: true,
          info: {
            mint,
            decimals: decoded.decimals,
            program: decoded.program,
            name: meta?.name || null,
            symbol: meta?.symbol || null,
          },
        });
      } catch (error) {
        out.set(mint, { ok: false, error, notFound: false });
      }
    });
  }
  return out;
}

/** "USDC" / "My Token" / null — the best short label for a mint. */
export function tokenLabel(info: Pick<MintInfo, "name" | "symbol"> | null | undefined): string | null {
  if (!info) return null;
  return info.symbol || info.name || null;
}
