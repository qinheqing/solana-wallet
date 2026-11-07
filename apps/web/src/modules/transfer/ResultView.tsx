import { ErrorBanner } from "../../components/ui";
import type { ParsedProgramError } from "../../lib/coreShim";

export interface SimpleTxOutcome {
  signature?: string;
  slot?: number;
  feeLamports?: number;
  simulatedOnly?: boolean;
  error?: ParsedProgramError;
}

export function ResultView({ result }: { result: SimpleTxOutcome | null }) {
  if (!result) return null;
  if (result.error) {
    return (
      <ErrorBanner>
        <div className="font-semibold">
          {result.error.code}: {result.error.message}
        </div>
        {result.error.suggestion && <div className="mt-1 text-xs opacity-80">{result.error.suggestion}</div>}
      </ErrorBanner>
    );
  }
  return (
    <div className="space-y-1 rounded-md border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
      {result.simulatedOnly && <div className="font-semibold">Simulated only — nothing sent.</div>}
      {result.signature && <div className="font-mono text-xs break-all">sig: {result.signature}</div>}
      {result.slot !== undefined && <div>slot: {result.slot}</div>}
      {result.feeLamports !== undefined && <div>fee: {result.feeLamports} lamports</div>}
    </div>
  );
}
