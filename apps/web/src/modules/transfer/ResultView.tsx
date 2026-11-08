import { useState } from "react";
import { Button, ErrorBanner } from "../../components/ui";
import { AmountValue } from "../../components/Amount";
import { useT } from "../../lib/i18n";
import type { ParsedProgramError, PreflightResult, TransactionPlan } from "../../lib/coreShim";
import { PlanView, PreflightFindings } from "./PlanPreview";

export interface SimpleTxOutcome {
  signature?: string;
  slot?: number;
  feeLamports?: number;
  simulatedOnly?: boolean;
  error?: ParsedProgramError;
  /** Preflight findings (PRD T-C), when the transfer path ran them. */
  preflight?: PreflightResult;
  /** Compiled plan, when the transfer path produced one. */
  plan?: TransactionPlan;
}

export function ResultView({
  result,
  onForce,
  forcing,
}: {
  result: SimpleTxOutcome | null;
  /** When provided and the result is PREFLIGHT_BLOCKED, renders a "Force send" button. */
  onForce?: () => void;
  forcing?: boolean;
}) {
  const t = useT();
  const [showPlan, setShowPlan] = useState(false);
  if (!result) return null;
  const blocked = result.error?.code === "PREFLIGHT_BLOCKED";

  const planToggle = result.plan && (
    <div>
      <button type="button" className="text-xs text-zinc-400 underline-offset-2 hover:underline" onClick={() => setShowPlan((s) => !s)}>
        {showPlan ? t("result.hidePlan") : t("result.showPlan")}
      </button>
      {showPlan && (
        <div className="mt-2">
          <PlanView plan={result.plan} />
        </div>
      )}
    </div>
  );

  if (result.error) {
    return (
      <div className="space-y-2">
        <ErrorBanner>
          <div className="font-semibold">
            {result.error.code}: {result.error.message}
          </div>
          {result.error.suggestion && <div className="mt-1 text-xs opacity-80">{result.error.suggestion}</div>}
        </ErrorBanner>
        {result.preflight && <PreflightFindings preflight={result.preflight} />}
        {blocked && onForce && (
          <div className="rounded-md border border-amber-800 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
            <div className="text-xs">{t("result.forceHint")}</div>
            <Button variant="danger" className="mt-2" disabled={forcing} onClick={onForce}>
              {forcing ? t("result.forcing") : t("result.force")}
            </Button>
          </div>
        )}
        {planToggle}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="space-y-1 rounded-md border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
        {result.simulatedOnly && <div className="font-semibold">{t("result.simulated")}</div>}
        {result.signature && <div className="font-mono text-xs break-all">{t("result.sig", { sig: result.signature })}</div>}
        {result.slot !== undefined && <div>{t("result.slot", { slot: result.slot })}</div>}
        {result.feeLamports !== undefined && (
          <div>
            {t("result.fee")} <AmountValue raw={result.feeLamports} decimals={9} symbol="SOL" unit={t("common.lamports")} />
          </div>
        )}
      </div>
      {result.preflight && result.preflight.findings.length > 0 && <PreflightFindings preflight={result.preflight} />}
      {planToggle}
    </div>
  );
}
