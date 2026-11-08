import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { getWalletBalance, PublicKey } from "../lib/coreShim";
import { useApp } from "../lib/AppContext";
import { useT, type TKey } from "../lib/i18n";
import { Badge, Button, Input } from "./ui";
import { AmountValue } from "./Amount";
import { LocaleToggle } from "./LocaleToggle";
import type { ClusterName } from "../lib/types";

const CLUSTERS: { value: ClusterName; label?: TKey }[] = [
  { value: "localnet", label: "sidebar.cluster.localnet" },
  { value: "devnet" },
  { value: "testnet" },
  { value: "mainnet-beta" },
  { value: "custom", label: "sidebar.cluster.custom" },
];

const NAV: { to: string; label: TKey; end?: boolean }[] = [
  { to: "/", label: "nav.dashboard", end: true },
  { to: "/wallet", label: "nav.wallets" },
  { to: "/transfer", label: "nav.transfer" },
  { to: "/token", label: "nav.tokens" },
  { to: "/multisig", label: "nav.multisig" },
  { to: "/inspect", label: "nav.inspect" },
];

export function Sidebar() {
  const t = useT();
  const { state, connection, currentWallet, setCluster, setCustomRpc, setMainnetAck } = useApp();
  const [lamports, setLamports] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!currentWallet) {
      setLamports(null);
      return;
    }
    getWalletBalance(connection, new PublicKey(currentWallet.address))
      .then((b) => {
        if (!cancelled) setLamports(b.solLamports);
      })
      .catch(() => {
        if (!cancelled) setLamports(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, currentWallet]);

  return (
    <aside className="flex w-full shrink-0 flex-col gap-4 border-b border-zinc-800 bg-zinc-950 p-4 md:h-full md:w-72 md:border-b-0 md:border-r">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-sm font-bold tracking-wide text-emerald-400">{t("app.brand")}</h1>
          <p className="mt-0.5 text-xs text-zinc-500">{t("app.tagline")}</p>
        </div>
        <LocaleToggle />
      </div>

      <div>
        <label htmlFor="sidebar-cluster" className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-400">
          {t("sidebar.cluster")}
        </label>
        <select
          id="sidebar-cluster"
          value={state.cluster}
          onChange={(e) => setCluster(e.target.value as ClusterName)}
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 focus:border-emerald-600 focus:outline-none"
        >
          {CLUSTERS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label ? t(c.label) : c.value}
            </option>
          ))}
        </select>
        {state.cluster === "localnet" && <p className="mt-2 text-xs text-zinc-500">{t("sidebar.localnetHint")}</p>}
        {state.cluster === "custom" && (
          <Input
            className="mt-2"
            aria-label={t("sidebar.customRpc")}
            placeholder="https://your-rpc.example.com"
            value={state.customRpcUrl}
            onChange={(e) => setCustomRpc(e.target.value)}
          />
        )}
        {state.cluster === "mainnet-beta" && (
          <label className="mt-2 flex items-start gap-2 text-xs text-amber-300">
            <input
              type="checkbox"
              checked={state.mainnetAck}
              onChange={(e) => setMainnetAck(e.target.checked)}
              className="mt-0.5"
            />
            {t("sidebar.mainnetAck")}
          </label>
        )}
      </div>

      <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-400">{t("sidebar.currentWallet")}</div>
        {currentWallet ? (
          <div className="space-y-1">
            <div className="truncate text-sm text-zinc-100">{currentWallet.name}</div>
            <div className="truncate font-mono text-xs text-zinc-500">
              {currentWallet.address.slice(0, 4)}…{currentWallet.address.slice(-4)}
            </div>
            <div className="text-sm text-emerald-400">
              {lamports === null ? "…" : <AmountValue raw={lamports} decimals={9} symbol="SOL" unit={t("common.lamports")} stacked />}
            </div>
            {currentWallet.encrypted && <Badge tone="success">{t("common.encrypted")}</Badge>}
          </div>
        ) : (
          <div className="text-sm text-zinc-500">{t("sidebar.noWallet")}</div>
        )}
        <NavLink to="/wallet">
          <Button variant="ghost" className="mt-2 w-full">
            {t("sidebar.manageWallets")}
          </Button>
        </NavLink>
      </div>

      <nav aria-label={t("nav.primary")} className="flex gap-1 overflow-x-auto md:flex-1 md:flex-col md:overflow-visible">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `shrink-0 rounded-md px-3 py-2 text-sm font-medium ${
                isActive ? "bg-emerald-600/20 text-emerald-300" : "text-zinc-300 hover:bg-zinc-900"
              }`
            }
          >
            {t(item.label)}
          </NavLink>
        ))}
      </nav>

      <div className="hidden truncate text-xs text-zinc-600 md:block" title={connection.rpcUrl}>
        {t("sidebar.rpc", { url: connection.rpcUrl })}
      </div>
    </aside>
  );
}
