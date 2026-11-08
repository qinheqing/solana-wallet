import { useState } from "react";
import {
  inspectTransaction,
  parseTransactionError,
  formatAmount,
  type Cluster,
  type TransactionInspection,
  type TokenMovement,
} from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { Badge, Button, Card, ErrorBanner, Input, Label, Textarea } from "../../components/ui";
import { CopyButton, shortKey } from "../../components/CopyButton";
import { downloadText, stringifyJson } from "../../lib/download";

type Mode = "signature" | "json";

function fmtTime(blockTime: number | null): string {
  if (blockTime === null) return "—";
  return `${new Date(blockTime * 1000).toLocaleString()} (${blockTime})`;
}

/** Raw amount + decimals → formatted string via core formatAmount (never uiAmount). */
function fmtRaw(raw: string | null, decimals: number | null): string {
  if (raw === null) return "—";
  if (decimals === null) return raw;
  try {
    return `${formatAmount(BigInt(raw), decimals)} (${raw})`;
  } catch {
    return raw;
  }
}

function KeyCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-zinc-600">—</span>;
  return (
    <span className="inline-flex items-center gap-1" title={value}>
      <span className="font-mono">{shortKey(value)}</span>
      <CopyButton text={value} label="⧉" className="px-1" />
    </span>
  );
}

function MovementRow({ m }: { m: TokenMovement }) {
  return (
    <tr className="border-t border-zinc-800/60 align-top">
      <td className="py-1 pr-2 text-zinc-500">
        {m.instructionIndex}
        {m.isInner ? `.${m.innerIndex}` : ""}
      </td>
      <td className="py-1 pr-2">
        <Badge tone={m.program === "token-2022" ? "success" : "default"}>{m.program}</Badge>
      </td>
      <td className="py-1 pr-2">
        <span className="font-mono">{m.instructionType === "other" ? m.rawType ?? "other" : m.instructionType}</span>
        {m.isInner && <Badge tone="warn">inner</Badge>}
      </td>
      <td className="py-1 pr-2">
        <div>
          owner <KeyCell value={m.sourceOwner} />
        </div>
        <div>
          acct <KeyCell value={m.sourceAccount} />
        </div>
        {m.sourceAccounts && m.sourceAccounts.length > 0 && (
          <div className="text-zinc-500">+{m.sourceAccounts.length} 个源账户</div>
        )}
      </td>
      <td className="py-1 pr-2">
        <div>
          owner <KeyCell value={m.destOwner} />
        </div>
        <div>
          acct <KeyCell value={m.destAccount} />
        </div>
      </td>
      <td className="py-1 pr-2">
        <KeyCell value={m.authority} />
      </td>
      <td className="py-1 pr-2">
        <KeyCell value={m.mint} />
      </td>
      <td className="py-1 pr-2 font-mono">
        {fmtRaw(m.amount, m.decimals)}
        {m.decimals !== null && <div className="text-zinc-500">dec {m.decimals}</div>}
      </td>
      <td className="py-1 pr-2 font-mono">
        {m.fee ? (
          <>
            {fmtRaw(m.fee.amount, m.decimals)}
            <div className="text-zinc-500">{m.fee.source}</div>
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="py-1 pr-2 font-mono">{fmtRaw(m.balanceDelta, m.decimals)}</td>
    </tr>
  );
}

export function InspectPage() {
  const { connection, state } = useApp();
  const [mode, setMode] = useState<Mode>("signature");
  const [signature, setSignature] = useState("");
  const [json, setJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TransactionInspection | null>(null);

  const run = async () => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      if (mode === "signature") {
        const sig = signature.trim();
        if (!sig) throw new Error("请输入交易 signature");
        setResult(await inspectTransaction({ conn: connection, signature: sig }));
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch {
          throw new Error("JSON 解析失败：请粘贴完整的 getTransaction(jsonParsed) 返回值");
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
    if (!result) return;
    const name = result.signature ? `tx-${result.signature.slice(0, 12)}.json` : "tx-inspection.json";
    downloadText(name, stringifyJson(result));
  };

  const failed = result ? result.err !== null && result.err !== undefined : false;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">交易查看器</h2>
      <Card className="space-y-3">
        <div className="flex gap-2">
          <Button variant={mode === "signature" ? "primary" : "default"} onClick={() => setMode("signature")}>
            按 signature 查询
          </Button>
          <Button variant={mode === "json" ? "primary" : "default"} onClick={() => setMode("json")}>
            粘贴 JSON（离线）
          </Button>
        </div>
        {mode === "signature" ? (
          <div>
            <Label htmlFor="inspect-signature">交易 signature</Label>
            <Input id="inspect-signature" value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="base58 signature" />
            <p className="mt-1 text-xs text-zinc-500">在当前 cluster（{connection.rpcUrl}）上查询，commitment=confirmed。</p>
          </div>
        ) : (
          <div>
            <Label htmlFor="inspect-json">getTransaction(jsonParsed) 返回值</Label>
            <Textarea
              id="inspect-json"
              rows={8}
              className="font-mono text-xs"
              value={json}
              onChange={(e) => setJson(e.target.value)}
              placeholder='{"slot":…,"transaction":{…},"meta":{…}}  （也可粘贴带 result 的 JSON-RPC 响应）'
            />
            <p className="mt-1 text-xs text-zinc-500">
              纯离线解析，不访问网络。需用 encoding=jsonParsed、maxSupportedTransactionVersion=0 获取。
            </p>
          </div>
        )}
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy} onClick={run}>
            {busy ? "解析中…" : "查看"}
          </Button>
          {result && (
            <Button variant="default" onClick={exportJson}>
              导出 JSON
            </Button>
          )}
        </div>
      </Card>

      {result && (
        <>
          <Card className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-300">概览</h3>
              <Badge tone={failed ? "danger" : "success"}>{failed ? "失败" : "成功"}</Badge>
              {result.explorerUrl && (
                <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="text-xs text-emerald-400 hover:underline">
                  在 Explorer 打开 ↗
                </a>
              )}
            </div>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
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
              <dd className="font-mono text-xs">{result.fee} lamports</dd>
              <dt className="text-zinc-500">err</dt>
              <dd className="font-mono text-xs break-all">
                {failed ? JSON.stringify(result.err) : "null"}
                {result.decodedError && (
                  <div className="mt-1 text-red-300">
                    ix #{result.decodedError.instructionIndex ?? "?"} · program {shortKey(result.decodedError.programId)} ·{" "}
                    {result.decodedError.name ?? result.decodedError.kind ?? `custom ${result.decodedError.customCode ?? "?"}`}
                  </div>
                )}
              </dd>
            </dl>
          </Card>

          <Card className="space-y-2">
            <h3 className="text-sm font-semibold text-zinc-300">代币流动（movements · {result.movements.length}）</h3>
            {result.movements.length === 0 ? (
              <div className="text-sm text-zinc-500">该交易没有代币程序指令。</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1100px] text-left text-xs text-zinc-300">
                  <thead className="text-zinc-500">
                    <tr>
                      <th className="pr-2 font-medium">ix</th>
                      <th className="pr-2 font-medium">program</th>
                      <th className="pr-2 font-medium">type</th>
                      <th className="pr-2 font-medium">from</th>
                      <th className="pr-2 font-medium">to</th>
                      <th className="pr-2 font-medium">authority</th>
                      <th className="pr-2 font-medium">mint</th>
                      <th className="pr-2 font-medium">amount (raw)</th>
                      <th className="pr-2 font-medium">fee</th>
                      <th className="pr-2 font-medium">dest Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.movements.map((m, i) => (
                      <MovementRow key={i} m={m} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="space-y-2">
            <h3 className="text-sm font-semibold text-zinc-300">余额变化（balanceChanges · {result.balanceChanges.length}）</h3>
            {result.balanceChanges.length === 0 ? (
              <div className="text-sm text-zinc-500">无代币余额变化。</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-xs text-zinc-300">
                  <thead className="text-zinc-500">
                    <tr>
                      <th className="pr-2 font-medium">account</th>
                      <th className="pr-2 font-medium">owner</th>
                      <th className="pr-2 font-medium">mint</th>
                      <th className="pr-2 font-medium">program</th>
                      <th className="pr-2 font-medium">pre</th>
                      <th className="pr-2 font-medium">post</th>
                      <th className="pr-2 font-medium">Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.balanceChanges.map((b) => (
                      <tr key={`${b.account}-${b.mint}`} className="border-t border-zinc-800/60">
                        <td className="py-1 pr-2">
                          <KeyCell value={b.account} />
                        </td>
                        <td className="py-1 pr-2">
                          <KeyCell value={b.owner} />
                        </td>
                        <td className="py-1 pr-2">
                          <KeyCell value={b.mint} />
                        </td>
                        <td className="py-1 pr-2 font-mono">{shortKey(b.programId)}</td>
                        <td className="py-1 pr-2 font-mono">{fmtRaw(b.pre, b.decimals)}</td>
                        <td className="py-1 pr-2 font-mono">{fmtRaw(b.post, b.decimals)}</td>
                        <td className={`py-1 pr-2 font-mono ${b.delta.startsWith("-") ? "text-red-300" : "text-emerald-300"}`}>
                          {fmtRaw(b.delta, b.decimals)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {result.warnings.length > 0 && (
            <Card>
              <h3 className="mb-1 text-sm font-semibold text-amber-300">警告（{result.warnings.length}）</h3>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-300">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
