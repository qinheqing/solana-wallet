import { useState } from "react";
import { serializeKeypairJson } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT } from "../../lib/i18n";
import { copyText } from "../../lib/clipboard";
import { Badge, Button, Card, Input, RiskBanner } from "../../components/ui";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import type { StoredWalletRecord } from "../../lib/types";

export function WalletList() {
  const t = useT();
  const { state, currentWallet, unlockWallet, removeWallet } = useApp();
  const [deleteTarget, setDeleteTarget] = useState<StoredWalletRecord | null>(null);
  const [exportTarget, setExportTarget] = useState<StoredWalletRecord | null>(null);
  const [unlockTarget, setUnlockTarget] = useState<StoredWalletRecord | null>(null);
  const [password, setPassword] = useState("");
  const [exportedSecret, setExportedSecret] = useState<string | null>(null);
  const [exportConfirmed, setExportConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  const copyAddress = async (addr: string) => {
    const ok = await copyText(addr);
    setCopyMsg(ok ? addr : "copy-failed");
    setTimeout(() => setCopyMsg(null), 1500);
  };

  const doSwitch = async (w: StoredWalletRecord) => {
    if (w.encrypted) {
      setUnlockTarget(w);
      setPassword("");
      setError(null);
      return;
    }
    try {
      await unlockWallet(w.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const confirmUnlock = async () => {
    if (!unlockTarget) return;
    try {
      await unlockWallet(unlockTarget.id, password);
      setUnlockTarget(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const startExport = (w: StoredWalletRecord) => {
    if (w.encrypted) {
      setUnlockTarget(null);
    }
    setExportTarget(w);
    setExportedSecret(null);
    setExportConfirmed(false);
    setPassword("");
    setError(null);
  };

  const revealSecret = async () => {
    if (!exportTarget) return;
    try {
      const keypair = await unlockWallet(exportTarget.id, exportTarget.encrypted ? password : undefined);
      setExportedSecret(serializeKeypairJson(keypair));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Card className="space-y-3">
      <h3 className="text-sm font-semibold text-zinc-300">{t("wallet.list.title", { n: state.wallets.length })}</h3>
      {state.wallets.length === 0 && <div className="text-sm text-zinc-500">{t("wallet.list.empty")}</div>}
      <ul className="space-y-2">
        {state.wallets.map((w) => (
          <li
            key={w.id}
            className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 ${
              currentWallet?.id === w.id ? "border-emerald-700 bg-emerald-900/10" : "border-zinc-800"
            }`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm text-zinc-100">{w.name}</span>
                {w.encrypted ? <Badge tone="success">{t("common.encrypted")}</Badge> : <Badge tone="warn">{t("common.plaintext")}</Badge>}
                {currentWallet?.id === w.id && <Badge>{t("common.active")}</Badge>}
              </div>
              <div className="truncate font-mono text-xs text-zinc-500">{w.address}</div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button variant="ghost" onClick={() => copyAddress(w.address)}>
                {copyMsg === w.address ? t("common.copied") : copyMsg === "copy-failed" ? t("common.copyFailed") : t("common.copy")}
              </Button>
              <Button variant="default" onClick={() => doSwitch(w)}>
                {t("wallet.select")}
              </Button>
              <Button variant="ghost" onClick={() => startExport(w)}>
                {t("wallet.export")}
              </Button>
              <Button variant="danger" onClick={() => setDeleteTarget(w)}>
                {t("wallet.delete")}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {unlockTarget && !exportTarget && (
        <div className="space-y-2 rounded-md border border-zinc-700 bg-zinc-950 p-3">
          <div className="text-sm text-zinc-300">{t("wallet.unlockTitle", { name: unlockTarget.name })}</div>
          <Input
            type="password"
            aria-label={t("wallet.passwordFor", { name: unlockTarget.name })}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("wallet.password")}
          />
          {error && <div className="text-sm text-red-400">{error}</div>}
          <div className="flex gap-2">
            <Button variant="primary" onClick={confirmUnlock}>
              {t("wallet.unlock")}
            </Button>
            <Button variant="ghost" onClick={() => setUnlockTarget(null)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}

      {exportTarget && (
        <div className="space-y-2 rounded-md border border-zinc-700 bg-zinc-950 p-3">
          <RiskBanner>{t("wallet.exportWarning", { name: exportTarget.name })}</RiskBanner>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={exportConfirmed} onChange={(e) => setExportConfirmed(e.target.checked)} />
            {t("wallet.exportAck")}
          </label>
          {exportTarget.encrypted && !exportedSecret && (
            <Input
              type="password"
              aria-label={t("wallet.passwordFor", { name: exportTarget.name })}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("wallet.password")}
            />
          )}
          {error && <div className="text-sm text-red-400">{error}</div>}
          {!exportedSecret && (
            <div className="flex gap-2">
              <Button variant="danger" disabled={!exportConfirmed} onClick={revealSecret}>
                {t("wallet.reveal")}
              </Button>
              <Button variant="ghost" onClick={() => setExportTarget(null)}>
                {t("common.cancel")}
              </Button>
            </div>
          )}
          {exportedSecret && (
            <div className="space-y-2">
              <textarea
                readOnly
                aria-label={t("wallet.exportedSecret")}
                value={exportedSecret}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs text-zinc-200"
                rows={3}
              />
              <Button
                variant="ghost"
                onClick={() => {
                  setExportTarget(null);
                  setExportedSecret(null);
                }}
              >
                {t("common.done")}
              </Button>
            </div>
          )}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={t("wallet.deleteTitle", { name: deleteTarget.name })}
          description={t("wallet.deleteDesc")}
          requireText={deleteTarget.name}
          confirmLabel={t("wallet.delete")}
          onConfirm={() => {
            removeWallet(deleteTarget.id);
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </Card>
  );
}
