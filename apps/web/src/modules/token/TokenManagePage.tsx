import { useEffect, useState } from "react";
import {
  burnTokens,
  getWalletBalance,
  mintTokens,
  parseAmount,
  PublicKey,
  type TokenBalance,
} from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { Button, Card, Input, Label } from "../../components/ui";
import { ResultView } from "../transfer/ResultView";
import type { SimpleTxOutcome } from "../transfer/ResultView";

export function TokenManagePage() {
  const { connection, state, currentWallet } = useApp();
  const keypair = state.unlockedKeypair;
  const isMainnet = state.cluster === "mainnet-beta";

  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [mode, setMode] = useState<"mint" | "burn">("mint");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SimpleTxOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mainnetAck, setMainnetAck] = useState(false);

  const refresh = () => {
    if (!currentWallet) return;
    setLoading(true);
    getWalletBalance(connection, new PublicKey(currentWallet.address))
      .then((b) => setTokens(b.tokens))
      .catch(() => setTokens([]))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, [connection, currentWallet]);

  const run = async () => {
    setError(null);
    setResult(null);
    if (!keypair || !active) return;
    const token = tokens.find((t) => t.mint === active);
    if (!token) return;
    try {
      const base = parseAmount(amount, token.decimals);
      setBusy(true);
      const opts = { allowMainnet: isMainnet ? mainnetAck : undefined };
      const res =
        mode === "mint"
          ? await mintTokens(connection, keypair, token.mint, keypair.publicKey, base, opts)
          : await burnTokens(connection, keypair, token.mint, base, opts);
      setResult(res);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-300">Your token assets</h3>
        <Button variant="ghost" onClick={refresh}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {!currentWallet && <div className="text-sm text-zinc-500">Select a wallet first.</div>}
      {currentWallet && tokens.length === 0 && !loading && (
        <div className="text-sm text-zinc-500">No token accounts found.</div>
      )}
      <ul className="space-y-1">
        {tokens.map((t) => (
          <li
            key={t.mint}
            className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 ${
              active === t.mint ? "border-emerald-700 bg-emerald-900/10" : "border-zinc-800"
            }`}
          >
            <div className="font-mono text-xs text-zinc-400">
              {t.mint} ({t.program}) — {t.uiAmount ?? 0}
            </div>
            <Button variant="default" onClick={() => { setActive(t.mint); setResult(null); setError(null); }}>
              Manage
            </Button>
          </li>
        ))}
      </ul>

      {active && (
        <div className="space-y-2 rounded-md border border-zinc-800 p-3">
          <div className="flex gap-2">
            <Button variant={mode === "mint" ? "primary" : "default"} onClick={() => setMode("mint")}>
              Mint
            </Button>
            <Button variant={mode === "burn" ? "primary" : "default"} onClick={() => setMode("burn")}>
              Burn
            </Button>
          </div>
          <div>
            <Label>Amount</Label>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          {isMainnet && (
            <label className="flex items-center gap-2 text-sm text-amber-300">
              <input type="checkbox" checked={mainnetAck} onChange={(e) => setMainnetAck(e.target.checked)} />
              I confirm this action on mainnet-beta.
            </label>
          )}
          {error && <div className="text-sm text-red-400">{error}</div>}
          <Button variant="primary" disabled={busy || !keypair} onClick={run}>
            {busy ? "Working…" : mode === "mint" ? "Mint" : "Burn"}
          </Button>
          <ResultView result={result} />
        </div>
      )}
    </Card>
  );
}
