import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { getWalletBalance, lamportsToSol, PublicKey } from "../lib/coreShim";
import { useApp } from "../lib/AppContext";
import { Badge, Button, Input } from "./ui";
import type { ClusterName } from "../lib/types";

const CLUSTERS: ClusterName[] = ["devnet", "testnet", "mainnet-beta", "custom"];

const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/wallet", label: "Wallets" },
  { to: "/transfer", label: "Transfer" },
  { to: "/token", label: "Tokens" },
  { to: "/multisig", label: "Multisig" },
];

export function Sidebar() {
  const { state, connection, currentWallet, setCluster, setCustomRpc, setMainnetAck } = useApp();
  const [solUi, setSolUi] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!currentWallet) {
      setSolUi(null);
      return;
    }
    getWalletBalance(connection, new PublicKey(currentWallet.address))
      .then((b) => {
        if (!cancelled) setSolUi(b.solUi);
      })
      .catch(() => {
        if (!cancelled) setSolUi(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, currentWallet]);

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col gap-4 border-r border-zinc-800 bg-zinc-950 p-4">
      <div>
        <h1 className="text-sm font-bold tracking-wide text-emerald-400">SOLWALLET CONSOLE</h1>
        <p className="mt-0.5 text-xs text-zinc-500">Local-only wallet test bench</p>
      </div>

      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-400">Cluster</div>
        <select
          value={state.cluster}
          onChange={(e) => setCluster(e.target.value as ClusterName)}
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 focus:border-emerald-600 focus:outline-none"
        >
          {CLUSTERS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {state.cluster === "custom" && (
          <Input
            className="mt-2"
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
            I understand this sends real funds on mainnet-beta.
          </label>
        )}
      </div>

      <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-400">Current wallet</div>
        {currentWallet ? (
          <div className="space-y-1">
            <div className="truncate text-sm text-zinc-100">{currentWallet.name}</div>
            <div className="truncate font-mono text-xs text-zinc-500">
              {currentWallet.address.slice(0, 4)}…{currentWallet.address.slice(-4)}
            </div>
            <div className="text-sm text-emerald-400">
              {solUi === null ? "…" : `${solUi.toFixed(4)} SOL`}
            </div>
            {currentWallet.encrypted && <Badge tone="success">encrypted</Badge>}
          </div>
        ) : (
          <div className="text-sm text-zinc-500">No wallet selected</div>
        )}
        <NavLink to="/wallet">
          <Button variant="ghost" className="mt-2 w-full">
            Switch / manage wallets
          </Button>
        </NavLink>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `rounded-md px-3 py-2 text-sm font-medium ${
                isActive ? "bg-emerald-600/20 text-emerald-300" : "text-zinc-300 hover:bg-zinc-900"
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="text-xs text-zinc-600">rpc: {connection.rpcUrl}</div>
    </aside>
  );
}

export function lamportsToSolLabel(lamports: bigint | number): string {
  return `${lamportsToSol(lamports)} SOL`;
}
