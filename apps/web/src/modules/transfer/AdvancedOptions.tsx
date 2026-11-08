import { useState } from "react";
import { PublicKey, type AtaMode, type TransferInstructionKind } from "../../lib/coreShim";
import { Input, Label } from "../../components/ui";

/** Form state for the "高级构造" section. All-empty = core defaults. */
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

function parseIntField(raw: string, label: string): number | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${label} 必须是非负整数`);
  return n;
}

function parseKeyField(raw: string, label: string): PublicKey | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  try {
    return new PublicKey(s);
  } catch {
    throw new Error(`${label} 不是合法的 base58 公钥`);
  }
}

/**
 * Convert form state into core option fields. Only non-default values are
 * emitted so the default form reproduces today's behaviour exactly.
 * Throws an Error with a user-facing message on invalid input.
 */
export function toKnobs(a: AdvancedState, isToken: boolean): AdvancedKnobs {
  const out: AdvancedKnobs = {};
  const unitLimit = parseIntField(a.computeUnitLimit, "computeUnitLimit");
  const unitPrice = parseIntField(a.computeUnitPrice, "computeUnitPrice");
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
    if (!/^\d+$/.test(s)) throw new Error("fee 必须是基础单位的非负整数（transferCheckedWithFee 需要）");
    out.fee = BigInt(s);
  }
  const authority = parseKeyField(a.authority, "authority");
  if (authority) out.authority = authority;
  const sourceOwner = parseKeyField(a.sourceOwner, "sourceOwner");
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
          高级构造{" "}
          {modified && <span className="ml-1 rounded bg-amber-900/60 px-1.5 py-0.5 text-xs text-amber-300">已修改</span>}
        </span>
        <span className="text-xs text-zinc-500">{open ? "收起 ▲" : "展开 ▼"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-zinc-800 p-3">
          <p className="text-xs text-zinc-500">
            留空 / 默认即与常规发送完全一致。非默认值会生成非标准交易，用于测试第三方集成。
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="adv-cu-limit">computeUnitLimit（units）</Label>
              <Input id="adv-cu-limit" inputMode="numeric" placeholder="留空 = 不添加" value={value.computeUnitLimit} onChange={(e) => set("computeUnitLimit", e.target.value)} />
            </div>
            <div>
              <Label htmlFor="adv-cu-price">computeUnitPrice（microLamports）</Label>
              <Input id="adv-cu-price" inputMode="numeric" placeholder="留空 = 不添加" value={value.computeUnitPrice} onChange={(e) => set("computeUnitPrice", e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="adv-memo">memo（Memo 程序指令，置于转账前）</Label>
            <Input id="adv-memo" placeholder="留空 = 不添加" value={value.memo} onChange={(e) => set("memo", e.target.value)} />
          </div>

          <div className={isToken ? "space-y-3" : "space-y-3 opacity-50"}>
            {!isToken && <p className="text-xs text-zinc-500">以下选项仅对代币转账生效（填写 mint 后启用）。</p>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="adv-ata-mode">ataMode（目标 ATA 策略）</Label>
                <select id="adv-ata-mode" className={selectCls} disabled={!isToken} value={value.ataMode} onChange={(e) => set("ataMode", e.target.value as AtaMode)}>
                  <option value="auto">auto（缺失时幂等创建，默认）</option>
                  <option value="always-idempotent">always-idempotent（总是幂等创建）</option>
                  <option value="create">create（非幂等创建，已存在则链上失败）</option>
                  <option value="none">none（不创建）</option>
                </select>
              </div>
              <div>
                <Label htmlFor="adv-instruction">instruction（转账指令）</Label>
                <select id="adv-instruction" className={selectCls} disabled={!isToken} value={value.instruction} onChange={(e) => set("instruction", e.target.value as TransferInstructionKind)}>
                  <option value="transferChecked">transferChecked（默认）</option>
                  <option value="transfer">transfer（不校验 decimals）</option>
                  <option value="transferCheckedWithFee">transferCheckedWithFee（Token-2022 费率）</option>
                </select>
              </div>
            </div>
            {value.instruction === "transferCheckedWithFee" && (
              <div>
                <Label htmlFor="adv-fee">fee（期望手续费，基础单位；填 0 可制造 FeeMismatch）</Label>
                <Input id="adv-fee" inputMode="numeric" disabled={!isToken} value={value.fee} onChange={(e) => set("fee", e.target.value)} />
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="adv-authority">authority（可选，委托 / 永久委托签名者）</Label>
                <Input id="adv-authority" disabled={!isToken} placeholder="默认 = 当前钱包" value={value.authority} onChange={(e) => set("authority", e.target.value)} />
              </div>
              <div>
                <Label htmlFor="adv-source-owner">sourceOwner（可选，源 ATA 的所有者）</Label>
                <Input id="adv-source-owner" disabled={!isToken} placeholder="默认 = 当前钱包" value={value.sourceOwner} onChange={(e) => set("sourceOwner", e.target.value)} />
              </div>
            </div>
            {value.authority.trim() && (
              <p className="text-xs text-amber-300">
                authority 与当前钱包不同时，发送需要该签名者的私钥（Web 端目前仅能用当前钱包签名，预览仍可查看）。
              </p>
            )}
          </div>

          <div className="space-y-1 border-t border-zinc-800 pt-3">
            <label className="flex items-start gap-2 text-sm text-amber-300">
              <input type="checkbox" className="mt-0.5" checked={value.force} onChange={(e) => set("force", e.target.checked)} />
              <span>
                绕过预检拦截（force）
                <span className="block text-xs text-amber-400/80">
                  预检的 block 级发现（TransferHook / 冻结 / MemoTransfer 等）不再阻止发送，由验证器自行判定；通常会在链上失败并扣手续费。
                </span>
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={value.skipPreflight} onChange={(e) => set("skipPreflight", e.target.checked)} />
              跳过预检（skipPreflight，不做额外 RPC 读取，不返回 findings）
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
