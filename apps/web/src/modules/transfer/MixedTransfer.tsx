import { useState } from "react";
import { executeMixedTransfer, type MixedLeg, type MixedTransferResult } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT } from "../../lib/i18n";
import { Button, Card, Input, Label } from "../../components/ui";
import { AmountHint, parseBaseUnits, parseDecimals } from "../../components/Amount";
import { ResultView } from "./ResultView";
import { MintPicker, useOwnedTokens } from "./MintPicker";

interface LegDraft {
  kind: "sol" | "token";
  to: string;
  mint: string;
  decimals: string;
  /** Raw base-unit amount. */
  amount: string;
}

function emptyLeg(): LegDraft {
  return { kind: "sol", to: "", mint: "", decimals: "9", amount: "" };
}

export function MixedTransfer() {
  const t = useT();
  const { connection, state } = useApp();
  const keypair = state.unlockedKeypair;
  const isMainnet = state.cluster === "mainnet-beta";

  const [legs, setLegs] = useState<LegDraft[]>([emptyLeg()]);
  const [dryRun, setDryRun] = useState(true);
  const [mainnetAck, setMainnetAck] = useState(false);
  const owned = useOwnedTokens();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MixedTransferResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const update = (i: number, patch: Partial<LegDraft>) =>
    setLegs((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const send = async () => {
    setFormError(null);
    setResult(null);
    if (!keypair) {
      setFormError(t("common.selectUnlockFirst"));
      return;
    }
    try {
      const built: MixedLeg[] = legs.map((l, i) => {
        try {
          const dec = l.kind === "token" ? parseDecimals(l.decimals) : 9;
          if (dec === null) throw new Error(t("adv.err.nonNegInt", { field: "decimals" }));
          return {
            kind: l.kind,
            to: l.to,
            mint: l.kind === "token" ? l.mint : undefined,
            decimals: l.kind === "token" ? dec : undefined,
            amount: parseBaseUnits(l.amount, t),
          };
        } catch (e) {
          throw new Error(t("mixed.legInvalid", { n: i + 1, error: e instanceof Error ? e.message : String(e) }));
        }
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
      <Label>{t("mixed.legs")}</Label>
      <div className="space-y-3">
        {legs.map((leg, i) => (
          <div key={i} className="rounded-md border border-zinc-800 p-2">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-12">
              <select
                aria-label={t("mixed.legKind", { n: i + 1 })}
                value={leg.kind}
                onChange={(e) => update(i, { kind: e.target.value as "sol" | "token" })}
                className="col-span-2 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
              >
                <option value="sol">SOL</option>
                <option value="token">{t("mixed.token")}</option>
              </select>
              <Input
                className="font-mono col-span-2 sm:col-span-4"
                aria-label={t("mixed.legDestination", { n: i + 1 })}
                placeholder={t("mixed.destination")}
                value={leg.to}
                onChange={(e) => update(i, { to: e.target.value })}
              />
              {leg.kind === "token" && (
                <>
                  <div className="col-span-2 sm:col-span-3">
                    <MintPicker
                      ariaLabel={t("mixed.legMint", { n: i + 1 })}
                      placeholder={t("mixed.mint")}
                      value={leg.mint}
                      onChange={(mint) => update(i, { mint })}
                      onDecimals={(d) => update(i, { decimals: String(d) })}
                      owned={owned}
                    />
                  </div>
                  <Input
                    className="col-span-2 sm:col-span-1"
                    inputMode="numeric"
                    aria-label={t("mixed.legDecimals", { n: i + 1 })}
                    placeholder={t("mixed.dec")}
                    value={leg.decimals}
                    onChange={(e) => update(i, { decimals: e.target.value })}
                  />
                </>
              )}
              <Input
                className={leg.kind === "token" ? "col-span-2 sm:col-span-1" : "col-span-2 sm:col-span-5"}
                inputMode="numeric"
                aria-label={t("mixed.legAmount", { n: i + 1 })}
                placeholder={t("mixed.amount")}
                value={leg.amount}
                onChange={(e) => update(i, { amount: e.target.value })}
              />
              <Button
                variant="ghost"
                className="col-span-2 sm:col-span-1"
                aria-label={t("mixed.removeLeg", { n: i + 1 })}
                onClick={() => setLegs((prev) => prev.filter((_, idx) => idx !== i))}
              >
                x
              </Button>
            </div>
            <AmountHint
              value={leg.amount}
              decimals={leg.kind === "token" ? parseDecimals(leg.decimals) : 9}
              sol={leg.kind === "sol"}
            />
          </div>
        ))}
      </div>
      <Button variant="default" onClick={() => setLegs((prev) => [...prev, emptyLeg()])}>
        {t("mixed.addLeg")}
      </Button>

      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
        {t("transfer.dryRunFirst")}
      </label>
      {isMainnet && (
        <label className="flex items-center gap-2 text-sm text-amber-300">
          <input type="checkbox" checked={mainnetAck} onChange={(e) => setMainnetAck(e.target.checked)} />
          {t("common.mainnetAckSend")}
        </label>
      )}
      {formError && <div className="text-sm text-red-400">{formError}</div>}
      <Button variant="primary" disabled={busy || !keypair} onClick={send}>
        {busy ? t("common.sending") : dryRun ? t("common.simulate") : t("common.send")}
      </Button>
      <ResultView result={result} />
    </Card>
  );
}
