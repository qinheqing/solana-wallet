import type { Token2022ExtensionOptions } from "../../lib/coreShim";
import { Input, Label, RiskBanner } from "../../components/ui";

/** Controlled form state for every Token-2022 extension the create UI exposes. */
export interface ExtensionFormState {
  transferFee: { enabled: boolean; feeBps: string; maxFee: string };
  transferHook: { enabled: boolean; programId: string };
  interestBearing: { enabled: boolean; rate: string };
  nonTransferable: { enabled: boolean };
  permanentDelegate: { enabled: boolean; delegate: string };
  tokenMetadata: { enabled: boolean; name: string; symbol: string; uri: string };
  defaultAccountState: { enabled: boolean };
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
  };
}

/** Build the core `Token2022ExtensionOptions` plus a human-readable summary from form state. */
export function buildToken2022Extensions(
  state: ExtensionFormState,
): { extensions: Token2022ExtensionOptions | undefined; summary: string[] } {
  const extensions: Token2022ExtensionOptions = {};
  const summary: string[] = [];

  if (state.transferFee.enabled) {
    extensions.transferFeeConfig = {
      transferFeeBasisPoints: Number(state.transferFee.feeBps),
      maximumFee: BigInt(state.transferFee.maxFee || "0"),
    };
    summary.push(`Transfer fee: ${state.transferFee.feeBps} bps, max ${state.transferFee.maxFee}`);
  }
  if (state.transferHook.enabled && state.transferHook.programId.trim()) {
    extensions.transferHook = { programId: state.transferHook.programId.trim() };
    summary.push(`Transfer hook: ${state.transferHook.programId.trim()}`);
  }
  if (state.interestBearing.enabled) {
    extensions.interestBearingConfig = { rate: Number(state.interestBearing.rate) };
    summary.push(`Interest bearing: ${state.interestBearing.rate} bps`);
  }
  if (state.nonTransferable.enabled) {
    extensions.nonTransferable = true;
    summary.push("Non-transferable (soul-bound)");
  }
  if (state.permanentDelegate.enabled && state.permanentDelegate.delegate.trim()) {
    extensions.permanentDelegate = { delegate: state.permanentDelegate.delegate.trim() };
    summary.push(`Permanent delegate: ${state.permanentDelegate.delegate.trim()}`);
  }
  if (state.tokenMetadata.enabled && state.tokenMetadata.name.trim() && state.tokenMetadata.symbol.trim()) {
    extensions.tokenMetadata = {
      name: state.tokenMetadata.name.trim(),
      symbol: state.tokenMetadata.symbol.trim(),
      uri: state.tokenMetadata.uri.trim(),
    };
    summary.push(`Metadata: ${state.tokenMetadata.name.trim()} (${state.tokenMetadata.symbol.trim()})`);
  }
  if (state.defaultAccountState.enabled) {
    extensions.defaultAccountState = { accountState: "frozen" };
    summary.push("New accounts default FROZEN (must be thawed)");
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
  return (
    <div className="space-y-3">
      {/* Transfer fee */}
      <div className="space-y-2 rounded-md border border-zinc-800 p-3">
        <Toggle
          checked={state.transferFee.enabled}
          onChange={(enabled) => onChange({ ...state, transferFee: { ...state.transferFee, enabled } })}
          label="Enable transferFeeConfig extension"
        />
        {state.transferFee.enabled && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Fee (basis points, 100 = 1%)</Label>
              <Input
                value={state.transferFee.feeBps}
                onChange={(e) => onChange({ ...state, transferFee: { ...state.transferFee, feeBps: e.target.value } })}
              />
            </div>
            <div>
              <Label>Max fee (base units)</Label>
              <Input
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
          label="Enable transferHook extension"
        />
        {state.transferHook.enabled && (
          <div>
            <Label>Hook program address</Label>
            <Input
              value={state.transferHook.programId}
              onChange={(e) => onChange({ ...state, transferHook: { ...state.transferHook, programId: e.target.value } })}
              placeholder="Program invoked on every transfer"
            />
          </div>
        )}
      </div>

      {/* Interest bearing */}
      <div className="space-y-2 rounded-md border border-zinc-800 p-3">
        <Toggle
          checked={state.interestBearing.enabled}
          onChange={(enabled) => onChange({ ...state, interestBearing: { ...state.interestBearing, enabled } })}
          label="Enable interestBearingConfig extension"
        />
        {state.interestBearing.enabled && (
          <div>
            <Label>Interest rate (signed basis points, -32768..32767)</Label>
            <Input
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
          label="Non-transferable (soul-bound token — can never be transferred)"
        />
      </div>

      {/* Permanent delegate */}
      <div className="space-y-2 rounded-md border border-zinc-800 p-3">
        <Toggle
          checked={state.permanentDelegate.enabled}
          onChange={(enabled) => onChange({ ...state, permanentDelegate: { ...state.permanentDelegate, enabled } })}
          label="Enable permanentDelegate extension"
        />
        {state.permanentDelegate.enabled && (
          <div className="space-y-2">
            <RiskBanner>
              Extremely high privilege: this address can transfer or burn tokens from ANY holder's
              account, at any time, without their consent.
            </RiskBanner>
            <div>
              <Label>Permanent delegate address</Label>
              <Input
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
          label="Enable on-chain tokenMetadata extension"
        />
        {state.tokenMetadata.enabled && (
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>Name</Label>
              <Input
                value={state.tokenMetadata.name}
                onChange={(e) => onChange({ ...state, tokenMetadata: { ...state.tokenMetadata, name: e.target.value } })}
              />
            </div>
            <div>
              <Label>Symbol</Label>
              <Input
                value={state.tokenMetadata.symbol}
                onChange={(e) => onChange({ ...state, tokenMetadata: { ...state.tokenMetadata, symbol: e.target.value } })}
              />
            </div>
            <div>
              <Label>URI</Label>
              <Input
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
          label="New accounts default frozen (defaultAccountState)"
        />
        {state.defaultAccountState.enabled && (
          <div className="text-xs text-zinc-500">
            Useful for whitelist-gated tokens: every new holder account starts frozen and must be
            thawed by the freeze authority before it can send or receive this token.
          </div>
        )}
      </div>
    </div>
  );
}
