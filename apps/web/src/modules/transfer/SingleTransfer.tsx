import { useState } from "react";
import { parseAmount, transfer, type TransferResult } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { Button, Card, Input, Label } from "../../components/ui";
import { ResultView } from "./ResultView";

export function SingleTransfer() {
  const { connection, state } = useApp();
  const keypair = state.unlockedKeypair;
  const isMainnet = state.cluster === "mainnet-beta";

  const [destination, setDestination] = useState("");
  const [mint, setMint] = useState("");
  const [decimals, setDecimals] = useState("9");
  const [amount, setAmount] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [mainnetAck, setMainnetAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TransferResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const send = async () => {
    setFormError(null);
    setResult(null);
    if (!keypair) {
      setFormError("Select/unlock a wallet first.");
      return;
    }
    const dec = mint ? Number(decimals) : 9;
    let amountBase: bigint;
    try {
      amountBase = parseAmount(amount, dec);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
      return;
    }
    setBusy(true);
    try {
      const res = await transfer(connection, {
        from: keypair,
        destination,
        mint: mint || undefined,
        decimals: mint ? dec : undefined,
        amount: amountBase,
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
      <div>
        <Label>Destination address</Label>
        <Input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="recipient pubkey" />
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
      <div>
        <Label>Amount</Label>
        <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 1.5" />
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
      {formError && <div className="text-sm text-red-400">{formError}</div>}
      <Button variant="primary" disabled={busy || !keypair} onClick={send}>
        {busy ? "Sending…" : dryRun ? "Simulate" : "Send"}
      </Button>
      <ResultView result={result} />
    </Card>
  );
}
