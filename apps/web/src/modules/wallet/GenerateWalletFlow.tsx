import { useEffect, useMemo, useState } from "react";
import type { Keypair } from "@solana/web3.js";
import { generateWallet, newMnemonic, importFromMnemonic } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT, type TKey } from "../../lib/i18n";
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
  const t = useT();
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

  const blockerKey = useMemo<TKey | null>(() => {
    if (name.trim().length === 0) return "wallet.gen.block.name";
    if (usePassword && password.length < 8) return "wallet.gen.block.password";
    if (source === "mnemonic" && !backedUp) return "wallet.gen.block.backup";
    if (!keypair) return "wallet.gen.block.deriving";
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
    if (!keypair || blockerKey) return;
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
      <h3 className="text-sm font-semibold text-zinc-300">{t("wallet.gen.title")}</h3>

      {/* 1. Identity */}
      <section className="space-y-3">
        <div>
          <Label htmlFor="generatewalletflow-wallet-name">{t("wallet.gen.name")}</Label>
          <Input
            id="generatewalletflow-wallet-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("wallet.gen.namePlaceholder")}
            autoFocus
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={usePassword} onChange={(e) => setUsePassword(e.target.checked)} />
          {t("wallet.gen.encrypt")}
        </label>
        {usePassword ? (
          <div>
            <Label htmlFor="generatewalletflow-password">{t("wallet.gen.password")}</Label>
            <Input
              id="generatewalletflow-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        ) : (
          <RiskBanner>{t("wallet.gen.plaintextWarn")}</RiskBanner>
        )}
      </section>

      {/* 2. Key source */}
      <section className="space-y-3 border-t border-zinc-800 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">{t("wallet.gen.keySource")}</span>
          <Button variant={source === "mnemonic" ? "primary" : "default"} onClick={() => chooseSource("mnemonic")}>
            {t("wallet.gen.mnemonic")}
          </Button>
          <Button variant={source === "random" ? "primary" : "default"} onClick={() => chooseSource("random")}>
            {t("wallet.gen.random")}
          </Button>
          <Button variant="default" onClick={regenerate}>
            {t("wallet.gen.regenerate")}
          </Button>
        </div>

        {source === "mnemonic" ? (
          <div className="space-y-2">
            <RiskBanner>{t("wallet.gen.mnemonicWarn")}</RiskBanner>
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
              aria-label={t("wallet.gen.mnemonicSingleLine")}
              value={mnemonic}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-300"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="default" onClick={copyMnemonic}>
                {copied ? t("common.copied") : t("wallet.gen.copyPhrase")}
              </Button>
              {copyFailed && <span className="text-sm text-amber-400">{t("wallet.gen.clipboardUnavailable")}</span>}
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input type="checkbox" checked={backedUp} onChange={(e) => setBackedUp(e.target.checked)} />
                {t("wallet.gen.backedUp")}
              </label>
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-400">{t("wallet.gen.randomHint")}</p>
        )}

        <div className="text-sm">
          <span className="text-zinc-500">{t("wallet.gen.address")} </span>
          <span className="break-all font-mono text-zinc-200">{address ?? t("wallet.gen.deriving")}</span>
        </div>
      </section>

      {/* 3. Submit */}
      <section className="space-y-2 border-t border-zinc-800 pt-4">
        {error && <div className="text-sm text-red-400">{error}</div>}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={!!blockerKey || busy} onClick={save}>
            {busy ? t("wallet.gen.saving") : t("wallet.gen.create")}
          </Button>
          {blockerKey && !busy && <span className="text-sm text-zinc-500">{t(blockerKey)}</span>}
        </div>
      </section>
    </Card>
  );
}
