import { useEffect, useState } from "react";
import { inspectMint, parseTransactionError, type MintExtension, type MintInspection } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT } from "../../lib/i18n";
import { Badge, ErrorBanner } from "../../components/ui";
import { AmountValue } from "../../components/Amount";
import { CopyButton, shortKey } from "../../components/CopyButton";

function Key({ value }: { value: string | null }) {
  const t = useT();
  if (!value) return <span className="text-zinc-500">{t("mint.null")}</span>;
  return (
    <span className="inline-flex items-center gap-1 font-mono" title={value}>
      {shortKey(value, 6)}
      <CopyButton text={value} label="⧉" className="px-1" />
    </span>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-zinc-500">{k}</dt>
      <dd className="min-w-0 break-all text-zinc-200">{children}</dd>
    </>
  );
}

/** Decoded parameters for one extension (shape per MintExtension variant). */
function ExtensionBody({ ext, decimals }: { ext: MintExtension; decimals: number }) {
  const t = useT();
  switch (ext.type) {
    case "TransferFeeConfig":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <Row k={t("mint.configAuthority")}>
            <Key value={ext.transferFeeConfigAuthority} />
          </Row>
          <Row k={t("mint.withdrawAuthority")}>
            <Key value={ext.withdrawWithheldAuthority} />
          </Row>
          <Row k={t("mint.withheld")}>
            <AmountValue raw={ext.withheldAmount} decimals={decimals} />
          </Row>
          <Row k={t("mint.olderFee")}>
            {t("mint.feeTier", { epoch: ext.olderTransferFee.epoch, bps: ext.olderTransferFee.transferFeeBasisPoints })}{" "}
            <AmountValue raw={ext.olderTransferFee.maximumFee} decimals={decimals} />
          </Row>
          <Row k={t("mint.newerFee")}>
            {t("mint.feeTier", { epoch: ext.newerTransferFee.epoch, bps: ext.newerTransferFee.transferFeeBasisPoints })}{" "}
            <AmountValue raw={ext.newerTransferFee.maximumFee} decimals={decimals} />
          </Row>
        </dl>
      );
    case "PermanentDelegate":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <Row k="delegate">
            <Key value={ext.delegate} />
          </Row>
        </dl>
      );
    case "TransferHook":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <Row k={t("mint.hookProgram")}>
            <Key value={ext.programId} />
          </Row>
          <Row k={t("mint.authority")}>
            <Key value={ext.authority} />
          </Row>
        </dl>
      );
    case "ScaledUiAmount":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <Row k="multiplier">{ext.multiplier}</Row>
          <Row k="newMultiplier">
            {ext.newMultiplier} · {t("mint.effectiveTs")} {ext.newMultiplierEffectiveTimestamp}
          </Row>
          <Row k={t("mint.authority")}>
            <Key value={ext.authority} />
          </Row>
        </dl>
      );
    case "MetadataPointer":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <Row k={t("mint.metadataAddress")}>
            <Key value={ext.metadataAddress} />
          </Row>
          <Row k={t("mint.authority")}>
            <Key value={ext.authority} />
          </Row>
        </dl>
      );
    case "TokenMetadata":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <Row k="name">{ext.name}</Row>
          <Row k="symbol">{ext.symbol}</Row>
          <Row k="uri">{ext.uri || "—"}</Row>
          <Row k={t("mint.updateAuthority")}>
            <Key value={ext.updateAuthority} />
          </Row>
          {ext.additionalMetadata.map(([k, v]) => (
            <Row key={k} k={`· ${k}`}>
              {v}
            </Row>
          ))}
        </dl>
      );
    case "InterestBearingConfig":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <Row k={t("mint.currentRate")}>{t("mint.bpsPerYear", { n: ext.currentRate })}</Row>
          <Row k={t("mint.preUpdateAvg")}>{t("mint.bpsPerYear", { n: ext.preUpdateAverageRate })}</Row>
          <Row k={t("mint.initLast")}>
            {ext.initializationTimestamp} / {ext.lastUpdateTimestamp}
          </Row>
          <Row k={t("mint.rateAuthority")}>
            <Key value={ext.rateAuthority} />
          </Row>
        </dl>
      );
    case "DefaultAccountState":
      return (
        <div>
          {t("mint.defaultState")} <Badge tone={ext.state === "frozen" ? "danger" : "success"}>{ext.state}</Badge>
        </div>
      );
    case "MintCloseAuthority":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <Row k="closeAuthority">
            <Key value={ext.closeAuthority} />
          </Row>
        </dl>
      );
    case "GroupPointer":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <Row k={t("mint.groupAddress")}>
            <Key value={ext.groupAddress} />
          </Row>
          <Row k={t("mint.authority")}>
            <Key value={ext.authority} />
          </Row>
        </dl>
      );
    case "GroupMemberPointer":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <Row k={t("mint.memberAddress")}>
            <Key value={ext.memberAddress} />
          </Row>
          <Row k={t("mint.authority")}>
            <Key value={ext.authority} />
          </Row>
        </dl>
      );
    case "Pausable":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <Row k="paused">
            <Badge tone={ext.paused ? "danger" : "success"}>{String(ext.paused)}</Badge>
          </Row>
          <Row k={t("mint.authority")}>
            <Key value={ext.authority} />
          </Row>
        </dl>
      );
    case "unknown":
      return <div className="text-zinc-500">{t("mint.unknown", { rawType: ext.rawType, length: ext.length })}</div>;
    default:
      // NonTransferable / ConfidentialTransfer* / TokenGroup* / PermissionedBurn: flag-only.
      return <div className="text-zinc-500">{t("mint.flagOnly")}</div>;
  }
}

const RISKY: ReadonlySet<MintExtension["type"]> = new Set(["TransferHook", "PermanentDelegate", "NonTransferable", "Pausable", "DefaultAccountState"]);

export function MintInspectionPanel({ mint }: { mint: string }) {
  const t = useT();
  const { connection } = useApp();
  const [data, setData] = useState<MintInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setLoading(true);
    inspectMint(connection, mint)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (cancelled) return;
        const pe = parseTransactionError(e);
        setError(`${pe.code}: ${pe.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, mint]);

  return (
    <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-950/40 p-3 text-xs">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-zinc-300">{t("mint.title")}</h4>
        {loading && <span className="text-zinc-500">{t("mint.loading")}</span>}
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {data && (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <Row k="program">
              <Badge tone={data.program === "token-2022" ? "success" : "default"}>{data.program}</Badge>{" "}
              <span className="font-mono text-zinc-500">{shortKey(data.programId, 6)}</span>
            </Row>
            <Row k="decimals">{data.decimals}</Row>
            <Row k="supply">
              <AmountValue raw={data.supply} decimals={data.decimals} />
            </Row>
            <Row k="mintAuthority">
              <Key value={data.mintAuthority} />
            </Row>
            <Row k="freezeAuthority">
              <Key value={data.freezeAuthority} />
            </Row>
            <Row k={t("mint.accountLen")}>{t("common.bytes", { n: data.accountLen })}</Row>
            <Row k={t("mint.dataLength")}>{t("common.bytes", { n: data.dataLength })}</Row>
          </dl>
          <div>
            <div className="mb-1 text-zinc-500">{t("mint.extensions", { n: data.extensions.length })}</div>
            {data.extensions.length === 0 ? (
              <div className="text-zinc-500">{t("mint.noExtensions")}</div>
            ) : (
              <ul className="space-y-1.5">
                {data.extensions.map((ext, i) => (
                  <li key={`${ext.type}-${i}`} className="rounded border border-zinc-800 p-2">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="font-semibold text-zinc-100">{ext.type}</span>
                      {RISKY.has(ext.type) && <Badge tone="warn">{t("mint.affectsTransfer")}</Badge>}
                    </div>
                    <ExtensionBody ext={ext} decimals={data.decimals} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
