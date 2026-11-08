import { useState } from "react";
import {
  TOKEN_PRESETS,
  createSplToken,
  createToken2022,
  mintTokens,
  parseTransactionError,
  type CreateTokenResult,
  type TokenPresetName,
} from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT } from "../../lib/i18n";
import { Button, Card, Input, Label } from "../../components/ui";
import { AmountHint, isBaseUnits, parseDecimals } from "../../components/Amount";
import { ResultView, type SimpleTxOutcome } from "../transfer/ResultView";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import {
  Token2022ExtensionsPanel,
  buildToken2022Extensions,
  makeDefaultExtensionFormState,
  type ExtensionFormState,
} from "./Token2022ExtensionsPanel";

type MintKind = "spl" | "token2022";

/** Fill the form from a TOKEN_PRESETS entry (payer-dependent defaults use the unlocked wallet). */
function presetToForm(
  name: TokenPresetName,
  payer: string,
): { kind: MintKind; decimals: string; ext: ExtensionFormState; notes: string[] } {
  const preset = TOKEN_PRESETS[name];
  const d = preset.defaults.extensions ?? {};
  const ext = makeDefaultExtensionFormState();
  if (d.transferFeeConfig) {
    ext.transferFee = {
      enabled: true,
      feeBps: String(d.transferFeeConfig.transferFeeBasisPoints),
      maxFee: String(d.transferFeeConfig.maximumFee),
    };
  }
  if (d.permanentDelegate) ext.permanentDelegate = { enabled: true, delegate: payer };
  if (d.scaledUiAmount) ext.scaledUiAmount = { enabled: true, multiplier: String(d.scaledUiAmount.multiplier) };
  // transfer-hook: the preset's placeholder is the zero pubkey — leave the field for the user to fill.
  if (d.transferHook) ext.transferHook = { enabled: true, programId: "" };
  return {
    kind: preset.program === "spl-token" ? "spl" : "token2022",
    decimals: String(preset.defaults.decimals ?? 9),
    ext,
    notes: preset.notes,
  };
}

export function TokenCreatePage() {
  const t = useT();
  const { connection, state } = useApp();
  const keypair = state.unlockedKeypair;
  const isMainnet = state.cluster === "mainnet-beta";

  const [kind, setKind] = useState<MintKind>("spl");
  const [preset, setPreset] = useState<TokenPresetName | "">("");
  const [presetNotes, setPresetNotes] = useState<string[]>([]);
  const [decimals, setDecimals] = useState("9");
  /** Raw base units; "0" or empty = no initial mint. */
  const [initialSupply, setInitialSupply] = useState("0");
  const [extForm, setExtForm] = useState<ExtensionFormState>(makeDefaultExtensionFormState());
  const [mainnetAck, setMainnetAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<(CreateTokenResult & { minted?: string }) | null>(null);
  const [outcome, setOutcome] = useState<SimpleTxOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const { extensions, summary } = kind === "token2022" ? buildToken2022Extensions(extForm, t) : { extensions: undefined, summary: [] };

  const applyPreset = (name: TokenPresetName | "") => {
    setPreset(name);
    if (!name) {
      setPresetNotes([]);
      return;
    }
    const filled = presetToForm(name, keypair?.publicKey.toBase58() ?? "");
    setKind(filled.kind);
    setDecimals(filled.decimals);
    setExtForm(filled.ext);
    setPresetNotes(filled.notes);
  };

  const doCreate = async () => {
    setError(null);
    setCreated(null);
    setOutcome(null);
    if (!keypair) {
      setError(t("common.selectUnlockFirst"));
      return;
    }
    const dec = parseDecimals(decimals);
    if (dec === null) {
      setError(t("adv.err.nonNegInt", { field: "decimals" }));
      return;
    }
    const supplyRaw = initialSupply.trim();
    const wantsSupply = supplyRaw.length > 0 && supplyRaw !== "0";
    if (wantsSupply && !isBaseUnits(supplyRaw)) {
      setError(t("amount.invalid"));
      return;
    }
    setBusy(true);
    try {
      const opts = {
        decimals: dec,
        allowMainnet: isMainnet ? mainnetAck : undefined,
      };
      const result =
        kind === "spl"
          ? await createSplToken(connection, keypair, opts)
          : await createToken2022(connection, keypair, { ...opts, extensions });

      // core reports failures via result.error instead of throwing; the
      // returned mint does not exist on-chain in that case.
      if (result.error) {
        setOutcome({ error: result.error });
        return;
      }

      let minted: string | undefined;
      if (wantsSupply) {
        const mintRes = await mintTokens(connection, keypair, result.mint, keypair.publicKey, BigInt(supplyRaw), {
          allowMainnet: isMainnet ? mainnetAck : undefined,
        });
        if (mintRes.error) {
          // The mint itself was created; surface that so the user can retry minting manually.
          setCreated({ ...result });
          setOutcome({ error: mintRes.error });
          return;
        }
        minted = mintRes.signature;
      }
      setCreated({ ...result, minted });
      setOutcome({
        signature: result.signature,
        slot: result.slot,
        feeLamports: result.feeLamports,
        simulatedOnly: result.simulatedOnly,
      });
    } catch (e) {
      setOutcome({ error: parseTransactionError(e) });
    } finally {
      setBusy(false);
    }
  };

  const create = () => {
    if (kind === "token2022" && summary.length > 0) {
      setConfirming(true);
      return;
    }
    void doCreate();
  };

  return (
    <Card className="space-y-3">
      <h3 className="text-sm font-semibold text-zinc-300">{t("token.create.title")}</h3>
      <div>
        <Label htmlFor="tokencreatepage-preset">{t("token.create.preset")}</Label>
        <select
          id="tokencreatepage-preset"
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
          value={preset}
          onChange={(e) => applyPreset(e.target.value as TokenPresetName | "")}
        >
          <option value="">{t("token.create.custom")}</option>
          {(Object.keys(TOKEN_PRESETS) as TokenPresetName[]).map((name) => (
            <option key={name} value={name}>
              {name} — {TOKEN_PRESETS[name].description}
            </option>
          ))}
        </select>
        {presetNotes.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-zinc-500">
            {presetNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant={kind === "spl" ? "primary" : "default"} onClick={() => setKind("spl")}>
          {t("token.create.spl")}
        </Button>
        <Button variant={kind === "token2022" ? "primary" : "default"} onClick={() => setKind("token2022")}>
          {t("token.create.t22")}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="tokencreatepage-decimals">{t("token.create.decimals")}</Label>
          <Input id="tokencreatepage-decimals" inputMode="numeric" value={decimals} onChange={(e) => setDecimals(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="tokencreatepage-initial-supply">{t("token.create.initialSupply")}</Label>
          <Input id="tokencreatepage-initial-supply" inputMode="numeric" value={initialSupply} onChange={(e) => setInitialSupply(e.target.value)} />
          {initialSupply.trim() !== "0" && <AmountHint value={initialSupply} decimals={parseDecimals(decimals)} />}
        </div>
      </div>

      {kind === "token2022" && <Token2022ExtensionsPanel state={extForm} onChange={setExtForm} />}

      {isMainnet && (
        <label className="flex items-center gap-2 text-sm text-amber-300">
          <input type="checkbox" checked={mainnetAck} onChange={(e) => setMainnetAck(e.target.checked)} />
          {t("token.create.mainnetAck")}
        </label>
      )}
      {error && <div className="text-sm text-red-400">{error}</div>}
      <Button variant="primary" disabled={busy || !keypair} onClick={create}>
        {busy ? t("token.create.creating") : t("token.create.create")}
      </Button>

      {confirming && (
        <ConfirmDialog
          title={t("token.create.confirmTitle")}
          description={
            <div className="space-y-2">
              <div>{t("token.create.confirmDesc")}</div>
              <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-300">
                {summary.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          }
          confirmLabel={t("token.create.create")}
          danger={false}
          onConfirm={() => {
            setConfirming(false);
            void doCreate();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}

      {outcome && (
        <div className="space-y-2">
          <ResultView result={outcome} />
          {/* `created` is only set once the mint exists on-chain (creation succeeded);
              it may coexist with an error from the follow-up initial-supply mint. */}
          {created && (
            <div className="break-all font-mono text-xs text-zinc-400">
              {outcome.error && <div className="text-amber-300">{t("token.create.mintFailed")}</div>}
              {t("token.create.mint")} {created.mint}
              {created.extensions.length > 0 && (
                <div>
                  {t("token.create.extensions")} {created.extensions.join(", ")}
                </div>
              )}
              {created.minted && (
                <div>
                  {t("token.create.mintedTx")} {created.minted}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
