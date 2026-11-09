/**
 * Token-2022 extension runtime management: one section per extension the
 * mint actually has (TransferFee, Pausable, MintCloseAuthority, TransferHook,
 * ScaledUiAmount, InterestBearing, DefaultAccountState), plus account-level
 * MemoTransfer on this wallet's ATA and extension-authority rotation.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  closeMint,
  disableMemoTransfer,
  enableMemoTransfer,
  findWithheldAccounts,
  harvestWithheldToMint,
  inspectMint,
  inspectTokenAccount,
  parseTransactionError,
  pauseMint,
  resumeMint,
  setExtensionAuthority,
  setTransferFee,
  updateDefaultAccountState,
  updateInterestRate,
  updateScaledUiMultiplier,
  updateTransferHookProgram,
  withdrawWithheldFromAccounts,
  withdrawWithheldFromMint,
  type ExtensionAuthorityKind,
  type MintExtension,
  type MintInspection,
  type TokenManageResult,
  type WithheldAccount,
} from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT, type TKey } from "../../lib/i18n";
import { Badge, Button, ErrorBanner, Input, Label } from "../../components/ui";
import { AmountHint, AmountValue } from "../../components/Amount";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Address } from "../../components/CopyButton";
import { ResultView, type SimpleTxOutcome } from "../transfer/ResultView";

type ExtOf<T extends MintExtension["type"]> = Extract<MintExtension, { type: T }>;

function findExt<T extends MintExtension["type"]>(info: MintInspection, type: T): ExtOf<T> | undefined {
  return info.extensions.find((e) => e.type === type) as ExtOf<T> | undefined;
}

function toOutcome(res: TokenManageResult): SimpleTxOutcome {
  if (res.error) return { error: res.error };
  return { signature: res.signature, slot: res.slot, feeLamports: res.feeLamports, simulatedOnly: res.simulatedOnly };
}

function KeyView({ value }: { value: string | null | undefined }) {
  const t = useT();
  return <Address value={value} empty={t("mint.null")} className="text-zinc-200" />;
}

/** Label / value row — fixed label column so rows line up across sections. */
function InfoRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-baseline gap-x-4 sm:grid-cols-[10rem_1fr]">
      <div className="text-zinc-500">{label}</div>
      <div className="min-w-0 break-words text-zinc-200">{children}</div>
    </div>
  );
}

/** "authority: X" line plus a warning when the unlocked wallet is not X. */
function AuthorityLine({ label, holder, me }: { label: string; holder: string | null | undefined; me: string | null }) {
  const t = useT();
  return (
    <InfoRow label={label}>
      <KeyView value={holder} />
      {holder && me && holder !== me && <div className="text-amber-300">{t("extm.notAuthority")}</div>}
      {!holder && <span className="ml-2 text-amber-300">{t("extm.revoked")}</span>}
    </InfoRow>
  );
}

function Section({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-3 rounded-md border border-zinc-800 p-3 text-xs leading-5">
      <div className="flex items-center gap-2">
        <h5 className="text-sm font-semibold text-zinc-200">{title}</h5>
        {badge}
      </div>
      {children}
    </div>
  );
}

interface PendingConfirm {
  title: string;
  description: ReactNode;
  requireText?: string;
  danger?: boolean;
  confirmLabel: string;
  run: () => void;
}

const AUTHORITY_LABEL: Record<ExtensionAuthorityKind, TKey> = {
  transferFeeConfig: "extm.auth.transferFeeConfig",
  withheldWithdraw: "extm.auth.withheldWithdraw",
  closeMint: "extm.auth.closeMint",
  interestRate: "extm.auth.interestRate",
  permanentDelegate: "extm.auth.permanentDelegate",
  transferHookProgramId: "extm.auth.transferHook",
  metadataPointer: "extm.auth.metadataPointer",
  scaledUiAmount: "extm.auth.scaledUiAmount",
  pausable: "extm.auth.pausable",
};

/** Current holder of each extension authority present on the mint. */
function extensionAuthorities(info: MintInspection): Array<{ kind: ExtensionAuthorityKind; holder: string | null }> {
  const out: Array<{ kind: ExtensionAuthorityKind; holder: string | null }> = [];
  for (const e of info.extensions) {
    switch (e.type) {
      case "TransferFeeConfig":
        out.push({ kind: "transferFeeConfig", holder: e.transferFeeConfigAuthority });
        out.push({ kind: "withheldWithdraw", holder: e.withdrawWithheldAuthority });
        break;
      case "MintCloseAuthority":
        out.push({ kind: "closeMint", holder: e.closeAuthority });
        break;
      case "InterestBearingConfig":
        out.push({ kind: "interestRate", holder: e.rateAuthority });
        break;
      case "PermanentDelegate":
        out.push({ kind: "permanentDelegate", holder: e.delegate });
        break;
      case "TransferHook":
        out.push({ kind: "transferHookProgramId", holder: e.authority });
        break;
      case "MetadataPointer":
        out.push({ kind: "metadataPointer", holder: e.authority });
        break;
      case "ScaledUiAmount":
        out.push({ kind: "scaledUiAmount", holder: e.authority });
        break;
      case "Pausable":
        out.push({ kind: "pausable", holder: e.authority });
        break;
      default:
        break;
    }
  }
  return out;
}

export function ExtensionManagePanel({
  mint,
  tokenAccount,
  refreshKey,
  onChanged,
}: {
  mint: string;
  /** This wallet's token account for the mint (MemoTransfer status). */
  tokenAccount: string | null;
  refreshKey: number;
  onChanged: () => void;
}) {
  const t = useT();
  const { connection, state } = useApp();
  const keypair = state.unlockedKeypair;
  const me = keypair?.publicKey.toBase58() ?? null;
  const isMainnet = state.cluster === "mainnet-beta";

  const [info, setInfo] = useState<MintInspection | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [memoRequired, setMemoRequired] = useState<boolean | null>(null);
  const [mainnetAck, setMainnetAck] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ section: string; outcome: SimpleTxOutcome } | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

  // form state
  const [feeBps, setFeeBps] = useState("");
  const [feeMax, setFeeMax] = useState("");
  const [withheld, setWithheld] = useState<WithheldAccount[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [withdrawDest, setWithdrawDest] = useState("");
  const [closeDest, setCloseDest] = useState("");
  const [hookProgram, setHookProgram] = useState("");
  const [scaledMul, setScaledMul] = useState("");
  const [scaledTs, setScaledTs] = useState("");
  const [rate, setRate] = useState("");
  const [authKind, setAuthKind] = useState<ExtensionAuthorityKind | "">("");
  const [authNew, setAuthNew] = useState("");
  const [authRevoke, setAuthRevoke] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    inspectMint(connection, mint)
      .then((d) => {
        if (!cancelled) setInfo(d);
      })
      .catch((e) => {
        if (cancelled) return;
        const pe = parseTransactionError(e);
        setLoadError(`${pe.code}: ${pe.message}`);
      });
    if (tokenAccount) {
      inspectTokenAccount(connection, tokenAccount)
        .then((a) => {
          if (cancelled) return;
          const memo = a.extensions.find((e) => e.type === "MemoTransfer");
          setMemoRequired(memo && memo.type === "MemoTransfer" ? memo.requireIncomingTransferMemos : false);
        })
        .catch(() => {
          if (!cancelled) setMemoRequired(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [connection, mint, tokenAccount, refreshKey]);

  // reset forms when switching mints
  useEffect(() => {
    setInfo(null);
    setResult(null);
    setWithheld(null);
    setSelected(new Set());
    setFeeBps("");
    setFeeMax("");
    setWithdrawDest("");
    setCloseDest("");
    setHookProgram("");
    setScaledMul("");
    setScaledTs("");
    setRate("");
    setAuthKind("");
    setAuthNew("");
    setAuthRevoke(false);
  }, [mint]);

  const opts = { allowMainnet: isMainnet ? mainnetAck : undefined };

  const exec = async (section: string, fn: () => Promise<TokenManageResult>) => {
    if (!keypair) return;
    setBusy(section);
    setResult(null);
    try {
      const outcome = toOutcome(await fn());
      setResult({ section, outcome });
      if (!outcome.error && !outcome.simulatedOnly) onChanged();
    } catch (e) {
      setResult({ section, outcome: { error: parseTransactionError(e) } });
    } finally {
      setBusy(null);
    }
  };

  const ResultFor = ({ section }: { section: string }) =>
    result?.section === section ? <ResultView result={result.outcome} /> : null;

  const disabled = (section: string) => busy !== null || !keypair || busy === section;

  if (loadError) return <ErrorBanner>{loadError}</ErrorBanner>;
  if (!info) return <div className="text-xs text-zinc-500">{t("common.loading")}</div>;
  if (info.program !== "token-2022") return null;

  const fee = findExt(info, "TransferFeeConfig");
  const pausable = findExt(info, "Pausable");
  const closeAuth = findExt(info, "MintCloseAuthority");
  const hook = findExt(info, "TransferHook");
  const scaled = findExt(info, "ScaledUiAmount");
  const interest = findExt(info, "InterestBearingConfig");
  const das = findExt(info, "DefaultAccountState");
  const authorities = extensionAuthorities(info);
  const authHolder = authorities.find((a) => a.kind === authKind)?.holder ?? null;

  const toggleSel = (addr: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });

  const scan = async () => {
    setScanning(true);
    setScanError(null);
    try {
      const list = await findWithheldAccounts(connection, mint);
      setWithheld(list);
      setSelected(new Set(list.map((a) => a.address)));
    } catch (e) {
      const pe = parseTransactionError(e);
      setScanError(`${pe.code}: ${pe.message}`);
    } finally {
      setScanning(false);
    }
  };

  const doAuthority = () =>
    exec("authority", () =>
      setExtensionAuthority(connection, keypair!, mint, authKind as ExtensionAuthorityKind, authRevoke ? null : authNew.trim(), {
        ...opts,
        confirmRevoke: authRevoke,
      }),
    );

  return (
    <div className="space-y-3">
      {!keypair && <div className="text-xs text-amber-300">{t("common.selectUnlockFirst")}</div>}
      {isMainnet && (
        <label className="flex items-center gap-2 text-sm text-amber-300">
          <input type="checkbox" checked={mainnetAck} onChange={(e) => setMainnetAck(e.target.checked)} />
          {t("token.manage.mainnetAck")}
        </label>
      )}

      {/* ---------------- TransferFeeConfig ---------------- */}
      {fee && (
        <Section title="TransferFeeConfig">
          <div className="space-y-2">
            <InfoRow label={t("extm.fee.current")}>
              {fee.newerTransferFee.transferFeeBasisPoints} bps · {t("extm.fee.max")}{" "}
              <AmountValue raw={fee.newerTransferFee.maximumFee} decimals={info.decimals} />
              <span className="ml-1 text-zinc-500">(epoch ≥ {fee.newerTransferFee.epoch})</span>
            </InfoRow>
            {(fee.olderTransferFee.transferFeeBasisPoints !== fee.newerTransferFee.transferFeeBasisPoints ||
              fee.olderTransferFee.maximumFee !== fee.newerTransferFee.maximumFee) && (
              <InfoRow label={t("extm.fee.older")}>
                {fee.olderTransferFee.transferFeeBasisPoints} bps · {t("extm.fee.max")}{" "}
                <AmountValue raw={fee.olderTransferFee.maximumFee} decimals={info.decimals} />
              </InfoRow>
            )}
            <InfoRow label={t("extm.fee.withheldOnMint")}>
              <AmountValue raw={fee.withheldAmount} decimals={info.decimals} />
            </InfoRow>
            <AuthorityLine label={t("extm.auth.transferFeeConfig")} holder={fee.transferFeeConfigAuthority} me={me} />
            <AuthorityLine label={t("extm.auth.withheldWithdraw")} holder={fee.withdrawWithheldAuthority} me={me} />
          </div>

          {/* set fee */}
          <div className="space-y-2 rounded border border-zinc-800/70 p-2">
            <div className="text-xs font-medium text-zinc-300">{t("extm.fee.set")}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <Label htmlFor="extm-fee-bps">{t("extm.fee.bps")}</Label>
                <Input id="extm-fee-bps" inputMode="numeric" value={feeBps} onChange={(e) => setFeeBps(e.target.value)} placeholder="50" />
              </div>
              <div>
                <Label htmlFor="extm-fee-max">{t("extm.fee.maxBase")}</Label>
                <Input id="extm-fee-max" inputMode="numeric" value={feeMax} onChange={(e) => setFeeMax(e.target.value)} placeholder="1000000" />
                <AmountHint value={feeMax} decimals={info.decimals} />
              </div>
            </div>
            <div className="text-xs text-amber-300">{t("extm.fee.nextEpoch")}</div>
            <Button
              variant="primary"
              disabled={disabled("fee") || !feeBps.trim() || !feeMax.trim()}
              onClick={() =>
                exec("fee", () =>
                  setTransferFee(
                    connection,
                    keypair!,
                    mint,
                    { transferFeeBasisPoints: Number(feeBps.trim()), maximumFee: feeMax.trim() },
                    opts,
                  ),
                )
              }
            >
              {busy === "fee" ? t("token.manage.working") : t("extm.fee.setBtn")}
            </Button>
            <ResultFor section="fee" />
          </div>

          {/* collect fees */}
          <div className="space-y-2 rounded border border-zinc-800/70 p-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium text-zinc-300">{t("extm.fee.collect")}</div>
              <Button variant="default" className="px-2 py-0.5 text-xs" disabled={scanning} onClick={scan}>
                {scanning ? t("extm.fee.scanning") : t("extm.fee.scan")}
              </Button>
            </div>
            <div className="text-xs text-zinc-500">{t("extm.fee.flow")}</div>
            {scanError && <ErrorBanner>{scanError}</ErrorBanner>}
            {withheld && withheld.length === 0 && <div className="text-xs text-zinc-500">{t("extm.fee.noneWithheld")}</div>}
            {withheld && withheld.length > 0 && (
              <ul className="max-h-64 divide-y divide-zinc-800/70 overflow-y-auto rounded border border-zinc-800/70">
                {withheld.map((a) => (
                  <li key={a.address} className="flex items-start gap-2 px-2 py-1.5">
                    <input className="mt-1" type="checkbox" checked={selected.has(a.address)} onChange={() => toggleSel(a.address)} />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <Address value={a.address} className="text-zinc-200" />
                      <div className="text-zinc-500">
                        {t("extm.fee.owner")}: <Address value={a.owner} className="text-zinc-400" />
                      </div>
                    </div>
                    <span className="shrink-0 font-mono text-zinc-200">
                      <AmountValue raw={a.withheldAmount} decimals={info.decimals} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <Label htmlFor="extm-withdraw-dest">{t("extm.fee.dest")}</Label>
              <Input
                id="extm-withdraw-dest"
                className="font-mono"
                value={withdrawDest}
                onChange={(e) => setWithdrawDest(e.target.value)}
                placeholder={t("extm.fee.destPlaceholder")}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="default"
                disabled={disabled("collect") || selected.size === 0}
                onClick={() =>
                  exec("collect", () =>
                    harvestWithheldToMint(connection, { payer: keypair!, mint, sources: [...selected] }, opts),
                  )
                }
              >
                {t("extm.fee.harvest", { n: selected.size })}
              </Button>
              <Button
                variant="default"
                disabled={disabled("collect") || selected.size === 0}
                onClick={() =>
                  exec("collect", () =>
                    withdrawWithheldFromAccounts(
                      connection,
                      { mint, authority: keypair!, sources: [...selected], destination: withdrawDest.trim() || undefined },
                      opts,
                    ),
                  )
                }
              >
                {t("extm.fee.withdrawAccounts", { n: selected.size })}
              </Button>
              <Button
                variant="primary"
                disabled={disabled("collect") || fee.withheldAmount === "0"}
                onClick={() =>
                  exec("collect", () =>
                    withdrawWithheldFromMint(
                      connection,
                      { mint, authority: keypair!, destination: withdrawDest.trim() || undefined },
                      opts,
                    ),
                  )
                }
              >
                {t("extm.fee.withdrawMint")}
              </Button>
            </div>
            {busy === "collect" && <div className="text-xs text-zinc-500">{t("token.manage.working")}</div>}
            <ResultFor section="collect" />
          </div>
        </Section>
      )}

      {/* ---------------- Pausable ---------------- */}
      {pausable && (
        <Section
          title="Pausable"
          badge={<Badge tone={pausable.paused ? "danger" : "success"}>{pausable.paused ? t("extm.pause.paused") : t("extm.pause.running")}</Badge>}
        >
          <AuthorityLine label={t("extm.auth.pausable")} holder={pausable.authority} me={me} />
          <div className="text-xs text-zinc-500">{t("extm.pause.desc")}</div>
          {pausable.paused ? (
            <Button
              variant="primary"
              disabled={disabled("pause")}
              onClick={() => exec("pause", () => resumeMint(connection, { mint, authority: keypair! }, opts))}
            >
              {busy === "pause" ? t("token.manage.working") : t("extm.pause.resume")}
            </Button>
          ) : (
            <Button
              variant="danger"
              disabled={disabled("pause")}
              onClick={() =>
                setConfirm({
                  title: t("extm.pause.confirmTitle"),
                  description: <div className="break-all">{t("extm.pause.confirmDesc", { mint })}</div>,
                  confirmLabel: t("extm.pause.pause"),
                  danger: true,
                  run: () => void exec("pause", () => pauseMint(connection, { mint, authority: keypair! }, opts)),
                })
              }
            >
              {busy === "pause" ? t("token.manage.working") : t("extm.pause.pause")}
            </Button>
          )}
          <ResultFor section="pause" />
        </Section>
      )}

      {/* ---------------- MintCloseAuthority ---------------- */}
      {closeAuth && (
        <Section title="MintCloseAuthority">
          <AuthorityLine label={t("extm.auth.closeMint")} holder={closeAuth.closeAuthority} me={me} />
          <InfoRow label={t("extm.close.supply")}>
            <AmountValue raw={info.supply} decimals={info.decimals} />
          </InfoRow>
          {info.supply !== "0" && <div className="text-xs text-amber-300">{t("extm.close.needZero")}</div>}
          <div>
            <Label htmlFor="extm-close-dest">{t("extm.close.dest")}</Label>
            <Input
              id="extm-close-dest"
              className="font-mono"
              value={closeDest}
              onChange={(e) => setCloseDest(e.target.value)}
              placeholder={t("extm.close.destPlaceholder")}
            />
          </div>
          <Button
            variant="danger"
            disabled={disabled("close") || info.supply !== "0" || !closeAuth.closeAuthority}
            onClick={() =>
              setConfirm({
                title: t("extm.close.confirmTitle"),
                description: (
                  <div className="space-y-1">
                    <div className="break-all">{t("extm.close.confirmDesc", { mint })}</div>
                    <div className="text-amber-300">{t("extm.close.confirmWarn")}</div>
                  </div>
                ),
                requireText: "CLOSE",
                confirmLabel: t("extm.close.btn"),
                danger: true,
                run: () =>
                  void exec("close", () =>
                    closeMint(
                      connection,
                      { mint, authority: keypair!, destination: closeDest.trim() || undefined, confirmClose: true },
                      opts,
                    ),
                  ),
              })
            }
          >
            {busy === "close" ? t("token.manage.working") : t("extm.close.btn")}
          </Button>
          <ResultFor section="close" />
        </Section>
      )}

      {/* ---------------- TransferHook ---------------- */}
      {hook && (
        <Section title="TransferHook">
          <InfoRow label={t("extm.hook.program")}>
            <KeyView value={hook.programId} />
          </InfoRow>
          <AuthorityLine label={t("extm.auth.transferHook")} holder={hook.authority} me={me} />
          <div>
            <Label htmlFor="extm-hook-program">{t("extm.hook.newProgram")}</Label>
            <Input
              id="extm-hook-program"
              className="font-mono"
              value={hookProgram}
              onChange={(e) => setHookProgram(e.target.value)}
              placeholder={t("extm.hook.placeholder")}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={disabled("hook") || !hookProgram.trim()}
              onClick={() =>
                exec("hook", () =>
                  updateTransferHookProgram(connection, { mint, authority: keypair!, programId: hookProgram.trim() }, opts),
                )
              }
            >
              {busy === "hook" ? t("token.manage.working") : t("extm.hook.update")}
            </Button>
            <Button
              variant="default"
              disabled={disabled("hook") || !hook.programId}
              onClick={() =>
                exec("hook", () => updateTransferHookProgram(connection, { mint, authority: keypair!, programId: null }, opts))
              }
            >
              {t("extm.hook.clear")}
            </Button>
          </div>
          <ResultFor section="hook" />
        </Section>
      )}

      {/* ---------------- ScaledUiAmount ---------------- */}
      {scaled && (
        <Section title="ScaledUiAmount">
          <InfoRow label={t("extm.scaled.current")}>
            {scaled.multiplier}
            {scaled.newMultiplier !== scaled.multiplier && (
              <>
                {" "}
                → {scaled.newMultiplier} @ {scaled.newMultiplierEffectiveTimestamp}
              </>
            )}
          </InfoRow>
          <AuthorityLine label={t("extm.auth.scaledUiAmount")} holder={scaled.authority} me={me} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <Label htmlFor="extm-scaled-mul">{t("extm.scaled.new")}</Label>
              <Input id="extm-scaled-mul" inputMode="decimal" value={scaledMul} onChange={(e) => setScaledMul(e.target.value)} placeholder="1.5" />
            </div>
            <div>
              <Label htmlFor="extm-scaled-ts">{t("extm.scaled.ts")}</Label>
              <Input id="extm-scaled-ts" inputMode="numeric" value={scaledTs} onChange={(e) => setScaledTs(e.target.value)} placeholder="0" />
            </div>
          </div>
          <div className="text-xs text-zinc-500">{t("ext.scaledHint")}</div>
          <Button
            variant="primary"
            disabled={disabled("scaled") || !scaledMul.trim()}
            onClick={() =>
              exec("scaled", () =>
                updateScaledUiMultiplier(
                  connection,
                  {
                    mint,
                    authority: keypair!,
                    multiplier: Number(scaledMul.trim()),
                    effectiveTimestamp: scaledTs.trim() ? BigInt(scaledTs.trim()) : 0n,
                  },
                  opts,
                ),
              )
            }
          >
            {busy === "scaled" ? t("token.manage.working") : t("extm.scaled.update")}
          </Button>
          <ResultFor section="scaled" />
        </Section>
      )}

      {/* ---------------- InterestBearing ---------------- */}
      {interest && (
        <Section title="InterestBearingConfig">
          <InfoRow label={t("extm.interest.current")}>
            {interest.currentRate} bps / {t("extm.interest.year")}
          </InfoRow>
          <AuthorityLine label={t("extm.auth.interestRate")} holder={interest.rateAuthority} me={me} />
          <div>
            <Label htmlFor="extm-rate">{t("extm.interest.new")}</Label>
            <Input id="extm-rate" inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="500" />
          </div>
          <Button
            variant="primary"
            disabled={disabled("interest") || !rate.trim()}
            onClick={() =>
              exec("interest", () =>
                updateInterestRate(connection, { mint, authority: keypair!, rate: Number(rate.trim()) }, opts),
              )
            }
          >
            {busy === "interest" ? t("token.manage.working") : t("extm.interest.update")}
          </Button>
          <ResultFor section="interest" />
        </Section>
      )}

      {/* ---------------- DefaultAccountState ---------------- */}
      {das && (
        <Section title="DefaultAccountState" badge={<Badge tone={das.state === "frozen" ? "warn" : "default"}>{das.state}</Badge>}>
          <AuthorityLine label={t("extm.das.freezeAuthority")} holder={info.freezeAuthority} me={me} />
          <div className="text-xs text-zinc-500">{t("extm.das.desc")}</div>
          <Button
            variant="primary"
            disabled={disabled("das")}
            onClick={() =>
              exec("das", () =>
                updateDefaultAccountState(
                  connection,
                  { mint, freezeAuthority: keypair!, state: das.state === "frozen" ? "initialized" : "frozen" },
                  opts,
                ),
              )
            }
          >
            {busy === "das"
              ? t("token.manage.working")
              : das.state === "frozen"
                ? t("extm.das.toInitialized")
                : t("extm.das.toFrozen")}
          </Button>
          <ResultFor section="das" />
        </Section>
      )}

      {/* ---------------- MemoTransfer (account level) ---------------- */}
      <Section
        title="MemoTransfer"
        badge={
          memoRequired === null ? undefined : (
            <Badge tone={memoRequired ? "warn" : "default"}>{memoRequired ? t("extm.memo.on") : t("extm.memo.off")}</Badge>
          )
        }
      >
        <div className="text-xs text-zinc-500">{t("extm.memo.desc")}</div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={disabled("memo") || memoRequired === true}
            onClick={() => exec("memo", () => enableMemoTransfer(connection, { owner: keypair!, mint }, opts))}
          >
            {t("extm.memo.enable")}
          </Button>
          <Button
            variant="default"
            disabled={disabled("memo") || memoRequired === false}
            onClick={() => exec("memo", () => disableMemoTransfer(connection, { owner: keypair!, mint }, opts))}
          >
            {t("extm.memo.disable")}
          </Button>
        </div>
        {busy === "memo" && <div className="text-xs text-zinc-500">{t("token.manage.working")}</div>}
        <ResultFor section="memo" />
      </Section>

      {/* ---------------- Extension authorities ---------------- */}
      {authorities.length > 0 && (
        <Section title={t("extm.auth.title")}>
          <div className="space-y-2">
            {authorities.map((a) => (
              <InfoRow key={a.kind} label={t(AUTHORITY_LABEL[a.kind])}>
                <KeyView value={a.holder} />
              </InfoRow>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <Label htmlFor="extm-auth-kind">{t("extm.auth.kind")}</Label>
              <select
                id="extm-auth-kind"
                className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100"
                value={authKind}
                onChange={(e) => setAuthKind(e.target.value as ExtensionAuthorityKind | "")}
              >
                <option value="">—</option>
                {authorities.map((a) => (
                  <option key={a.kind} value={a.kind} disabled={!a.holder}>
                    {t(AUTHORITY_LABEL[a.kind])}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="extm-auth-new">{t("token.manage.newAuthority")}</Label>
              <Input
                id="extm-auth-new"
                className="font-mono"
                value={authNew}
                disabled={authRevoke}
                onChange={(e) => setAuthNew(e.target.value)}
                placeholder={t("token.manage.newAuthorityPlaceholder")}
              />
            </div>
          </div>
          {authKind && authHolder && me && authHolder !== me && <div className="text-xs text-amber-300">{t("extm.notAuthority")}</div>}
          <label className="flex items-center gap-2 text-sm text-amber-300">
            <input type="checkbox" checked={authRevoke} onChange={(e) => setAuthRevoke(e.target.checked)} />
            {t("token.manage.revoke")}
          </label>
          <Button
            variant={authRevoke ? "danger" : "primary"}
            disabled={disabled("authority") || !authKind || (!authRevoke && !authNew.trim())}
            onClick={() => {
              const label = authKind ? t(AUTHORITY_LABEL[authKind]) : "";
              if (authRevoke) {
                setConfirm({
                  title: t("token.manage.revokeTitle", { kind: label }),
                  description: <div className="break-all">{t("extm.auth.revokeDesc", { kind: label, mint })}</div>,
                  requireText: "REVOKE",
                  confirmLabel: t("token.manage.revokeConfirm"),
                  danger: true,
                  run: () => void doAuthority(),
                });
              } else if (authNew.trim() !== me) {
                setConfirm({
                  title: t("token.manage.transferTitle", { kind: label }),
                  description: (
                    <div className="break-all">{t("extm.auth.transferDesc", { kind: label, mint, to: authNew.trim() })}</div>
                  ),
                  confirmLabel: t("token.manage.transferConfirm"),
                  danger: true,
                  run: () => void doAuthority(),
                });
              } else {
                void doAuthority();
              }
            }}
          >
            {busy === "authority" ? t("token.manage.working") : t("extm.auth.apply")}
          </Button>
          <ResultFor section="authority" />
        </Section>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          description={confirm.description}
          requireText={confirm.requireText}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={() => {
            const run = confirm.run;
            setConfirm(null);
            run();
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
