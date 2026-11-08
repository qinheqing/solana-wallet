import { useState } from "react";
import {
  buildTransferPlan,
  parseAmount,
  preflightTransfer,
  parseTransactionError,
  transfer,
  PublicKey,
  type PreflightResult,
  type TransactionPlan,
  type TransferResult,
} from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { Button, Card, ErrorBanner, Input, Label } from "../../components/ui";
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

  /** Parse shared inputs; returns null (and sets formError) when invalid. */
  const parseInputs = () => {
    const dec = isToken ? Number(decimals) : 9;
    try {
      const amountBase = parseAmount(amount, dec);
      const knobs = toKnobs(advanced, isToken);
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
      setFormError("请先选择一个钱包（预览无需解锁）。");
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
      setFormError("Select/unlock a wallet first.");
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
        <Label htmlFor="singletransfer-destination-address">Destination address</Label>
        <Input id="singletransfer-destination-address" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="recipient pubkey" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="singletransfer-mint">Mint (leave empty for SOL)</Label>
          <Input id="singletransfer-mint" value={mint} onChange={(e) => setMint(e.target.value)} placeholder="optional mint address" />
        </div>
        <div>
          <Label htmlFor="singletransfer-decimals">Decimals (token only)</Label>
          <Input id="singletransfer-decimals" value={decimals} onChange={(e) => setDecimals(e.target.value)} disabled={!isToken} />
        </div>
      </div>
      <div>
        <Label htmlFor="singletransfer-amount">Amount</Label>
        <Input id="singletransfer-amount" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 1.5" />
      </div>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
        Dry run (simulate only, recommended first)
      </label>
      {isMainnet && (
        <label className="flex items-center gap-2 text-sm text-amber-300">
          <input type="checkbox" checked={mainnetAck} onChange={(e) => setMainnetAck(e.target.checked)} />
          I confirm sending real funds on mainnet-beta.
        </label>
      )}

      <AdvancedOptions value={advanced} onChange={setAdvanced} isToken={isToken} />

      {formError && <div className="text-sm text-red-400">{formError}</div>}
      <div className="flex flex-wrap gap-2">
        <Button variant="default" disabled={previewing || busy} onClick={runPreview}>
          {previewing ? "构造中…" : "预览"}
        </Button>
        <Button variant="primary" disabled={busy || !keypair} onClick={() => send(false)}>
          {busy ? "Sending…" : dryRun ? "Simulate" : "Send"}
        </Button>
      </div>

      {preview && (
        <div className="space-y-3 rounded-md border border-zinc-800 p-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-zinc-300">预览（未签名、未发送）</h4>
            <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={() => setPreview(null)}>
              关闭
            </Button>
          </div>
          {preview.preflight && <PreflightFindings preflight={preview.preflight} />}
          {preview.buildError && <ErrorBanner>构造失败：{preview.buildError}</ErrorBanner>}
          {preview.plan && <PlanView plan={preview.plan} />}
        </div>
      )}

      <ResultView result={result} forcing={busy} onForce={() => setConfirmForce(true)} />

      {confirmForce && (
        <ConfirmDialog
          title="强制发送（绕过预检）"
          description={
            <div className="space-y-1">
              <div>将以 force: true 重新提交，忽略预检 block 级发现。</div>
              <div className="text-amber-300">交易很可能在链上失败并扣除手续费；仅用于测试错误处理路径。</div>
            </div>
          }
          confirmLabel="强制发送"
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
