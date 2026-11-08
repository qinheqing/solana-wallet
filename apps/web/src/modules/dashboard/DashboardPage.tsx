import { useEffect, useState } from "react";
import { formatAmount, getWalletBalance, toSafeWalletView, type ClusterHealth, type SafeWalletView, PublicKey } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { Card, ErrorBanner } from "../../components/ui";

export function DashboardPage() {
  const { connection, currentWallet } = useApp();
  const [health, setHealth] = useState<ClusterHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [balance, setBalance] = useState<SafeWalletView | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHealth(null);
    setHealthError(null);
    connection
      .getHealth()
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch((e: unknown) => {
        if (!cancelled) setHealthError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  useEffect(() => {
    let cancelled = false;
    setBalance(null);
    setBalanceError(null);
    if (!currentWallet) return;
    getWalletBalance(connection, new PublicKey(currentWallet.address))
      .then((b) => {
        if (!cancelled) setBalance(toSafeWalletView(b));
      })
      .catch((e: unknown) => {
        if (!cancelled) setBalanceError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [connection, currentWallet]);

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Dashboard</h2>

      <Card>
        <h3 className="mb-3 text-sm font-semibold text-zinc-300">Cluster health</h3>
        {healthError && <ErrorBanner>{healthError}</ErrorBanner>}
        {!healthError && !health && <div className="text-sm text-zinc-500">Loading…</div>}
        {health && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Cluster" value={health.cluster} />
            <Stat label="Slot" value={health.slot.toLocaleString()} />
            <Stat label="Version" value={health.version} />
            <Stat label="TPS (approx)" value={health.tps.toLocaleString()} />
          </div>
        )}
      </Card>

      <Card>
        <h3 className="mb-3 text-sm font-semibold text-zinc-300">Current wallet</h3>
        {!currentWallet && <div className="text-sm text-zinc-500">No wallet selected — go to Wallets.</div>}
        {currentWallet && balanceError && <ErrorBanner>{balanceError}</ErrorBanner>}
        {currentWallet && balance && (
          <div className="space-y-3">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-sm text-zinc-400">{balance.address}</span>
            </div>
            <div className="text-2xl font-semibold text-emerald-400">{balance.solUi.toFixed(6)} SOL</div>
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
                Token accounts ({balance.tokenCount})
              </div>
              {balance.tokens.length === 0 && <div className="text-sm text-zinc-600">None</div>}
              <ul className="space-y-1">
                {balance.tokens.map((t) => (
                  <li key={t.mint} className="flex justify-between font-mono text-xs text-zinc-400">
                    <span>
                      {t.mint.slice(0, 6)}…{t.mint.slice(-6)} ({t.program})
                    </span>
                    <span>{formatAmount(BigInt(t.amount), t.decimals)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-lg font-semibold text-zinc-100">{value}</div>
    </div>
  );
}
