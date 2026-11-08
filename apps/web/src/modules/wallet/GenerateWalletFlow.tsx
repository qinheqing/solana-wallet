import { useEffect, useMemo, useState } from "react";
import type { Keypair } from "@solana/web3.js";
import { generateWallet, newMnemonic, importFromMnemonic } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { copyText } from "../../lib/clipboard";
import { Button, Card, Input, Label, RiskBanner } from "../../components/ui";

type Source = "mnemonic" | "random";

/**
 * One-screen wallet creation. Every field is visible from the start; the
 * key source (fresh mnemonic or random keypair) is produced immediately so
 * the user always sees the address they are about to save, and the submit
 * button explains what is still missing instead of silently staying disabled.
 */
export function GenerateWalletFlow({ onDone }: { onDone: () => void }) {
  const { addWallet } = useApp();

  // --- identity
  const [name, setName] = useState("");
  const [usePassword, setUsePassword] = useState(true);
  const [password, setPassword] = useState("");

  // --- key source
  const [source, setSource] = useState<Source>("mnemonic");
  const [mnemonic, setMnemonic] = useState<string>(() => newMnemonic(128));
  const [randomKeypair, setRandomKeypair] = useState<Keypair>(() => generateWallet().keypair);
  const [backedUp, setBackedUp] = useState(false);
  const [copied, setCopied] = useState(false);

  // Derived keypair for whichever source is active (mnemonic derivation is async).
  const [mnemonicKeypair, setMnemonicKeypair] = useState<Keypair | null>(null);
  useEffect(() => {
    let cancelled = false;
    setMnemonicKeypair(null);
    importFromMnemonic(mnemonic)
      .then((w) => {
        if (!cancelled) setMnemonicKeypair(w.keypair);
      })
      .catch(() => {
        if (!cancelled) setMnemonicKeypair(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mnemonic]);

  const keypair = source === "mnemonic" ? mnemonicKeypair : randomKeypair;
  const address = keypair?.publicKey.toBase58() ?? null;

  // --- submit
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocker = useMemo(() => {
    if (name.trim().length === 0) return "Enter a wallet name.";
    if (usePassword && password.length < 8) return "Password must be at least 8 characters.";
    if (source === "mnemonic" && !backedUp) return "Confirm you have backed up the mnemonic.";
    if (!keypair) return "Deriving key…";
    return null;
  }, [name, usePassword, password, source, backedUp, keypair]);

  const regenerate = () => {
    setBackedUp(false);
    setCopied(false);
    setCopyFailed(false);
    if (source === "mnemonic") setMnemonic(newMnemonic(128));
    else setRandomKeypair(generateWallet().keypair);
  };

  const chooseSource = (next: Source) => {
    if (next === source) return;
    setSource(next);
    setBackedUp(false);
    setCopied(false);
  };

  const [copyFailed, setCopyFailed] = useState(false);
  const copyMnemonic = async () => {
    const ok = await copyText(mnemonic);
    setCopied(ok);
    setCopyFailed(!ok);
  };

  const save = async () => {
    if (!keypair || blocker) return;
    setBusy(true);
    setError(null);
    try {
      await addWallet(name.trim(), keypair, usePassword ? password : undefined);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-5">
      <h3 className="text-sm font-semibold text-zinc-300">Generate a new wallet</h3>

      {/* 1. Identity */}
      <section className="space-y-3">
        <div>
          <Label htmlFor="generatewalletflow-wallet-name">Wallet name</Label>
          <Input
            id="generatewalletflow-wallet-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. devnet-test-1"
            autoFocus
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={usePassword} onChange={(e) => setUsePassword(e.target.checked)} />
          Encrypt with a password (recommended)
        </label>
        {usePassword ? (
          <div>
            <Label htmlFor="generatewalletflow-password">Password (min 8 chars)</Label>
            <Input
              id="generatewalletflow-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        ) : (
          <RiskBanner>
            Without a password, the secret key is stored in plaintext in this browser&apos;s localStorage. Only use
            this for throwaway devnet wallets.
          </RiskBanner>
        )}
      </section>

      {/* 2. Key source */}
      <section className="space-y-3 border-t border-zinc-800 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">Key source</span>
          <Button variant={source === "mnemonic" ? "primary" : "default"} onClick={() => chooseSource("mnemonic")}>
            12-word mnemonic (recommended)
          </Button>
          <Button variant={source === "random" ? "primary" : "default"} onClick={() => chooseSource("random")}>
            Random keypair
          </Button>
          <Button variant="default" onClick={regenerate}>
            Regenerate
          </Button>
        </div>

        {source === "mnemonic" ? (
          <div className="space-y-2">
            <RiskBanner>
              This phrase is shown only here and is NOT stored — only the derived key is saved. Anyone with it can
              steal these funds. Write it down offline before continuing.
            </RiskBanner>
            <div className="grid grid-cols-2 gap-2 rounded-md border border-zinc-700 bg-zinc-950 p-3 font-mono text-sm sm:grid-cols-3">
              {mnemonic.split(" ").map((w, i) => (
                <div key={i} className="text-zinc-200">
                  <span className="mr-1 text-zinc-600">{i + 1}.</span>
                  {w}
                </div>
              ))}
            </div>
            <input
              readOnly
              aria-label="Mnemonic phrase (single line)"
              value={mnemonic}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-300"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="default" onClick={copyMnemonic}>
                {copied ? "Copied" : "Copy phrase"}
              </Button>
              {copyFailed && (
                <span className="text-sm text-amber-400">Clipboard unavailable — select the phrase below.</span>
              )}
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input type="checkbox" checked={backedUp} onChange={(e) => setBackedUp(e.target.checked)} />
                I have backed up this mnemonic offline.
              </label>
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-400">
            A fresh Ed25519 keypair with no recovery phrase. Export the secret key after saving if you need a backup.
          </p>
        )}

        <div className="text-sm">
          <span className="text-zinc-500">Address: </span>
          <span className="font-mono text-zinc-200">{address ?? "deriving…"}</span>
        </div>
      </section>

      {/* 3. Submit */}
      <section className="space-y-2 border-t border-zinc-800 pt-4">
        {error && <div className="text-sm text-red-400">{error}</div>}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={!!blocker || busy} onClick={save}>
            {busy ? "Saving…" : "Create wallet"}
          </Button>
          {blocker && !busy && <span className="text-sm text-zinc-500">{blocker}</span>}
        </div>
      </section>
    </Card>
  );
}
