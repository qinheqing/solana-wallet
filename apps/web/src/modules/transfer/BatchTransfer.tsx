import { useState } from "react";
import {
  buildTransferInstructions,
  executeBatchTransfer,
  parseAmount,
  PublicKey,
  type BatchItem,
  type BatchResult,
} from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { Badge, Button, Card, Input, Label, Textarea } from "../../components/ui";

interface ParsedLine {
  raw: string;
  destination?: string;
  amount?: string;
  error?: string;
}

function parseLines(text: string): ParsedLine[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((raw) => {
      const parts = raw.split(",").map((p) => p.trim());
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return { raw, error: "expected: address,amount" };
      }
      return { raw, destination: parts[0], amount: parts[1] };
    });
}

export function BatchTransfer() {
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

  const lines = parseLines(text);
  const lineErrors = lines.filter((l) => l.error);

  const run = async () => {
    setFormError(null);
    setResults(null);
    if (!keypair) {
      setFormError("Select/unlock a wallet first.");
      return;
    }
    if (lines.length === 0 || lineErrors.length > 0) {
      setFormError("Fix invalid lines before sending.");
      return;
    }
    setBusy(true);
    try {
      const dec = mint ? Number(decimals) : 9;
      const mintKey = mint ? new PublicKey(mint) : undefined;
      const items: BatchItem[] = [];
      for (const l of lines) {
        const destination = new PublicKey(l.destination!);
        const amountBase = parseAmount(l.amount!, dec);
        const built = await buildTransferInstructions(connection, {
          payer: keypair.publicKey,
          destination,
          mint: mintKey,
          amount: amountBase,
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
        <Label>Recipients (one per line: address,amount)</Label>
        <Textarea
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"7xKX...abc,0.5\n9yLm...def,1.25"}
        />
        {lineErrors.length > 0 && (
          <div className="mt-1 text-xs text-red-400">{lineErrors.length} invalid line(s)</div>
        )}
        <div className="mt-1 text-xs text-zinc-500">{lines.length - lineErrors.length} valid recipient(s)</div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Mint (leave empty for SOL)</Label>
          <Input value={mint} onChange={(e) => setMint(e.target.value)} placeholder="optional mint address" />
        </div>
        <div>
          <Label>Decimals (token only)</Label>
          <Input value={decimals} onChange={(e) => setDecimals(e.target.value)} disabled={!mint} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
        Dry run (simulate each batch)
      </label>
      {isMainnet && (
        <label className="flex items-center gap-2 text-sm text-amber-300">
          <input type="checkbox" checked={mainnetAck} onChange={(e) => setMainnetAck(e.target.checked)} />
          I confirm sending real funds on mainnet-beta.
        </label>
      )}
      {formError && <div className="text-sm text-red-400">{formError}</div>}
      <Button variant="primary" disabled={busy || !keypair} onClick={run}>
        {busy ? "Running…" : dryRun ? "Simulate batches" : "Send batches"}
      </Button>

      {results && (
        <div className="space-y-2">
          {results.map((batch) => (
            <div key={batch.batchIndex} className="rounded-md border border-zinc-800 p-2">
              <div className="mb-1 text-xs text-zinc-500">
                Batch {batch.batchIndex} · ~{batch.estimatedBytes} bytes
              </div>
              <ul className="space-y-1">
                {batch.results.map((r, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 font-mono text-xs">
                    <span className="truncate text-zinc-400">{r.to}</span>
                    <Badge tone={r.status === "success" ? "success" : r.status === "failed" ? "danger" : "default"}>
                      {r.status}
                    </Badge>
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
