import { useEffect, useState } from "react";
import { getWalletBalance, type ClusterHealth, type WalletBalance, PublicKey } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT } from "../../lib/i18n";
import { Card, ErrorBanner } from "../../components/ui";
import { AmountValue } from "../../components/Amount";
import { CopyButton } from "../../components/CopyButton";

export function DashboardPage() {
  const t = useT();
  const { connection, currentWallet } = useApp();
  const [health, setHealth] = useState<ClusterHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [balance, setBalance] = useState<WalletBalance | null>(null);
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
        if (!cancelled) setBalance(b);
      })
      .catch((e: unknown) => {
        if (!cancelled) setBalanceError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [connection, currentWallet]);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">{t("dashboard.title")}</h2>

      <Card>
        <h3 className="mb-3 text-sm font-semibold text-zinc-300">{t("dashboard.clusterHealth")}</h3>
        {healthError && <ErrorBanner>{healthError}</ErrorBanner>}
        {!healthError && !health && <div className="text-sm text-zinc-500">{t("common.loading")}</div>}
        {health && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label={t("dashboard.cluster")} value={health.cluster} />
            <Stat label={t("dashboard.slot")} value={health.slot.toLocaleString()} />
            <Stat label={t("dashboard.version")} value={health.version} />
            <Stat label={t("dashboard.tps")} value={health.tps.toLocaleString()} />
          </div>
        )}
      </Card>

      <Card>
        <h3 className="mb-3 text-sm font-semibold text-zinc-300">{t("dashboard.currentWallet")}</h3>
        {!currentWallet && <div className="text-sm text-zinc-500">{t("dashboard.noWallet")}</div>}
        {currentWallet && balanceError && <ErrorBanner>{balanceError}</ErrorBanner>}
        {currentWallet && balance && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="break-all font-mono text-sm text-zinc-400">{balance.address}</span>
              <CopyButton text={balance.address} className="shrink-0" />
            </div>
            <div>
              <div className="text-xs text-zinc-500">{t("dashboard.solBalance")}</div>
              <div className="text-2xl font-semibold text-emerald-400">
                <AmountValue raw={balance.solLamports} decimals={9} symbol="SOL" unit={t("common.lamports")} stacked />
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs text-zinc-500">
                {t("dashboard.tokenAccounts", { n: balance.tokens.length })}
              </div>
              {balance.tokens.length === 0 && <div className="text-sm text-zinc-600">{t("common.none")}</div>}
              <ul className="space-y-1">
                {balance.tokens.map((tk) => (
                  <li key={tk.mint} className="flex flex-wrap justify-between gap-x-3 font-mono text-xs text-zinc-400">
                    <span>
                      {tk.mint.slice(0, 6)}…{tk.mint.slice(-6)} ({tk.program})
                    </span>
                    <AmountValue raw={tk.amount} decimals={tk.decimals} />
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
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-lg font-semibold text-zinc-100">{value}</div>
    </div>
  );
}
