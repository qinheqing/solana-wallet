import { useCallback, useEffect, useRef, useState } from "react";
import { formatAmount, getWalletBalance, parseTransactionError, PublicKey, type TokenBalance } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT } from "../../lib/i18n";
import { fetchMintInfos, tokenLabel, type MintInfo } from "../../lib/tokenMeta";

export interface OwnedToken extends TokenBalance {
  name: string | null;
  symbol: string | null;
}

export interface OwnedTokens {
  tokens: OwnedToken[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Token balances (SPL + Token-2022) of the current wallet plus name/symbol,
 * for the mint picker. Uses the unlocked keypair when present, else the
 * selected wallet.
 */
export function useOwnedTokens(): OwnedTokens {
  const { connection, state, currentWallet } = useApp();
  const owner = state.unlockedKeypair?.publicKey.toBase58() ?? currentWallet?.address ?? null;
  const [tokens, setTokens] = useState<OwnedToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setTokens([]);
    setError(null);
    if (!owner) return;
    setLoading(true);
    (async () => {
      const balance = await getWalletBalance(connection, new PublicKey(owner));
      let metas = new Map<string, MintInfo>();
      try {
        const res = await fetchMintInfos(connection, balance.tokens.map((tk) => tk.mint));
        for (const [mint, r] of res) if (r.ok) metas.set(mint, r.info);
      } catch {
        metas = new Map(); // names are best-effort; balances still usable
      }
      return balance.tokens.map((tk) => ({
        ...tk,
        name: metas.get(tk.mint)?.name ?? null,
        symbol: metas.get(tk.mint)?.symbol ?? null,
      }));
    })()
      .then((list) => {
        if (!cancelled) setTokens(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, owner, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { tokens, loading, error, reload };
}

type MintLookup =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; info: MintInfo }
  | { status: "error"; message: string };

function asPublicKey(v: string): PublicKey | null {
  if (v.length < 32 || v.length > 44) return null;
  try {
    return new PublicKey(v);
  } catch {
    return null;
  }
}

/** Debounced on-chain lookup (decimals + name/symbol); reports decimals via `onDecimals`. */
function useMintLookup(mint: string, onDecimals?: (decimals: number) => void) {
  const { connection } = useApp();
  const [lookup, setLookup] = useState<MintLookup>({ status: "idle" });
  const cb = useRef(onDecimals);
  cb.current = onDecimals;

  useEffect(() => {
    if (!asPublicKey(mint)) {
      setLookup({ status: "idle" });
      return;
    }
    let cancelled = false;
    setLookup({ status: "loading" });
    const timer = setTimeout(() => {
      fetchMintInfos(connection, [mint])
        .then((res) => {
          if (cancelled) return;
          const r = res.get(mint);
          if (r?.ok) {
            setLookup({ status: "ok", info: r.info });
            cb.current?.(r.info.decimals);
          } else if (r?.notFound) {
            setLookup({ status: "error", message: `MINT_NOT_FOUND (${connection.cluster})` });
          } else {
            const pe = parseTransactionError(r?.error);
            setLookup({ status: "error", message: `${pe.code}: ${pe.message}` });
          }
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          const pe = parseTransactionError(e);
          setLookup({ status: "error", message: `${pe.code}: ${pe.message}` });
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connection, mint]);

  return lookup;
}

function safeFormat(raw: string, decimals: number): string {
  try {
    return formatAmount(BigInt(raw), decimals);
  } catch {
    return raw;
  }
}

/**
 * Single mint field with a dropdown of the wallet's tokens (name/symbol +
 * balance). Any valid address typed or picked is looked up on-chain and its
 * decimals reported via `onDecimals`; one status line shows the result.
 */
export function MintPicker({
  id,
  value,
  onChange,
  onDecimals,
  owned,
  placeholder,
  ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (mint: string) => void;
  onDecimals?: (decimals: number) => void;
  owned: OwnedTokens;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const trimmed = value.trim();
  const lookup = useMintLookup(trimmed, onDecimals);
  const isOwnedValue = owned.tokens.some((tk) => tk.mint === trimmed);

  // Typing a partial mint/name filters the list; a complete owned mint shows everything.
  const q = isOwnedValue ? "" : trimmed.toLowerCase();
  const list = q
    ? owned.tokens.filter((tk) =>
        [tk.mint, tk.name ?? "", tk.symbol ?? ""].some((s) => s.toLowerCase().includes(q)),
      )
    : owned.tokens;

  const pick = (tk: OwnedToken) => {
    onChange(tk.mint);
    onDecimals?.(tk.decimals); // instant; the chain lookup confirms
    setOpen(false);
  };

  return (
    <div className="relative">
      <div className="flex rounded-md border border-zinc-700 bg-zinc-950 focus-within:border-emerald-600">
        <input
          id={id}
          aria-label={ariaLabel}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent px-2.5 py-1.5 font-mono text-zinc-100 placeholder-zinc-500 placeholder:font-sans focus:outline-none"
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("mintPicker.select")}
          onMouseDown={(e) => {
            e.preventDefault();
            setOpen((o) => !o);
          }}
          className="px-2 text-zinc-400 hover:text-zinc-200"
        >
          ▾
        </button>
      </div>

      {open && (
        <div
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 shadow-lg"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="flex items-center justify-between border-b border-zinc-800 px-2.5 py-1 text-xs text-zinc-500">
            <span>{t("mintPicker.myTokens", { n: owned.tokens.length })}</span>
            <button type="button" onClick={owned.reload} disabled={owned.loading} className="hover:text-zinc-200 disabled:opacity-50">
              ↻ {t("mintPicker.reload")}
            </button>
          </div>
          {owned.loading && <div className="px-2.5 py-2 text-xs text-zinc-500">{t("common.loading")}</div>}
          {owned.error && <div className="px-2.5 py-2 text-xs text-red-400">{t("mintPicker.loadFailed", { error: owned.error })}</div>}
          {!owned.loading && !owned.error && list.length === 0 && (
            <div className="px-2.5 py-2 text-xs text-zinc-500">
              {owned.tokens.length === 0 ? t("mintPicker.none") : t("mintPicker.noMatch")}
            </div>
          )}
          {list.map((tk) => (
            <button
              type="button"
              key={tk.mint}
              onClick={() => pick(tk)}
              className={`flex w-full items-center gap-3 px-2.5 py-2 text-left text-sm hover:bg-zinc-800 ${tk.mint === trimmed ? "bg-zinc-800" : ""}`}
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium text-zinc-100">{tokenLabel(tk) ?? t("mintPicker.unknown")}</span>
                {tk.name && tk.symbol && tk.name !== tk.symbol && <span className="ml-1 text-zinc-500">{tk.name}</span>}
                <span className="block break-all font-mono text-xs text-zinc-500">{tk.mint}</span>
              </span>
              <span className="shrink-0 font-mono text-xs text-zinc-400">{safeFormat(tk.amount, tk.decimals)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-1 text-xs empty:hidden">
        {trimmed && !asPublicKey(trimmed) && !open && <span className="text-red-400">{t("mintPicker.invalid")}</span>}
        {lookup.status === "loading" && <span className="text-zinc-500">{t("mintPicker.querying")}</span>}
        {lookup.status === "ok" && (
          <span className="text-emerald-400">
            {t("mintPicker.onchain", {
              token: tokenLabel(lookup.info) ?? t("mintPicker.unknown"),
              decimals: lookup.info.decimals,
            })}
          </span>
        )}
        {lookup.status === "error" && <span className="text-red-400">{lookup.message}</span>}
      </div>
    </div>
  );
}
