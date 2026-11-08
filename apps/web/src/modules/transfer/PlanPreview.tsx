import type { PreflightFinding, PreflightResult, TransactionPlan } from "../../lib/coreShim";
import { Badge } from "../../components/ui";
import { CopyButton, shortKey } from "../../components/CopyButton";
import { downloadText } from "../../lib/download";
import { hasKey, useT, type TKey } from "../../lib/i18n";

const SEVERITY_ORDER = ["block", "warn", "info"] as const;
const SEVERITY_STYLE: Record<PreflightFinding["severity"], { box: string; label: TKey; tone: "danger" | "warn" | "default" }> = {
  block: { box: "border-red-800 bg-red-950/30 text-red-300", label: "plan.sev.block", tone: "danger" },
  warn: { box: "border-amber-800 bg-amber-950/30 text-amber-300", label: "plan.sev.warn", tone: "warn" },
  info: { box: "border-zinc-700 bg-zinc-900/40 text-zinc-300", label: "plan.sev.info", tone: "default" },
};

/** Preflight findings grouped by severity (block → warn → info). */
export function PreflightFindings({ preflight }: { preflight: PreflightResult }) {
  const t = useT();
  if (preflight.findings.length === 0) {
    return (
      <div className="rounded-md border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
        {t("plan.passed")}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium text-zinc-300">{t("plan.result")}</span>
        <Badge tone={preflight.ok ? "success" : "danger"}>{preflight.ok ? t("plan.ok") : t("plan.blocked")}</Badge>
        {preflight.resolved && (
          <span className="truncate text-xs text-zinc-500" title={`${preflight.resolved.sourceAta} → ${preflight.resolved.destinationAta}`}>
            {preflight.resolved.program} · {shortKey(preflight.resolved.sourceAta)} → {shortKey(preflight.resolved.destinationAta)}
          </span>
        )}
      </div>
      {SEVERITY_ORDER.map((sev) => {
        const items = preflight.findings.filter((f) => f.severity === sev);
        if (items.length === 0) return null;
        const style = SEVERITY_STYLE[sev];
        return (
          <div key={sev} className={`rounded-md border px-3 py-2 text-sm ${style.box}`}>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-80">{t(style.label)}</div>
            <ul className="space-y-1.5">
              {items.map((f, i) => {
                const hintKey = `preflight.${f.code}`;
                return (
                  <li key={`${f.code}-${i}`}>
                    <div className="font-mono text-xs font-semibold">{f.code}</div>
                    {hasKey(hintKey) && <div className="text-xs opacity-80">{t(hintKey)}</div>}
                    <div className="text-xs break-words">{f.message}</div>
                    {f.data && Object.keys(f.data).length > 0 && (
                      <pre className="mt-1 overflow-x-auto rounded bg-black/30 p-1.5 font-mono text-[11px] opacity-80">
                        {JSON.stringify(f.data, null, 1)}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** Compiled-but-unsigned transaction: instruction list, message hex, size, signers. */
export function PlanView({ plan, filename = "transfer-plan" }: { plan: TransactionPlan; filename?: string }) {
  const t = useT();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
        <span>
          {t("plan.ixCount")} <span className="text-zinc-100">{plan.instructions.length}</span>
        </span>
        <span>
          {t("plan.estBytes")} <span className="text-zinc-100">{plan.estimatedBytes}</span> / 1232
        </span>
        <span>
          feePayer <span className="font-mono text-zinc-100">{shortKey(plan.feePayer)}</span>
        </span>
        <span>
          blockhash <span className="font-mono text-zinc-100">{shortKey(plan.blockhash, 6)}</span>
        </span>
      </div>

      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-400">{t("plan.signers")}</div>
        <ul className="space-y-0.5">
          {plan.signers.map((s) => (
            <li key={s} className="flex items-center gap-2 font-mono text-xs text-zinc-200">
              <span className="break-all">{s}</span>
              <CopyButton text={s} />
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">{t("plan.ixList")}</div>
        {plan.instructions.map((ix) => (
          <div key={ix.index} className="rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="rounded bg-zinc-800 px-1.5 text-xs text-zinc-300">#{ix.index}</span>
              <span className="font-medium text-zinc-100">{ix.label}</span>
              <span className="font-mono text-xs text-zinc-500" title={ix.programId}>
                {shortKey(ix.programId, 6)}
              </span>
              <CopyButton text={ix.programId} label={t("plan.copyProgramId")} />
            </div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[420px] text-left text-xs">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="pr-2 font-medium">#</th>
                    <th className="pr-2 font-medium">{t("plan.account")}</th>
                    <th className="pr-2 font-medium">signer</th>
                    <th className="pr-2 font-medium">writable</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-zinc-300">
                  {ix.accounts.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-1 text-zinc-500">
                        {t("plan.noAccounts")}
                      </td>
                    </tr>
                  )}
                  {ix.accounts.map((a, i) => (
                    <tr key={`${a.pubkey}-${i}`} className="border-t border-zinc-800/60">
                      <td className="py-0.5 pr-2 text-zinc-500">{i}</td>
                      <td className="py-0.5 pr-2" title={a.pubkey}>
                        <span className="sm:hidden">{shortKey(a.pubkey, 6)}</span>
                        <span className="hidden break-all sm:inline">{a.pubkey}</span>
                      </td>
                      <td className="py-0.5 pr-2">{a.isSigner ? <Badge tone="success">S</Badge> : "—"}</td>
                      <td className="py-0.5 pr-2">{a.isWritable ? <Badge tone="warn">W</Badge> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-zinc-500">{t("plan.dataHex", { n: ix.dataHex.length / 2 })}</div>
                <div className="break-all font-mono text-[11px] text-zinc-300">{ix.dataHex || t("plan.empty")}</div>
              </div>
              <CopyButton text={ix.dataHex} />
            </div>
          </div>
        ))}
      </div>

      <div>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">{t("plan.messageHex")}</span>
          <CopyButton text={plan.messageHex} />
          <button
            type="button"
            className="rounded px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
            onClick={() => downloadText(`${filename}.message.hex`, plan.messageHex, "text/plain")}
          >
            {t("plan.downloadHex")}
          </button>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
            onClick={() => downloadText(`${filename}.json`, JSON.stringify(plan, null, 2))}
          >
            {t("plan.downloadJson")}
          </button>
        </div>
        <div className="max-h-40 overflow-y-auto break-all rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] text-zinc-300">
          {plan.messageHex}
        </div>
      </div>
    </div>
  );
}
