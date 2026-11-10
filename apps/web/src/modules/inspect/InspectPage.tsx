import { useState } from "react";
import {
  inspectSignedTransaction,
  inspectTransaction,
  parseTransactionError,
  type SignedTransactionInspection,
  type Cluster,
  type TransactionInspection,
  type TokenMovement,
} from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT } from "../../lib/i18n";
import { Badge, Button, Card, ErrorBanner, Input, Label, Textarea } from "../../components/ui";
import { AmountValue } from "../../components/Amount";
import { CopyButton } from "../../components/CopyButton";
import { downloadText, stringifyJson } from "../../lib/download";
import { Delta, IxIndex, Key, KeyLine, ProgramBadge, Section, TD, TDN, TR, Table, TypeCell } from "./parts";
import { RawTxView } from "./RawTxView";

type Mode = "signature" | "raw" | "json";


function fmtTime(blockTime: number | null): string {
  if (blockTime === null) return "—";
  return `${new Date(blockTime * 1000).toLocaleString()} (${blockTime})`;
}

function MovementRow({ m }: { m: TokenMovement }) {
  const t = useT();
  return (
    <tr className={TR}>
      <td className={TD}>
        <IxIndex index={m.instructionIndex} inner={m.innerIndex} />
      </td>
      <td className={TD}>
        <TypeCell
          type={m.instructionType === "other" ? m.rawType ?? "other" : m.instructionType}
          inner={m.isInner}
          programId={m.programId}
        />
      </td>
      <td className={TD}>
        <KeyLine label={t("tx.col.account")} value={m.sourceAccount} />
        <KeyLine label={t("tx.col.owner")} value={m.sourceOwner} />
        {m.sourceAccounts && m.sourceAccounts.length > 0 && (
          <div className="text-zinc-500">{t("tx.sourceAccounts", { n: m.sourceAccounts.length })}</div>
        )}
      </td>
      <td className={TD}>
        <KeyLine label={t("tx.col.account")} value={m.destAccount} />
        <KeyLine label={t("tx.col.owner")} value={m.destOwner} />
      </td>
      <td className={TD}>
        <Key value={m.authority} />
      </td>
      <td className={TD}>
        <Key value={m.mint} />
      </td>
      <td className={TDN}>
        <AmountValue raw={m.amount} decimals={m.decimals} stacked />
        {m.fee && (
          <div className="mt-1.5 border-t border-zinc-800 pt-1.5">
            <div className="text-[11px] text-amber-300/80">
              {t("tx.col.fee")} · {m.fee.source}
            </div>
            <AmountValue raw={m.fee.amount} decimals={m.decimals} stacked />
          </div>
        )}
      </td>
      <td className={TDN}>
        <Delta raw={m.balanceDelta} decimals={m.decimals} />
      </td>
    </tr>
  );
}

export function InspectPage() {
  const t = useT();
  const { connection, state } = useApp();
  const [mode, setMode] = useState<Mode>("signature");
  const [signature, setSignature] = useState("");
  const [json, setJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TransactionInspection | null>(null);
  const [rawInput, setRawInput] = useState("");
  const [checkChain, setCheckChain] = useState(true);
  const [rawResult, setRawResult] = useState<SignedTransactionInspection | null>(null);

  const run = async (override?: { mode: Mode; signature: string }) => {
    const m = override?.mode ?? mode;
    setError(null);
    setResult(null);
    setRawResult(null);
    setBusy(true);
    try {
      if (m === "raw") {
        const input = rawInput.trim();
        if (!input) throw new Error(t("raw.needInput"));
        setRawResult(await inspectSignedTransaction(input, checkChain ? connection : undefined));
      } else if (m === "signature") {
        const sig = (override?.signature ?? signature).trim();
        if (!sig) throw new Error(t("tx.needSig"));
        setResult(await inspectTransaction({ conn: connection, signature: sig }));
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch {
          throw new Error(t("tx.jsonParseFailed"));
        }
        // JSON-RPC envelopes are common when copying from curl output.
        if (parsed && typeof parsed === "object" && "result" in parsed && !("transaction" in parsed)) {
          parsed = (parsed as { result: unknown }).result;
        }
        const cluster: Cluster | undefined = state.cluster === "localnet" ? "custom" : state.cluster;
        setResult(await inspectTransaction({ json: parsed, cluster, rpcUrl: connection.rpcUrl }));
      }
    } catch (e) {
      const pe = parseTransactionError(e);
      setError(`${pe.code}: ${pe.message}${pe.suggestion ? ` — ${pe.suggestion}` : ""}`);
    } finally {
      setBusy(false);
    }
  };

  const exportJson = () => {
    const data = result ?? rawResult;
    if (!data) return;
    const name = data.signature ? `tx-${data.signature.slice(0, 12)}.json` : "tx-inspection.json";
    downloadText(name, stringifyJson(data));
  };

  /** From the raw view: look the landed transaction up by signature. */
  const openSignature = (sig: string) => {
    setMode("signature");
    setSignature(sig);
    void run({ mode: "signature", signature: sig });
  };

  const failed = result ? result.err !== null && result.err !== undefined : false;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">{t("tx.title")}</h2>
      <Card className="space-y-3">
        <div className="flex gap-2">
          <Button variant={mode === "signature" ? "primary" : "default"} onClick={() => setMode("signature")}>
            {t("tx.bySignature")}
          </Button>
          <Button variant={mode === "raw" ? "primary" : "default"} onClick={() => setMode("raw")}>
            {t("raw.mode")}
          </Button>
          <Button variant={mode === "json" ? "primary" : "default"} onClick={() => setMode("json")}>
            {t("tx.pasteJson")}
          </Button>
        </div>
        {mode === "signature" ? (
          <div>
            <Label htmlFor="inspect-signature">{t("tx.signature")}</Label>
            <Input className="font-mono" id="inspect-signature" value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={t("tx.sigPlaceholder")} />
            <p className="mt-1 text-xs text-zinc-500">{t("tx.sigHint", { rpc: connection.rpcUrl })}</p>
          </div>
        ) : mode === "raw" ? (
          <div>
            <Label htmlFor="inspect-raw">{t("raw.label")}</Label>
            <Textarea
              id="inspect-raw"
              rows={5}
              className="font-mono text-xs"
              value={rawInput}
              onChange={(e) => setRawInput(e.target.value)}
              placeholder={t("raw.placeholder")}
            />
            <label className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
              <input type="checkbox" checked={checkChain} onChange={(e) => setCheckChain(e.target.checked)} />
              {t("raw.checkChain", { rpc: connection.rpcUrl })}
            </label>
            <p className="mt-1 text-xs text-zinc-500">{t("raw.hint")}</p>
          </div>
        ) : (
          <div>
            <Label htmlFor="inspect-json">{t("tx.jsonLabel")}</Label>
            <Textarea
              id="inspect-json"
              rows={8}
              className="font-mono text-xs"
              value={json}
              onChange={(e) => setJson(e.target.value)}
              placeholder={t("tx.jsonPlaceholder")}
            />
            <p className="mt-1 text-xs text-zinc-500">{t("tx.jsonHint")}</p>
          </div>
        )}
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy} onClick={() => void run()}>
            {busy ? t("tx.parsing") : t("tx.run")}
          </Button>
          {(result || rawResult) && (
            <Button variant="default" onClick={exportJson}>
              {t("tx.export")}
            </Button>
          )}
        </div>
      </Card>


      {rawResult && <RawTxView r={rawResult} onOpenSignature={openSignature} />}

      {result && (
        <>
          <Card className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-200">{t("tx.overview")}</h3>
              <Badge tone={failed ? "danger" : "success"}>{failed ? t("tx.failed") : t("tx.success")}</Badge>
              {result.explorerUrl && (
                <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="ml-auto text-xs text-emerald-400 hover:underline">
                  {t("tx.openExplorer")}
                </a>
              )}
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-zinc-500">signature</dt>
              <dd className="flex min-w-0 items-center gap-1 font-mono text-xs">
                <span className="break-all">{result.signature || "—"}</span>
                {result.signature && <CopyButton text={result.signature} />}
              </dd>
              <dt className="text-zinc-500">slot</dt>
              <dd className="font-mono text-xs">{result.slot}</dd>
              <dt className="text-zinc-500">blockTime</dt>
              <dd className="font-mono text-xs">{fmtTime(result.blockTime)}</dd>
              <dt className="text-zinc-500">fee</dt>
              <dd className="text-xs">
                <AmountValue raw={result.fee} decimals={9} symbol="SOL" unit={t("common.lamports")} />
              </dd>
              {failed && (
                <>
                  <dt className="text-zinc-500">err</dt>
                  <dd className="font-mono text-xs break-all text-red-300">
                    {JSON.stringify(result.err)}
                    {result.decodedError && (
                      <div className="mt-1">
                        ix #{result.decodedError.instructionIndex ?? "?"} · program {result.decodedError.programId} ·{" "}
                        {result.decodedError.name ?? result.decodedError.kind ?? `custom ${result.decodedError.customCode ?? "?"}`}
                      </div>
                    )}
                  </dd>
                </>
              )}
            </dl>
          </Card>

          {result.warnings.length > 0 && (
            <Card className="border-amber-800/60">
              <h3 className="mb-1 text-sm font-semibold text-amber-300">{t("tx.warnings", { n: result.warnings.length })}</h3>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-300">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Card>
          )}

          <Section title={t("tx.solMovements")} count={result.solMovements.length} empty={t("tx.noSolMovements")}>
            <Table
              minWidth={560}
              head={[t("tx.col.ix"), t("tx.col.type"), t("tx.col.from"), t("tx.col.to"), t("tx.col.amount")]}
            >
              {result.solMovements.map((m, i) => (
                <tr key={i} className={TR}>
                  <td className={TD}>
                    <IxIndex index={m.instructionIndex} inner={m.innerIndex} />
                  </td>
                  <td className={TD}>
                    <TypeCell type={m.instructionType} inner={m.isInner} />
                  </td>
                  <td className={TD}>
                    <Key value={m.source} />
                  </td>
                  <td className={TD}>
                    <Key value={m.destination} />
                  </td>
                  <td className={TDN}>
                    <AmountValue raw={m.lamports} decimals={9} symbol="SOL" unit={t("common.lamports")} stacked />
                  </td>
                </tr>
              ))}
            </Table>
          </Section>

          <Section title={t("tx.solBalanceChanges")} count={result.solBalanceChanges.length} empty={t("tx.noSolBalanceChanges")}>
            <Table minWidth={560} head={[t("tx.col.account"), t("tx.col.pre"), t("tx.col.post"), t("tx.col.delta")]}>
              {result.solBalanceChanges.map((b) => (
                <tr key={b.account} className={TR}>
                  <td className={TD}>
                    <div className="flex items-center gap-2">
                      <Key value={b.account} />
                      {b.isFeePayer && <Badge>{t("tx.feePayer")}</Badge>}
                    </div>
                  </td>
                  <td className={TDN}>
                    <AmountValue raw={b.pre} decimals={9} symbol="SOL" unit={t("common.lamports")} stacked />
                  </td>
                  <td className={TDN}>
                    <AmountValue raw={b.post} decimals={9} symbol="SOL" unit={t("common.lamports")} stacked />
                  </td>
                  <td className={TDN}>
                    <Delta raw={b.delta} decimals={9} sol />
                  </td>
                </tr>
              ))}
            </Table>
            {result.solBalanceChanges.some((b) => b.isFeePayer) && <div className="text-xs text-zinc-500">{t("tx.feePayerNote")}</div>}
          </Section>

          <Section
            title={t("tx.movements")}
            count={result.movements.length}
            empty={t("tx.noMovements")}
            always={result.solMovements.length === 0}
          >
            <Table
              minWidth={980}
              head={[
                t("tx.col.ix"),
                t("tx.col.type"),
                t("tx.col.from"),
                t("tx.col.to"),
                t("tx.col.authority"),
                t("tx.col.mint"),
                t("tx.col.amount"),
                t("tx.col.destDelta"),
              ]}
            >
              {result.movements.map((m, i) => (
                <MovementRow key={i} m={m} />
              ))}
            </Table>
          </Section>

          <Section title={t("tx.balanceChanges")} count={result.balanceChanges.length} empty={t("tx.noBalanceChanges")}>
            <Table
              minWidth={760}
              head={[t("tx.col.accountOwner"), t("tx.col.mint"), t("tx.col.program"), t("tx.col.pre"), t("tx.col.post"), t("tx.col.delta")]}
            >
              {result.balanceChanges.map((b) => (
                <tr key={`${b.account}-${b.mint}`} className={TR}>
                  <td className={TD}>
                    <KeyLine label={t("tx.col.account")} value={b.account} />
                    <KeyLine label={t("tx.col.owner")} value={b.owner} />
                  </td>
                  <td className={TD}>
                    <Key value={b.mint} />
                  </td>
                  <td className={TD}>
                    <ProgramBadge programId={b.programId} />
                  </td>
                  <td className={TDN}>
                    <AmountValue raw={b.pre} decimals={b.decimals} stacked />
                  </td>
                  <td className={TDN}>
                    <AmountValue raw={b.post} decimals={b.decimals} stacked />
                  </td>
                  <td className={TDN}>
                    <Delta raw={b.delta} decimals={b.decimals} />
                  </td>
                </tr>
              ))}
            </Table>
          </Section>
        </>
      )}
    </div>
  );
}
