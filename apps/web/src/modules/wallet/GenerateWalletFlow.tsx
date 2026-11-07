import { useState } from "react";
import { generateWallet, newMnemonic, importFromMnemonic } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { Button, Card, Input, Label, RiskBanner } from "../../components/ui";

type Mode = "random" | "mnemonic";

export function GenerateWalletFlow({ onDone }: { onDone: () => void }) {
  const { addWallet } = useApp();
  const [mode, setMode] = useState<Mode>("mnemonic");
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [backedUp, setBackedUp] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [usePassword, setUsePassword] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reveal = () => {
    if (mode === "mnemonic") setMnemonic(newMnemonic(128));
    else setMnemonic(null);
  };

  const canSave =
    name.trim().length > 0 &&
    (mode === "random" || backedUp) &&
    (!usePassword || password.length >= 8);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const keypair =
        mode === "mnemonic" && mnemonic
          ? (await importFromMnemonic(mnemonic)).keypair
          : generateWallet().keypair;
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
      <h3 className="text-sm font-semibold text-zinc-300">Generate a new wallet</h3>

      <div className="flex gap-2">
        <Button variant={mode === "mnemonic" ? "primary" : "default"} onClick={() => { setMode("mnemonic"); setMnemonic(null); setBackedUp(false); }}>
          Mnemonic (recommended)
        </Button>
        <Button variant={mode === "random" ? "primary" : "default"} onClick={() => { setMode("random"); setMnemonic(null); }}>
          Random keypair
        </Button>
      </div>

      {mode === "mnemonic" && !mnemonic && (
        <Button variant="default" onClick={reveal}>
          Reveal a new 12-word mnemonic
        </Button>
      )}

      {mode === "mnemonic" && mnemonic && (
        <div className="space-y-2">
          <RiskBanner>
            This phrase is shown ONCE. Anyone with it can steal these funds. Write it down offline.
          </RiskBanner>
          <div className="grid grid-cols-3 gap-2 rounded-md border border-zinc-700 bg-zinc-950 p-3 font-mono text-sm">
            {mnemonic.split(" ").map((w, i) => (
              <div key={i} className="text-zinc-200">
                <span className="mr-1 text-zinc-600">{i + 1}.</span>
                {w}
              </div>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={backedUp} onChange={(e) => setBackedUp(e.target.checked)} />
            I have backed up this mnemonic offline.
          </label>
        </div>
      )}

      {(mode === "random" || backedUp) && (
        <div className="space-y-3 border-t border-zinc-800 pt-3">
          <div>
            <Label>Wallet name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. devnet-test-1" />
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={usePassword} onChange={(e) => setUsePassword(e.target.checked)} />
            Encrypt with a password (recommended)
          </label>
          {usePassword ? (
            <div>
              <Label>Password (min 8 chars)</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          ) : (
            <RiskBanner>
              Without a password, the secret key is stored in plaintext in this browser&apos;s localStorage. Only use
              this for throwaway devnet wallets.
            </RiskBanner>
          )}
          {error && <div className="text-sm text-red-400">{error}</div>}
          <Button variant="primary" disabled={!canSave || busy} onClick={save}>
            {busy ? "Saving…" : "Save wallet"}
          </Button>
        </div>
      )}
    </Card>
  );
}
