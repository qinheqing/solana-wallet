import { useState } from "react";
import { PublicKey, type AtaMode, type TransferInstructionKind } from "../../lib/coreShim";
import { Input, Label } from "../../components/ui";
import { useT, type TFn } from "../../lib/i18n";

/** Form state for the "Advanced construction" section. All-empty = core defaults. */
export interface AdvancedState {
  computeUnitLimit: string;
  computeUnitPrice: string;
  ataMode: AtaMode;
  instruction: TransferInstructionKind;
  fee: string;
  memo: string;
  authority: string;
  sourceOwner: string;
  force: boolean;
  skipPreflight: boolean;
}

export const DEFAULT_ADVANCED: AdvancedState = {
  computeUnitLimit: "",
  computeUnitPrice: "",
  ataMode: "auto",
  instruction: "transferChecked",
  fee: "",
  memo: "",
  authority: "",
  sourceOwner: "",
  force: false,
  skipPreflight: false,
};

/** Construction knobs shared by buildTransferPlan / preflightTransfer / transfer. */
export interface AdvancedKnobs {
  computeBudget?: { unitLimit?: number; unitPrice?: number };
  ataMode?: AtaMode;
  instruction?: TransferInstructionKind;
  fee?: bigint;
  memo?: string;
  authority?: PublicKey;
  sourceOwner?: PublicKey;
}

function parseIntField(raw: string, field: string, t: TFn): number | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) throw new Error(t("adv.err.nonNegInt", { field }));
  return n;
}

function parseKeyField(raw: string, field: string, t: TFn): PublicKey | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  try {
    return new PublicKey(s);
  } catch {
    throw new Error(t("adv.err.pubkey", { field }));
  }
}

/**
 * Convert form state into core option fields. Only non-default values are
 * emitted so the default form reproduces today's behaviour exactly.
 * Throws an Error with a user-facing (translated) message on invalid input.
 */
export function toKnobs(a: AdvancedState, isToken: boolean, t: TFn): AdvancedKnobs {
  const out: AdvancedKnobs = {};
  const unitLimit = parseIntField(a.computeUnitLimit, "computeUnitLimit", t);
  const unitPrice = parseIntField(a.computeUnitPrice, "computeUnitPrice", t);
  if (unitLimit !== undefined || unitPrice !== undefined) {
    out.computeBudget = {
      ...(unitLimit !== undefined ? { unitLimit } : {}),
      ...(unitPrice !== undefined ? { unitPrice } : {}),
    };
  }
  if (a.memo.length > 0) out.memo = a.memo;
  if (!isToken) return out; // token-only knobs would be rejected by core for SOL

  if (a.ataMode !== "auto") out.ataMode = a.ataMode;
  if (a.instruction !== "transferChecked") out.instruction = a.instruction;
  if (a.instruction === "transferCheckedWithFee") {
    const s = a.fee.trim();
    if (!/^\d+$/.test(s)) throw new Error(t("adv.err.fee"));
    out.fee = BigInt(s);
  }
  const authority = parseKeyField(a.authority, "authority", t);
  if (authority) out.authority = authority;
  const sourceOwner = parseKeyField(a.sourceOwner, "sourceOwner", t);
  if (sourceOwner) out.sourceOwner = sourceOwner;
  return out;
}

export function isAdvancedDefault(a: AdvancedState): boolean {
  return (Object.keys(DEFAULT_ADVANCED) as Array<keyof AdvancedState>).every((k) => a[k] === DEFAULT_ADVANCED[k]);
}

const selectCls =
  "w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 focus:border-emerald-600 focus:outline-none";

export function AdvancedOptions({
  value,
  onChange,
  isToken,
}: {
  value: AdvancedState;
  onChange: (next: AdvancedState) => void;
  isToken: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const set = <K extends keyof AdvancedState>(k: K, v: AdvancedState[K]) => onChange({ ...value, [k]: v });
  const modified = !isAdvancedDefault(value);

  return (
    <div className="rounded-md border border-zinc-800">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-zinc-300 hover:bg-zinc-900"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>
          {t("adv.title")}{" "}
          {modified && <span className="ml-1 rounded bg-amber-900/60 px-1.5 py-0.5 text-xs text-amber-300">{t("adv.modified")}</span>}
        </span>
        <span className="text-xs text-zinc-500">{open ? t("adv.collapse") : t("adv.expand")}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-zinc-800 p-3">
          <p className="text-xs text-zinc-500">{t("adv.intro")}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="adv-cu-limit">{t("adv.cuLimit")}</Label>
              <Input id="adv-cu-limit" inputMode="numeric" placeholder={t("adv.leaveEmpty")} value={value.computeUnitLimit} onChange={(e) => set("computeUnitLimit", e.target.value)} />
            </div>
            <div>
              <Label htmlFor="adv-cu-price">{t("adv.cuPrice")}</Label>
              <Input id="adv-cu-price" inputMode="numeric" placeholder={t("adv.leaveEmpty")} value={value.computeUnitPrice} onChange={(e) => set("computeUnitPrice", e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="adv-memo">{t("adv.memo")}</Label>
            <Input id="adv-memo" placeholder={t("adv.leaveEmpty")} value={value.memo} onChange={(e) => set("memo", e.target.value)} />
          </div>

          <div className={isToken ? "space-y-3" : "space-y-3 opacity-50"}>
            {!isToken && <p className="text-xs text-zinc-500">{t("adv.tokenOnly")}</p>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="adv-ata-mode">{t("adv.ataMode")}</Label>
                <select id="adv-ata-mode" className={selectCls} disabled={!isToken} value={value.ataMode} onChange={(e) => set("ataMode", e.target.value as AtaMode)}>
                  <option value="auto">{t("adv.ata.auto")}</option>
                  <option value="always-idempotent">{t("adv.ata.alwaysIdempotent")}</option>
                  <option value="create">{t("adv.ata.create")}</option>
                  <option value="none">{t("adv.ata.none")}</option>
                </select>
              </div>
              <div>
                <Label htmlFor="adv-instruction">{t("adv.instruction")}</Label>
                <select id="adv-instruction" className={selectCls} disabled={!isToken} value={value.instruction} onChange={(e) => set("instruction", e.target.value as TransferInstructionKind)}>
                  <option value="transferChecked">{t("adv.ix.transferChecked")}</option>
                  <option value="transfer">{t("adv.ix.transfer")}</option>
                  <option value="transferCheckedWithFee">{t("adv.ix.withFee")}</option>
                </select>
              </div>
            </div>
            {value.instruction === "transferCheckedWithFee" && (
              <div>
                <Label htmlFor="adv-fee">{t("adv.fee")}</Label>
                <Input id="adv-fee" inputMode="numeric" disabled={!isToken} value={value.fee} onChange={(e) => set("fee", e.target.value)} />
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="adv-authority">{t("adv.authority")}</Label>
                <Input className="font-mono" id="adv-authority" disabled={!isToken} placeholder={t("adv.defaultWallet")} value={value.authority} onChange={(e) => set("authority", e.target.value)} />
              </div>
              <div>
                <Label htmlFor="adv-source-owner">{t("adv.sourceOwner")}</Label>
                <Input className="font-mono" id="adv-source-owner" disabled={!isToken} placeholder={t("adv.defaultWallet")} value={value.sourceOwner} onChange={(e) => set("sourceOwner", e.target.value)} />
              </div>
            </div>
            {value.authority.trim() && <p className="text-xs text-amber-300">{t("adv.authorityWarn")}</p>}
          </div>

          <div className="space-y-1 border-t border-zinc-800 pt-3">
            <label className="flex items-start gap-2 text-sm text-amber-300">
              <input type="checkbox" className="mt-0.5" checked={value.force} onChange={(e) => set("force", e.target.checked)} />
              <span>
                {t("adv.force")}
                <span className="block text-xs text-amber-400/80">{t("adv.forceHint")}</span>
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={value.skipPreflight} onChange={(e) => set("skipPreflight", e.target.checked)} />
              {t("adv.skipPreflight")}
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
