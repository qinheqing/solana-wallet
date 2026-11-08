import type { Token2022ExtensionOptions } from "../../lib/coreShim";
import { Input, Label, RiskBanner } from "../../components/ui";
import { useT, type TFn } from "../../lib/i18n";

/** Controlled form state for every Token-2022 extension the create UI exposes. */
export interface ExtensionFormState {
  transferFee: { enabled: boolean; feeBps: string; maxFee: string };
  transferHook: { enabled: boolean; programId: string };
  interestBearing: { enabled: boolean; rate: string };
  nonTransferable: { enabled: boolean };
  permanentDelegate: { enabled: boolean; delegate: string };
  tokenMetadata: { enabled: boolean; name: string; symbol: string; uri: string };
  defaultAccountState: { enabled: boolean };
  scaledUiAmount: { enabled: boolean; multiplier: string };
}

export function makeDefaultExtensionFormState(): ExtensionFormState {
  return {
    transferFee: { enabled: false, feeBps: "100", maxFee: "1000000" },
    transferHook: { enabled: false, programId: "" },
    interestBearing: { enabled: false, rate: "0" },
    nonTransferable: { enabled: false },
    permanentDelegate: { enabled: false, delegate: "" },
    tokenMetadata: { enabled: false, name: "", symbol: "", uri: "" },
    defaultAccountState: { enabled: false },
    scaledUiAmount: { enabled: false, multiplier: "1.5" },
  };
}

/** Build the core `Token2022ExtensionOptions` plus a human-readable (translated) summary from form state. */
export function buildToken2022Extensions(
  state: ExtensionFormState,
  t: TFn,
): { extensions: Token2022ExtensionOptions | undefined; summary: string[] } {
  const extensions: Token2022ExtensionOptions = {};
  const summary: string[] = [];

  if (state.transferFee.enabled) {
    extensions.transferFeeConfig = {
      transferFeeBasisPoints: Number(state.transferFee.feeBps),
      maximumFee: BigInt(state.transferFee.maxFee || "0"),
    };
    summary.push(t("ext.sum.transferFee", { bps: state.transferFee.feeBps, max: state.transferFee.maxFee }));
  }
  if (state.transferHook.enabled && state.transferHook.programId.trim()) {
    extensions.transferHook = { programId: state.transferHook.programId.trim() };
    summary.push(t("ext.sum.hook", { program: state.transferHook.programId.trim() }));
  }
  if (state.interestBearing.enabled) {
    extensions.interestBearingConfig = { rate: Number(state.interestBearing.rate) };
    summary.push(t("ext.sum.interest", { rate: state.interestBearing.rate }));
  }
  if (state.nonTransferable.enabled) {
    extensions.nonTransferable = true;
    summary.push(t("ext.sum.nonTransferable"));
  }
  if (state.permanentDelegate.enabled && state.permanentDelegate.delegate.trim()) {
    extensions.permanentDelegate = { delegate: state.permanentDelegate.delegate.trim() };
    summary.push(t("ext.sum.pd", { delegate: state.permanentDelegate.delegate.trim() }));
  }
  if (state.tokenMetadata.enabled && state.tokenMetadata.name.trim() && state.tokenMetadata.symbol.trim()) {
    extensions.tokenMetadata = {
      name: state.tokenMetadata.name.trim(),
      symbol: state.tokenMetadata.symbol.trim(),
      uri: state.tokenMetadata.uri.trim(),
    };
    summary.push(t("ext.sum.metadata", { name: state.tokenMetadata.name.trim(), symbol: state.tokenMetadata.symbol.trim() }));
  }
  if (state.defaultAccountState.enabled) {
    extensions.defaultAccountState = { accountState: "frozen" };
    summary.push(t("ext.sum.frozen"));
  }
  if (state.scaledUiAmount.enabled) {
    extensions.scaledUiAmount = { multiplier: Number(state.scaledUiAmount.multiplier) };
    summary.push(t("ext.sum.scaled", { multiplier: state.scaledUiAmount.multiplier }));
  }

  return { extensions: Object.keys(extensions).length > 0 ? extensions : undefined, summary };
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-zinc-300">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Token2022ExtensionsPanel({
  state,
  onChange,
}: {
  state: ExtensionFormState;
  onChange: (next: ExtensionFormState) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-3">
      {/* Transfer fee */}
      <div className="space-y-2 rounded-md border border-zinc-800 p-3">
        <Toggle
          checked={state.transferFee.enabled}
          onChange={(enabled) => onChange({ ...state, transferFee: { ...state.transferFee, enabled } })}
          label={t("ext.transferFee")}
        />
        {state.transferFee.enabled && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="token2022extensionspanel-fee">{t("ext.feeBps")}</Label>
              <Input
                id="token2022extensionspanel-fee"
                inputMode="numeric"
                value={state.transferFee.feeBps}
                onChange={(e) => onChange({ ...state, transferFee: { ...state.transferFee, feeBps: e.target.value } })}
              />
            </div>
            <div>
              <Label htmlFor="token2022extensionspanel-max-fee">{t("ext.maxFee")}</Label>
              <Input
                id="token2022extensionspanel-max-fee"
                inputMode="numeric"
                value={state.transferFee.maxFee}
                onChange={(e) => onChange({ ...state, transferFee: { ...state.transferFee, maxFee: e.target.value } })}
              />
            </div>
          </div>
        )}
      </div>

      {/* Transfer hook */}
      <div className="space-y-2 rounded-md border border-zinc-800 p-3">
        <Toggle
          checked={state.transferHook.enabled}
          onChange={(enabled) => onChange({ ...state, transferHook: { ...state.transferHook, enabled } })}
          label={t("ext.transferHook")}
        />
        {state.transferHook.enabled && (
          <div>
            <Label htmlFor="token2022extensionspanel-hook-program-address">{t("ext.hookProgram")}</Label>
            <Input
              id="token2022extensionspanel-hook-program-address"
              value={state.transferHook.programId}
              onChange={(e) => onChange({ ...state, transferHook: { ...state.transferHook, programId: e.target.value } })}
              placeholder={t("ext.hookPlaceholder")}
            />
          </div>
        )}
      </div>

      {/* Interest bearing */}
      <div className="space-y-2 rounded-md border border-zinc-800 p-3">
        <Toggle
          checked={state.interestBearing.enabled}
          onChange={(enabled) => onChange({ ...state, interestBearing: { ...state.interestBearing, enabled } })}
          label={t("ext.interest")}
        />
        {state.interestBearing.enabled && (
          <div>
            <Label htmlFor="token2022extensionspanel-interest-rate">{t("ext.interestRate")}</Label>
            <Input
              id="token2022extensionspanel-interest-rate"
              value={state.interestBearing.rate}
              onChange={(e) => onChange({ ...state, interestBearing: { ...state.interestBearing, rate: e.target.value } })}
            />
          </div>
        )}
      </div>

      {/* Non-transferable */}
      <div className="space-y-2 rounded-md border border-zinc-800 p-3">
        <Toggle
          checked={state.nonTransferable.enabled}
          onChange={(enabled) => onChange({ ...state, nonTransferable: { enabled } })}
          label={t("ext.nonTransferable")}
        />
      </div>

      {/* Permanent delegate */}
      <div className="space-y-2 rounded-md border border-zinc-800 p-3">
        <Toggle
          checked={state.permanentDelegate.enabled}
          onChange={(enabled) => onChange({ ...state, permanentDelegate: { ...state.permanentDelegate, enabled } })}
          label={t("ext.permanentDelegate")}
        />
        {state.permanentDelegate.enabled && (
          <div className="space-y-2">
            <RiskBanner>{t("ext.pdWarn")}</RiskBanner>
            <div>
              <Label htmlFor="token2022extensionspanel-permanent-delegate-address">{t("ext.pdAddress")}</Label>
              <Input
                id="token2022extensionspanel-permanent-delegate-address"
                value={state.permanentDelegate.delegate}
                onChange={(e) =>
                  onChange({ ...state, permanentDelegate: { ...state.permanentDelegate, delegate: e.target.value } })
                }
              />
            </div>
          </div>
        )}
      </div>

      {/* Token metadata */}
      <div className="space-y-2 rounded-md border border-zinc-800 p-3">
        <Toggle
          checked={state.tokenMetadata.enabled}
          onChange={(enabled) => onChange({ ...state, tokenMetadata: { ...state.tokenMetadata, enabled } })}
          label={t("ext.metadata")}
        />
        {state.tokenMetadata.enabled && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="token2022extensionspanel-name">{t("ext.name")}</Label>
              <Input
                id="token2022extensionspanel-name"
                value={state.tokenMetadata.name}
                onChange={(e) => onChange({ ...state, tokenMetadata: { ...state.tokenMetadata, name: e.target.value } })}
              />
            </div>
            <div>
              <Label htmlFor="token2022extensionspanel-symbol">{t("ext.symbol")}</Label>
              <Input
                id="token2022extensionspanel-symbol"
                value={state.tokenMetadata.symbol}
                onChange={(e) => onChange({ ...state, tokenMetadata: { ...state.tokenMetadata, symbol: e.target.value } })}
              />
            </div>
            <div>
              <Label htmlFor="token2022extensionspanel-uri">{t("ext.uri")}</Label>
              <Input
                id="token2022extensionspanel-uri"
                value={state.tokenMetadata.uri}
                onChange={(e) => onChange({ ...state, tokenMetadata: { ...state.tokenMetadata, uri: e.target.value } })}
              />
            </div>
          </div>
        )}
      </div>

      {/* Default account state */}
      <div className="space-y-2 rounded-md border border-zinc-800 p-3">
        <Toggle
          checked={state.defaultAccountState.enabled}
          onChange={(enabled) => onChange({ ...state, defaultAccountState: { enabled } })}
          label={t("ext.defaultFrozen")}
        />
        {state.defaultAccountState.enabled && <div className="text-xs text-zinc-500">{t("ext.defaultFrozenHint")}</div>}
      </div>

      {/* Scaled UI amount */}
      <div className="space-y-2 rounded-md border border-zinc-800 p-3">
        <Toggle
          checked={state.scaledUiAmount.enabled}
          onChange={(enabled) => onChange({ ...state, scaledUiAmount: { ...state.scaledUiAmount, enabled } })}
          label={t("ext.scaled")}
        />
        {state.scaledUiAmount.enabled && (
          <div>
            <Label htmlFor="token2022extensionspanel-scaled-multiplier">{t("ext.multiplier")}</Label>
            <Input
              id="token2022extensionspanel-scaled-multiplier"
              value={state.scaledUiAmount.multiplier}
              onChange={(e) => onChange({ ...state, scaledUiAmount: { ...state.scaledUiAmount, multiplier: e.target.value } })}
            />
            <div className="text-xs text-zinc-500">{t("ext.scaledHint")}</div>
          </div>
        )}
      </div>
    </div>
  );
}
