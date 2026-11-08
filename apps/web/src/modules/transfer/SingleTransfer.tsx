import { useState } from "react";
import {
  buildTransferPlan,
  preflightTransfer,
  parseTransactionError,
  transfer,
  PublicKey,
  type PreflightResult,
  type TransactionPlan,
  type TransferResult,
} from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT } from "../../lib/i18n";
import { Button, Card, ErrorBanner, Input, Label } from "../../components/ui";
import { AmountHint, parseBaseUnits, parseDecimals } from "../../components/Amount";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ResultView } from "./ResultView";
import { AdvancedOptions, DEFAULT_ADVANCED, toKnobs, type AdvancedState } from "./AdvancedOptions";
import { PlanView, PreflightFindings } from "./PlanPreview";

interface Preview {
  plan: TransactionPlan | null;
  buildError: string | null;
  preflight: PreflightResult | null;
}

export function SingleTransfer() {
  const t = useT();
  const { connection, state, currentWallet } = useApp();
  const keypair = state.unlockedKeypair;
  const isMainnet = state.cluster === "mainnet-beta";

  const [destination, setDestination] = useState("");
  const [mint, setMint] = useState("");
  const [decimals, setDecimals] = useState("9");
  const [amount, setAmount] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [mainnetAck, setMainnetAck] = useState(false);
  const [advanced, setAdvanced] = useState<AdvancedState>(DEFAULT_ADVANCED);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<TransferResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmForce, setConfirmForce] = useState(false);

  const isToken = mint.trim().length > 0;
  const hintDecimals = isToken ? parseDecimals(decimals) : 9;

  /** Parse shared inputs; returns null (and sets formError) when invalid. Amount is raw base units. */
  const parseInputs = () => {
    try {
      const dec = isToken ? parseDecimals(decimals) : 9;
      if (dec === null) throw new Error(t("adv.err.nonNegInt", { field: "decimals" }));
      const amountBase = parseBaseUnits(amount, t);
      const knobs = toKnobs(advanced, isToken, t);
      const dest = new PublicKey(destination.trim());
      const mintKey = isToken ? new PublicKey(mint.trim()) : undefined;
      return { dec, amountBase, knobs, dest, mintKey };
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  const runPreview = async () => {
    setFormError(null);
    setPreview(null);
    const payerAddr = keypair?.publicKey.toBase58() ?? currentWallet?.address;
    if (!payerAddr) {
      setFormError(t("transfer.previewNeedsWallet"));
      return;
    }
    const parsed = parseInputs();
    if (!parsed) return;
    const opts = {
      payer: new PublicKey(payerAddr),
      destination: parsed.dest,
      mint: parsed.mintKey,
      decimals: parsed.mintKey ? parsed.dec : undefined,
      amount: parsed.amountBase,
      ...parsed.knobs,
    };
    setPreviewing(true);
    const next: Preview = { plan: null, buildError: null, preflight: null };
    try {
      if (!advanced.skipPreflight) {
        try {
          next.preflight = await preflightTransfer(connection, opts);
        } catch (e) {
          const pe = parseTransactionError(e);
          next.buildError = `${pe.code}: ${pe.message}`;
        }
      }
      try {
        const { plan } = await buildTransferPlan(connection, opts);
        next.plan = plan;
      } catch (e) {
        const pe = parseTransactionError(e);
        next.buildError = `${pe.code}: ${pe.message}${pe.suggestion ? ` — ${pe.suggestion}` : ""}`;
      }
      setPreview(next);
    } finally {
      setPreviewing(false);
    }
  };

  const send = async (force: boolean) => {
    setFormError(null);
    setResult(null);
    if (!keypair) {
      setFormError(t("common.selectUnlockFirst"));
      return;
    }
    const parsed = parseInputs();
    if (!parsed) return;
    setBusy(true);
    try {
      const res = await transfer(connection, {
        from: keypair,
        destination: parsed.dest,
        mint: parsed.mintKey,
        decimals: parsed.mintKey ? parsed.dec : undefined,
        amount: parsed.amountBase,
        dryRun,
        allowMainnet: isMainnet ? mainnetAck : undefined,
        ...parsed.knobs,
        force: force || advanced.force || undefined,
        skipPreflight: advanced.skipPreflight || undefined,
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
      <div>
        <Label htmlFor="singletransfer-destination-address">{t("transfer.destination")}</Label>
        <Input id="singletransfer-destination-address" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder={t("transfer.destinationPlaceholder")} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="singletransfer-mint">{t("transfer.mint")}</Label>
          <Input id="singletransfer-mint" value={mint} onChange={(e) => setMint(e.target.value)} placeholder={t("transfer.mintPlaceholder")} />
        </div>
        <div>
          <Label htmlFor="singletransfer-decimals">{t("transfer.decimals")}</Label>
          <Input id="singletransfer-decimals" inputMode="numeric" value={decimals} onChange={(e) => setDecimals(e.target.value)} disabled={!isToken} />
        </div>
      </div>
      <div>
        <Label htmlFor="singletransfer-amount">{t("transfer.amount")}</Label>
        <Input id="singletransfer-amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t("transfer.amountPlaceholder")} />
        <AmountHint value={amount} decimals={hintDecimals} sol={!isToken} />
      </div>
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

      <AdvancedOptions value={advanced} onChange={setAdvanced} isToken={isToken} />

      {formError && <div className="text-sm text-red-400">{formError}</div>}
      <div className="flex flex-wrap gap-2">
        <Button variant="default" disabled={previewing || busy} onClick={runPreview}>
          {previewing ? t("transfer.building") : t("transfer.preview")}
        </Button>
        <Button variant="primary" disabled={busy || !keypair} onClick={() => send(false)}>
          {busy ? t("common.sending") : dryRun ? t("common.simulate") : t("common.send")}
        </Button>
      </div>

      {preview && (
        <div className="space-y-3 rounded-md border border-zinc-800 p-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-zinc-300">{t("transfer.previewTitle")}</h4>
            <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={() => setPreview(null)}>
              {t("common.close")}
            </Button>
          </div>
          {preview.preflight && <PreflightFindings preflight={preview.preflight} />}
          {preview.buildError && <ErrorBanner>{t("transfer.buildFailed", { error: preview.buildError })}</ErrorBanner>}
          {preview.plan && <PlanView plan={preview.plan} />}
        </div>
      )}

      <ResultView result={result} forcing={busy} onForce={() => setConfirmForce(true)} />

      {confirmForce && (
        <ConfirmDialog
          title={t("transfer.forceTitle")}
          description={
            <div className="space-y-1">
              <div>{t("transfer.forceDesc1")}</div>
              <div className="text-amber-300">{t("transfer.forceDesc2")}</div>
            </div>
          }
          confirmLabel={t("transfer.forceSend")}
          danger
          onConfirm={() => {
            setConfirmForce(false);
            void send(true);
          }}
          onCancel={() => setConfirmForce(false)}
        />
      )}
    </Card>
  );
}
