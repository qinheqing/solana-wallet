import { useState } from "react";
import { serializeKeypairJson } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { Badge, Button, Card, Input, RiskBanner } from "../../components/ui";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import type { StoredWalletRecord } from "../../lib/types";

export function WalletList() {
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
    await navigator.clipboard.writeText(addr);
    setCopyMsg(addr);
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
      <h3 className="text-sm font-semibold text-zinc-300">Wallets ({state.wallets.length})</h3>
      {state.wallets.length === 0 && <div className="text-sm text-zinc-500">No wallets yet.</div>}
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
                {w.encrypted ? <Badge tone="success">encrypted</Badge> : <Badge tone="warn">plaintext</Badge>}
                {currentWallet?.id === w.id && <Badge>active</Badge>}
              </div>
              <div className="truncate font-mono text-xs text-zinc-500">{w.address}</div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button variant="ghost" onClick={() => copyAddress(w.address)}>
                {copyMsg === w.address ? "Copied" : "Copy"}
              </Button>
              <Button variant="default" onClick={() => doSwitch(w)}>
                Select
              </Button>
              <Button variant="ghost" onClick={() => startExport(w)}>
                Export
              </Button>
              <Button variant="danger" onClick={() => setDeleteTarget(w)}>
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {unlockTarget && !exportTarget && (
        <div className="space-y-2 rounded-md border border-zinc-700 bg-zinc-950 p-3">
          <div className="text-sm text-zinc-300">Unlock &quot;{unlockTarget.name}&quot;</div>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
          {error && <div className="text-sm text-red-400">{error}</div>}
          <div className="flex gap-2">
            <Button variant="primary" onClick={confirmUnlock}>
              Unlock
            </Button>
            <Button variant="ghost" onClick={() => setUnlockTarget(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {exportTarget && (
        <div className="space-y-2 rounded-md border border-zinc-700 bg-zinc-950 p-3">
          <RiskBanner>
            Exporting reveals the raw secret key for &quot;{exportTarget.name}&quot;. Anyone who sees it can steal
            these funds.
          </RiskBanner>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={exportConfirmed} onChange={(e) => setExportConfirmed(e.target.checked)} />
            I understand the risk and want to reveal the secret key.
          </label>
          {exportTarget.encrypted && !exportedSecret && (
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
            />
          )}
          {error && <div className="text-sm text-red-400">{error}</div>}
          {!exportedSecret && (
            <div className="flex gap-2">
              <Button variant="danger" disabled={!exportConfirmed} onClick={revealSecret}>
                Reveal secret key
              </Button>
              <Button variant="ghost" onClick={() => setExportTarget(null)}>
                Cancel
              </Button>
            </div>
          )}
          {exportedSecret && (
            <div className="space-y-2">
              <textarea
                readOnly
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
                Done
              </Button>
            </div>
          )}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete wallet "${deleteTarget.name}"?`}
          description="This removes it from local storage permanently. Make sure you have a backup (mnemonic or keyfile) if you want to use it again."
          requireText={deleteTarget.name}
          confirmLabel="Delete"
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
