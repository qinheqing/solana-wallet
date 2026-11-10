import type { SignedTransactionInspection, SignedTxInstruction, DecodedValue } from "../../lib/coreShim";
import { useT } from "../../lib/i18n";
import { Badge, Button, Card } from "../../components/ui";
import { AmountValue } from "../../components/Amount";
import { CopyButton } from "../../components/CopyButton";
import { Key, Section, TD, TDN, TR, Table } from "./parts";

const PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LAMPORT_KEYS = new Set(["lamports"]);

function Flags({ signer, writable }: { signer: boolean; writable: boolean }) {
  const t = useT();
  return (
    <span className="inline-flex gap-1 whitespace-nowrap">
      {signer && <Badge tone="warn">{t("raw.signer")}</Badge>}
      {writable ? <Badge tone="success">{t("raw.writable")}</Badge> : <Badge>{t("raw.readonly")}</Badge>}
    </span>
  );
}

function Value({ k, v }: { k: string; v: DecodedValue }) {
  const t = useT();
  if (v === null) return <span className="text-zinc-600">—</span>;
  if (LAMPORT_KEYS.has(k) && (typeof v === "string" || typeof v === "number")) {
    return <AmountValue raw={String(v)} decimals={9} symbol="SOL" unit={t("common.lamports")} />;
  }
  if (typeof v === "string" && PUBKEY.test(v)) return <Key value={v} />;
  return <span className="break-all font-mono text-zinc-200">{String(v)}</span>;
}

function InstructionCard({ ix }: { ix: SignedTxInstruction }) {
  const t = useT();
  const info = ix.decoded ? Object.entries(ix.decoded.info) : [];
  return (
    <div className="rounded-md border border-zinc-800">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900/80 px-3 py-2">
        <span className="font-mono text-xs text-zinc-400">#{ix.index}</span>
        <span className="text-sm font-medium text-zinc-200">{ix.programName ?? t("raw.unknownProgram")}</span>
        {ix.decoded ? (
          <span className="font-mono text-sm text-emerald-300">{ix.decoded.type}</span>
        ) : (
          <Badge>{t("raw.notDecoded")}</Badge>
        )}
        <span className="ml-auto text-xs">
          <Key value={ix.programId} />
        </span>
      </div>
      <div className="grid gap-4 p-3 lg:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] text-zinc-500">{t("raw.params")}</div>
          {info.length === 0 ? (
            <div className="text-xs text-zinc-500">{ix.decoded ? t("raw.noParams") : t("raw.seeData")}</div>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              {info.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-zinc-500">{k}</dt>
                  <dd className="min-w-0">
                    <Value k={k} v={v} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <div>
          <div className="mb-1 text-[11px] text-zinc-500">{t("raw.ixAccounts", { n: ix.accounts.length })}</div>
          {ix.accounts.length === 0 ? (
            <div className="text-xs text-zinc-500">—</div>
          ) : (
            <ul className="space-y-1 text-xs">
              {ix.accounts.map((a, i) => (
                <li key={i} className="flex items-center gap-2 whitespace-nowrap">
                  <span className="w-6 shrink-0 font-mono text-zinc-500">{i}</span>
                  {a.pubkey ? <Key value={a.pubkey} /> : <span className="text-zinc-500">{t("raw.lookupUnresolved", { i: a.index })}</span>}
                  <Flags signer={a.signer} writable={a.writable} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <details className="border-t border-zinc-800 px-3 py-2 text-xs">
        <summary className="cursor-pointer select-none text-zinc-500 hover:text-zinc-300">
          {t("raw.data", { n: ix.dataLength })}
        </summary>
        <div className="mt-2 flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all font-mono text-zinc-300">{ix.dataHex || "—"}</code>
          {ix.dataHex && <CopyButton text={ix.dataHex} />}
        </div>
      </details>
    </div>
  );
}

function ChainBadge({ r, onOpen }: { r: SignedTransactionInspection; onOpen: (sig: string) => void }) {
  const t = useT();
  const c = r.chain;
  if (!c) return <span className="text-xs text-zinc-500">{t("raw.chainUnchecked")}</span>;
  if (c.status === "not-found") {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Badge tone="warn">{t("raw.notOnChain")}</Badge>
        {c.blockhashValid === true && <span className="text-xs text-zinc-400">{t("raw.blockhashValid")}</span>}
        {c.blockhashValid === false && <span className="text-xs text-red-300">{t("raw.blockhashExpired")}</span>}
      </span>
    );
  }
  const failed = c.err !== null && c.err !== undefined;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge tone={failed ? "danger" : "success"}>
        {t("raw.onChain")} · {c.status}
        {failed ? ` · ${t("tx.failed")}` : ""}
      </Badge>
      {c.slot !== null && <span className="font-mono text-xs text-zinc-400">slot {c.slot}</span>}
      {r.signature && (
        <Button variant="ghost" className="px-2 py-0.5 text-xs text-emerald-400" onClick={() => onOpen(r.signature!)}>
          {t("raw.openResult")}
        </Button>
      )}
    </span>
  );
}

export function RawTxView({ r, onOpenSignature }: { r: SignedTransactionInspection; onOpenSignature: (sig: string) => void }) {
  const t = useT();
  const sigTone = r.allSignaturesValid ? "success" : r.signatures.some((s) => s.valid === false) ? "danger" : "warn";
  const sigLabel = r.allSignaturesValid
    ? t("raw.sigAllValid")
    : r.signatures.some((s) => s.valid === false)
      ? t("raw.sigInvalid")
      : t("raw.sigMissing");
  return (
    <>
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-zinc-200">{t("tx.overview")}</h3>
          <Badge tone={sigTone}>{sigLabel}</Badge>
          <Badge>{r.version === "legacy" ? "legacy" : "v0"}</Badge>
          <span className="text-xs text-zinc-500">
            {r.encoding} · {r.sizeBytes} bytes
          </span>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-zinc-500">{t("raw.txId")}</dt>
          <dd className="flex min-w-0 items-center gap-1 font-mono text-xs">
            {r.signature ? (
              <>
                <span className="break-all">{r.signature}</span>
                <CopyButton text={r.signature} />
              </>
            ) : (
              <span className="text-zinc-500">{t("raw.unsigned")}</span>
            )}
          </dd>
          <dt className="text-zinc-500">{t("raw.chain")}</dt>
          <dd>
            <ChainBadge r={r} onOpen={onOpenSignature} />
          </dd>
          <dt className="text-zinc-500">{t("raw.feePayer")}</dt>
          <dd className="text-xs">
            <Key value={r.feePayer} />
          </dd>
          <dt className="text-zinc-500">recentBlockhash</dt>
          <dd className="text-xs">
            <Key value={r.recentBlockhash} />
          </dd>
          <dt className="text-zinc-500">header</dt>
          <dd className="font-mono text-xs text-zinc-400">
            {t("raw.header", {
              sig: r.header.numRequiredSignatures,
              ros: r.header.numReadonlySignedAccounts,
              rou: r.header.numReadonlyUnsignedAccounts,
            })}
          </dd>
        </dl>
      </Card>

      {r.warnings.length > 0 && (
        <Card className="border-amber-800/60">
          <h3 className="mb-1 text-sm font-semibold text-amber-300">{t("tx.warnings", { n: r.warnings.length })}</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-300">
            {r.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Card>
      )}

      <Section title={t("raw.instructions")} count={r.instructions.length} empty="—" always>
        <div className="space-y-3">
          {r.instructions.map((ix) => (
            <InstructionCard key={ix.index} ix={ix} />
          ))}
        </div>
      </Section>

      <Section title={t("raw.signatures")} count={r.signatures.length} empty="—" always>
        <Table minWidth={560} head={[t("raw.signerCol"), t("raw.signatureCol"), t("raw.verify")]}>
          {r.signatures.map((s, i) => (
            <tr key={i} className={TR}>
              <td className={TD}>
                <Key value={s.signer} />
              </td>
              <td className={TD}>{s.signature ? <Key value={s.signature} /> : <span className="text-zinc-500">{t("raw.unsigned")}</span>}</td>
              <td className={TDN}>
                {s.valid === null ? (
                  <Badge tone="warn">{t("raw.missing")}</Badge>
                ) : s.valid ? (
                  <Badge tone="success">{t("raw.valid")}</Badge>
                ) : (
                  <Badge tone="danger">{t("raw.invalid")}</Badge>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title={t("raw.accounts")} count={r.accounts.length} empty="—" always>
        <Table minWidth={560} head={["#", t("tx.col.account"), t("raw.role"), t("raw.source")]}>
          {r.accounts.map((a) => (
            <tr key={a.index} className={TR}>
              <td className={`${TD} font-mono text-zinc-500`}>{a.index}</td>
              <td className={TD}>{a.pubkey ? <Key value={a.pubkey} /> : <span className="text-zinc-500">{t("raw.unresolved")}</span>}</td>
              <td className={TD}>
                <span className="inline-flex gap-1">
                  {a.index === 0 && <Badge>{t("tx.feePayer")}</Badge>}
                  <Flags signer={a.signer} writable={a.writable} />
                </span>
              </td>
              <td className={TDN}>
                {a.lookup ? (
                  <span className="inline-flex items-center gap-1 text-zinc-400">
                    ALT <Key value={a.lookup.table} /> [{a.lookup.index}]
                  </span>
                ) : (
                  <span className="text-zinc-500">{t("raw.static")}</span>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Section>
    </>
  );
}
