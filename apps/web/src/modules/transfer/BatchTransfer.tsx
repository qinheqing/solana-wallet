import { useState } from "react";
import {
  buildTransferInstructions,
  executeBatchTransfer,
  PublicKey,
  type BatchItem,
  type BatchResult,
} from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT } from "../../lib/i18n";
import { Badge, Button, Card, Input, Label, Textarea } from "../../components/ui";
import { amountHintText, isBaseUnits, parseDecimals } from "../../components/Amount";

interface ParsedLine {
  raw: string;
  destination?: string;
  /** Raw base-unit amount (validated: digits only, > 0). */
  amount?: string;
  error?: boolean;
}

function parseLines(text: string): ParsedLine[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((raw) => {
      const parts = raw.split(",").map((p) => p.trim());
      if (parts.length !== 2 || !parts[0] || !parts[1] || !isBaseUnits(parts[1])) {
        return { raw, error: true };
      }
      return { raw, destination: parts[0], amount: parts[1] };
    });
}

export function BatchTransfer() {
  const t = useT();
  const { connection, state } = useApp();
  const keypair = state.unlockedKeypair;
  const isMainnet = state.cluster === "mainnet-beta";

  const [text, setText] = useState("");
  const [mint, setMint] = useState("");
  const [decimals, setDecimals] = useState("9");
  const [dryRun, setDryRun] = useState(true);
  const [mainnetAck, setMainnetAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const isToken = mint.trim().length > 0;
  const hintDecimals = isToken ? parseDecimals(decimals) : 9;
  const lines = parseLines(text);
  const lineErrors = lines.filter((l) => l.error);

  const run = async () => {
    setFormError(null);
    setResults(null);
    if (!keypair) {
      setFormError(t("common.selectUnlockFirst"));
      return;
    }
    if (lines.length === 0 || lineErrors.length > 0) {
      setFormError(t("batch.fixLines"));
      return;
    }
    setBusy(true);
    try {
      const dec = isToken ? parseDecimals(decimals) : 9;
      if (dec === null) throw new Error(t("adv.err.nonNegInt", { field: "decimals" }));
      const mintKey = isToken ? new PublicKey(mint.trim()) : undefined;
      const items: BatchItem[] = [];
      for (const l of lines) {
        const destination = new PublicKey(l.destination!);
        const built = await buildTransferInstructions(connection, {
          payer: keypair.publicKey,
          destination,
          mint: mintKey,
          amount: BigInt(l.amount!),
          decimals: mintKey ? dec : undefined,
        });
        items.push({ destination, instructions: built.instructions });
      }
      const out = await executeBatchTransfer(connection, keypair, items, {
        dryRun,
        allowMainnet: isMainnet ? mainnetAck : undefined,
      });
      setResults(out);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3">
      <div>
        <Label htmlFor="batchtransfer-recipients">{t("batch.recipients")}</Label>
        <Textarea
          id="batchtransfer-recipients"
          rows={6}
          className="font-mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("batch.placeholder")}
        />
        {lineErrors.length > 0 && (
          <div className="mt-1 text-xs text-red-400">
            {t("batch.invalidLines", { n: lineErrors.length })} — {t("batch.lineError")}
          </div>
        )}
        <div className="mt-1 text-xs text-zinc-500">{t("batch.validRecipients", { n: lines.length - lineErrors.length })}</div>
        {lines.some((l) => !l.error) && (
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-xs text-zinc-500">
            {lines.map((l, i) => {
              if (l.error) return null;
              const hint = amountHintText(t, l.amount!, hintDecimals, !isToken);
              return (
                <li key={i} className="font-mono">
                  {t("batch.line", { n: i + 1 })} {l.amount} {hint?.text}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="batchtransfer-mint">{t("transfer.mint")}</Label>
          <Input id="batchtransfer-mint" value={mint} onChange={(e) => setMint(e.target.value)} placeholder={t("transfer.mintPlaceholder")} />
        </div>
        <div>
          <Label htmlFor="batchtransfer-decimals">{t("transfer.decimals")}</Label>
          <Input id="batchtransfer-decimals" inputMode="numeric" value={decimals} onChange={(e) => setDecimals(e.target.value)} disabled={!isToken} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
        {t("batch.dryRun")}
      </label>
      {isMainnet && (
        <label className="flex items-center gap-2 text-sm text-amber-300">
          <input type="checkbox" checked={mainnetAck} onChange={(e) => setMainnetAck(e.target.checked)} />
          {t("common.mainnetAckSend")}
        </label>
      )}
      {formError && <div className="text-sm text-red-400">{formError}</div>}
      <Button variant="primary" disabled={busy || !keypair} onClick={run}>
        {busy ? t("batch.running") : dryRun ? t("batch.simulate") : t("batch.send")}
      </Button>

      {results && (
        <div className="space-y-2">
          {results.map((batch) => (
            <div key={batch.batchIndex} className="rounded-md border border-zinc-800 p-2">
              <div className="mb-1 text-xs text-zinc-500">{t("batch.header", { index: batch.batchIndex, bytes: batch.estimatedBytes })}</div>
              <ul className="space-y-1">
                {batch.results.map((r, i) => (
                  <li key={i} className="font-mono text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-zinc-400">{r.to}</span>
                      <Badge tone={r.status === "success" ? "success" : r.status === "failed" ? "danger" : "default"}>
                        {r.status}
                      </Badge>
                    </div>
                    {r.error && (
                      <div className="mt-0.5 text-red-400">
                        {r.error.code}: {r.error.message}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
