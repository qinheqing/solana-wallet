import { useState } from "react";
import { deriveTokenAddresses, parseTransactionError, type DerivedTokenAddresses } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { Badge, Button, Card, ErrorBanner, Input, Label } from "../../components/ui";
import { CopyButton } from "../../components/CopyButton";

function AtaRow({ title, address, programId, isOffCurve }: { title: string; address: string; programId: string; isOffCurve: boolean }) {
  return (
    <div className="rounded-md border border-zinc-800 p-2">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-zinc-200">{title}</span>
        <span className="font-mono text-zinc-500" title={programId}>
          {programId.slice(0, 6)}…
        </span>
        <Badge tone={isOffCurve ? "default" : "warn"}>{isOffCurve ? "off-curve (PDA)" : "on-curve"}</Badge>
      </div>
      <div className="flex items-start gap-2">
        <span className="min-w-0 break-all font-mono text-xs text-zinc-100">{address}</span>
        <CopyButton text={address} />
      </div>
    </div>
  );
}

/** owner + mint → legacy & Token-2022 ATAs via deriveTokenAddresses. Pure, no RPC. */
export function AddressToolsCard() {
  const { currentWallet } = useApp();
  const [owner, setOwner] = useState(currentWallet?.address ?? "");
  const [mint, setMint] = useState("");
  const [allowOffCurve, setAllowOffCurve] = useState(false);
  const [result, setResult] = useState<DerivedTokenAddresses | null>(null);
  const [error, setError] = useState<string | null>(null);

  const derive = () => {
    setError(null);
    setResult(null);
    try {
      setResult(deriveTokenAddresses({ owner: owner.trim(), mint: mint.trim(), allowOwnerOffCurve: allowOffCurve }));
    } catch (e) {
      const pe = parseTransactionError(e);
      setError(`${pe.code}: ${pe.message}${pe.suggestion ? ` — ${pe.suggestion}` : ""}`);
    }
  };

  return (
    <Card className="space-y-3">
      <h3 className="text-sm font-semibold text-zinc-300">地址工具 — 派生 ATA</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="addrtools-owner">owner</Label>
          <div className="flex gap-2">
            <Input id="addrtools-owner" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="钱包地址" />
            {currentWallet && (
              <Button variant="ghost" className="shrink-0 text-xs" onClick={() => setOwner(currentWallet.address)}>
                当前钱包
              </Button>
            )}
          </div>
        </div>
        <div>
          <Label htmlFor="addrtools-mint">mint</Label>
          <Input id="addrtools-mint" value={mint} onChange={(e) => setMint(e.target.value)} placeholder="mint 地址" />
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs text-zinc-400">
        <input type="checkbox" checked={allowOffCurve} onChange={(e) => setAllowOffCurve(e.target.checked)} />
        允许 off-curve owner（PDA）
      </label>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <Button variant="default" onClick={derive}>
        派生
      </Button>
      {result && (
        <div className="space-y-2">
          <div className="text-xs text-zinc-500">
            owner <span className="font-mono text-zinc-300">{result.owner}</span>{" "}
            <Badge tone={result.ownerIsOffCurve ? "warn" : "success"}>{result.ownerIsOffCurve ? "off-curve" : "on-curve"}</Badge>
          </div>
          <AtaRow title="SPL Token ATA" address={result.legacy.address} programId={result.legacy.programId} isOffCurve={result.legacy.isOffCurve} />
          <AtaRow title="Token-2022 ATA" address={result.token2022.address} programId={result.token2022.programId} isOffCurve={result.token2022.isOffCurve} />
        </div>
      )}
    </Card>
  );
}
