import { useEffect, useState } from "react";
import { formatAmount, inspectMint, parseTransactionError, type MintExtension, type MintInspection } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { Badge, ErrorBanner } from "../../components/ui";
import { CopyButton, shortKey } from "../../components/CopyButton";

function Key({ value }: { value: string | null }) {
  if (!value) return <span className="text-zinc-500">无 (null)</span>;
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

function fmt(raw: string, decimals: number): string {
  try {
    return `${formatAmount(BigInt(raw), decimals)} (${raw})`;
  } catch {
    return raw;
  }
}

/** Decoded parameters for one extension (shape per MintExtension variant). */
function ExtensionBody({ ext, decimals }: { ext: MintExtension; decimals: number }) {
  switch (ext.type) {
    case "TransferFeeConfig":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <Row k="配置权限">
            <Key value={ext.transferFeeConfigAuthority} />
          </Row>
          <Row k="提取权限">
            <Key value={ext.withdrawWithheldAuthority} />
          </Row>
          <Row k="mint 内暂扣">{fmt(ext.withheldAmount, decimals)}</Row>
          <Row k="旧费率">
            epoch {ext.olderTransferFee.epoch} · {ext.olderTransferFee.transferFeeBasisPoints} bps · 上限{" "}
            {fmt(ext.olderTransferFee.maximumFee, decimals)}
          </Row>
          <Row k="新费率">
            epoch {ext.newerTransferFee.epoch} · {ext.newerTransferFee.transferFeeBasisPoints} bps · 上限{" "}
            {fmt(ext.newerTransferFee.maximumFee, decimals)}
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
          <Row k="hook 程序">
            <Key value={ext.programId} />
          </Row>
          <Row k="权限">
            <Key value={ext.authority} />
          </Row>
        </dl>
      );
    case "ScaledUiAmount":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <Row k="multiplier">{ext.multiplier}</Row>
          <Row k="newMultiplier">
            {ext.newMultiplier} · 生效时间戳 {ext.newMultiplierEffectiveTimestamp}
          </Row>
          <Row k="权限">
            <Key value={ext.authority} />
          </Row>
        </dl>
      );
    case "MetadataPointer":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <Row k="metadata 地址">
            <Key value={ext.metadataAddress} />
          </Row>
          <Row k="权限">
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
          <Row k="更新权限">
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
          <Row k="当前利率">{ext.currentRate} bps/年</Row>
          <Row k="更新前均值">{ext.preUpdateAverageRate} bps/年</Row>
          <Row k="初始化 / 最近更新">
            {ext.initializationTimestamp} / {ext.lastUpdateTimestamp}
          </Row>
          <Row k="利率权限">
            <Key value={ext.rateAuthority} />
          </Row>
        </dl>
      );
    case "DefaultAccountState":
      return (
        <div>
          默认账户状态：<Badge tone={ext.state === "frozen" ? "danger" : "success"}>{ext.state}</Badge>
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
          <Row k="group 地址">
            <Key value={ext.groupAddress} />
          </Row>
          <Row k="权限">
            <Key value={ext.authority} />
          </Row>
        </dl>
      );
    case "GroupMemberPointer":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <Row k="member 地址">
            <Key value={ext.memberAddress} />
          </Row>
          <Row k="权限">
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
          <Row k="权限">
            <Key value={ext.authority} />
          </Row>
        </dl>
      );
    case "unknown":
      return (
        <div className="text-zinc-500">
          未知扩展 rawType={ext.rawType}，长度 {ext.length} 字节
        </div>
      );
    default:
      // NonTransferable / ConfidentialTransfer* / TokenGroup* / PermissionedBurn: flag-only.
      return <div className="text-zinc-500">无参数（标记型扩展）</div>;
  }
}

const RISKY: ReadonlySet<MintExtension["type"]> = new Set(["TransferHook", "PermanentDelegate", "NonTransferable", "Pausable", "DefaultAccountState"]);

export function MintInspectionPanel({ mint }: { mint: string }) {
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
        <h4 className="text-sm font-semibold text-zinc-300">Mint 详情（inspectMint）</h4>
        {loading && <span className="text-zinc-500">读取中…</span>}
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
            <Row k="supply">{fmt(data.supply, data.decimals)}</Row>
            <Row k="mintAuthority">
              <Key value={data.mintAuthority} />
            </Row>
            <Row k="freezeAuthority">
              <Key value={data.freezeAuthority} />
            </Row>
            <Row k="accountLen (ATA)">{data.accountLen} bytes</Row>
            <Row k="mint 数据长度">{data.dataLength} bytes</Row>
          </dl>
          <div>
            <div className="mb-1 text-zinc-500">扩展（{data.extensions.length}）</div>
            {data.extensions.length === 0 ? (
              <div className="text-zinc-500">无扩展。</div>
            ) : (
              <ul className="space-y-1.5">
                {data.extensions.map((ext, i) => (
                  <li key={`${ext.type}-${i}`} className="rounded border border-zinc-800 p-2">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="font-semibold text-zinc-100">{ext.type}</span>
                      {RISKY.has(ext.type) && <Badge tone="warn">影响转账</Badge>}
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
