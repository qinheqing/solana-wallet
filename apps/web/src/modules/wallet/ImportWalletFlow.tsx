import { useState } from "react";
import { DERIVATION_PRESETS, importFromMnemonic, parseKeypairJson } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { Button, Card, Input, Label, RiskBanner, Textarea } from "../../components/ui";

type Mode = "keyfile" | "mnemonic";

export function ImportWalletFlow({ onDone }: { onDone: () => void }) {
  const { addWallet } = useApp();
  const [mode, setMode] = useState<Mode>("keyfile");
  const [keyfileJson, setKeyfileJson] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [path, setPath] = useState<string>("solana");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [usePassword, setUsePassword] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim().length > 0 && (!usePassword || password.length >= 8);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const keypair =
        mode === "keyfile"
          ? parseKeypairJson(keyfileJson.trim())
          : (await importFromMnemonic(mnemonic.trim(), { path: path as never })).keypair;
      await addWallet(name.trim(), keypair, usePassword ? password : undefined);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4">
      <h3 className="text-sm font-semibold text-zinc-300">Import an existing wallet</h3>

      <div className="flex gap-2">
        <Button variant={mode === "keyfile" ? "primary" : "default"} onClick={() => setMode("keyfile")}>
          Keyfile JSON
        </Button>
        <Button variant={mode === "mnemonic" ? "primary" : "default"} onClick={() => setMode("mnemonic")}>
          Mnemonic
        </Button>
      </div>

      {mode === "keyfile" && (
        <div>
          <Label htmlFor="importwalletflow-solana-keygen-json">solana-keygen JSON (64-byte array)</Label>
          <Textarea id="importwalletflow-solana-keygen-json"
            rows={4}
            value={keyfileJson}
            onChange={(e) => setKeyfileJson(e.target.value)}
            placeholder="[17,168,...]"
          />
        </div>
      )}

      {mode === "mnemonic" && (
        <div className="space-y-3">
          <div>
            <Label htmlFor="importwalletflow-mnemonic-phrase">Mnemonic phrase</Label>
            <Textarea id="importwalletflow-mnemonic-phrase" rows={2} value={mnemonic} onChange={(e) => setMnemonic(e.target.value)} placeholder="word1 word2 ..." />
          </div>
          <div>
            <Label htmlFor="importwalletflow-derivation-path">Derivation path</Label>
            <select id="importwalletflow-derivation-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 focus:border-emerald-600 focus:outline-none"
            >
              {Object.keys(DERIVATION_PRESETS).map((p) => (
                <option key={p} value={p}>
                  {p} ({DERIVATION_PRESETS[p as keyof typeof DERIVATION_PRESETS]})
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="space-y-3 border-t border-zinc-800 pt-3">
        <div>
          <Label htmlFor="importwalletflow-wallet-name">Wallet name</Label>
          <Input id="importwalletflow-wallet-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. imported-1" />
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={usePassword} onChange={(e) => setUsePassword(e.target.checked)} />
          Encrypt with a password (recommended)
        </label>
        {usePassword ? (
          <div>
            <Label htmlFor="importwalletflow-password">Password (min 8 chars)</Label>
            <Input id="importwalletflow-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        ) : (
          <RiskBanner>
            Without a password, the secret key is stored in plaintext in this browser&apos;s localStorage.
          </RiskBanner>
        )}
        {error && <div className="text-sm text-red-400">{error}</div>}
        <Button variant="primary" disabled={!canSave || busy} onClick={save}>
          {busy ? "Importing…" : "Import wallet"}
        </Button>
      </div>
    </Card>
  );
}
