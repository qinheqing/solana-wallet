import { useState } from "react";
import { executeMixedTransfer, parseAmount, type MixedLeg, type MixedTransferResult } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { Button, Card, Input, Label } from "../../components/ui";
import { ResultView } from "./ResultView";

interface LegDraft {
  kind: "sol" | "token";
  to: string;
  mint: string;
  decimals: string;
  amount: string;
}

function emptyLeg(): LegDraft {
  return { kind: "sol", to: "", mint: "", decimals: "9", amount: "" };
}

export function MixedTransfer() {
  const { connection, state } = useApp();
  const keypair = state.unlockedKeypair;
  const isMainnet = state.cluster === "mainnet-beta";

  const [legs, setLegs] = useState<LegDraft[]>([emptyLeg()]);
  const [dryRun, setDryRun] = useState(true);
  const [mainnetAck, setMainnetAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MixedTransferResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const update = (i: number, patch: Partial<LegDraft>) =>
    setLegs((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const send = async () => {
    setFormError(null);
    setResult(null);
    if (!keypair) {
      setFormError("Select/unlock a wallet first.");
      return;
    }
    try {
      const built: MixedLeg[] = legs.map((l) => {
        const dec = Number(l.decimals);
        return {
          kind: l.kind,
          to: l.to,
          mint: l.kind === "token" ? l.mint : undefined,
          decimals: l.kind === "token" ? dec : undefined,
          amount: parseAmount(l.amount, l.kind === "token" ? dec : 9),
        };
      });
      setBusy(true);
      const res = await executeMixedTransfer(connection, keypair, built, {
        dryRun,
        allowMainnet: isMainnet ? mainnetAck : undefined,
      });
      setResult(res);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3">
      <Label>Legs (merged into one transaction)</Label>
      <div className="space-y-3">
        {legs.map((leg, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 rounded-md border border-zinc-800 p-2 sm:grid-cols-12">
            <select
              aria-label={`Leg ${i + 1} kind`}
              value={leg.kind}
              onChange={(e) => update(i, { kind: e.target.value as "sol" | "token" })}
              className="col-span-2 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
            >
              <option value="sol">SOL</option>
              <option value="token">Token</option>
            </select>
            <Input
              className="col-span-2 sm:col-span-4"
              aria-label={`Leg ${i + 1} destination`}
              placeholder="destination"
              value={leg.to}
              onChange={(e) => update(i, { to: e.target.value })}
            />
            {leg.kind === "token" && (
              <>
                <Input
                  className="col-span-2 sm:col-span-3"
                  aria-label={`Leg ${i + 1} mint`}
                  placeholder="mint"
                  value={leg.mint}
                  onChange={(e) => update(i, { mint: e.target.value })}
                />
                <Input
                  className="col-span-2 sm:col-span-1"
                  aria-label={`Leg ${i + 1} decimals`}
                  placeholder="dec"
                  value={leg.decimals}
                  onChange={(e) => update(i, { decimals: e.target.value })}
                />
              </>
            )}
            <Input
              className={leg.kind === "token" ? "col-span-2 sm:col-span-1" : "col-span-2 sm:col-span-5"}
              aria-label={`Leg ${i + 1} amount`}
              placeholder="amount"
              value={leg.amount}
              onChange={(e) => update(i, { amount: e.target.value })}
            />
            <Button
              variant="ghost"
              className="col-span-2 sm:col-span-1"
              aria-label={`Remove leg ${i + 1}`}
              onClick={() => setLegs((prev) => prev.filter((_, idx) => idx !== i))}
            >
              x
            </Button>
          </div>
        ))}
      </div>
      <Button variant="default" onClick={() => setLegs((prev) => [...prev, emptyLeg()])}>
        + Add leg
      </Button>

      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
        Dry run (simulate only)
      </label>
      {isMainnet && (
        <label className="flex items-center gap-2 text-sm text-amber-300">
          <input type="checkbox" checked={mainnetAck} onChange={(e) => setMainnetAck(e.target.checked)} />
          I confirm sending real funds on mainnet-beta.
        </label>
      )}
      {formError && <div className="text-sm text-red-400">{formError}</div>}
      <Button variant="primary" disabled={busy || !keypair} onClick={send}>
        {busy ? "Sending…" : dryRun ? "Simulate" : "Send"}
      </Button>
      <ResultView result={result} />
    </Card>
  );
}
