import { useCallback, useEffect, useRef, useState } from "react";
import {
  approveMultisigProposal,
  executeMultisigProposal,
  getMultisigState,
  getWalletBalance,
  listProposals,
  PublicKey,
  type MultisigProposalList,
  type MultisigProposalSummary,
  type MultisigState,
  type TokenBalance,
} from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT } from "../../lib/i18n";
import { fetchMintInfos, tokenLabel, type MintInfo } from "../../lib/tokenMeta";
import type { SavedMultisig } from "../../lib/multisigStore";
import { Badge, Button, ErrorBanner, Input } from "../../components/ui";
import { AmountValue } from "../../components/Amount";
import { Address } from "../../components/CopyButton";
import { Modal } from "../../components/Modal";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { NewProposalModal } from "./NewProposalModal";
import { InfoRow, ProposalActions, STATUS_TONE, UnlockButton, useMemberSigners, type MemberSigner } from "./shared";

type Tab = "proposals" | "vault" | "members";

export function MultisigDetailModal({
  saved,
  onClose,
  onRename,
  onRemove,
  onLoaded,
}: {
  saved: SavedMultisig;
  onClose: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onLoaded: (s: MultisigState) => void;
}) {
  const t = useT();
  const { connection, state } = useApp();
  const isMainnet = state.cluster === "mainnet-beta";
  const localNames = new Map(state.wallets.map((w) => [w.address, w.name]));

  const [tab, setTab] = useState<Tab>("proposals");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msState, setMsState] = useState<MultisigState | null>(null);
  const [proposals, setProposals] = useState<MultisigProposalList | null>(null);
  const [vaultSol, setVaultSol] = useState<number | null>(null);
  const [vaultTokens, setVaultTokens] = useState<TokenBalance[]>([]);
  const [mintMeta, setMintMeta] = useState<Map<string, MintInfo>>(new Map());
  const [newOpen, setNewOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(saved.name);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ index: string; error?: string; ok?: string } | null>(null);
  const [mainnetAck, setMainnetAck] = useState(false);

  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const pda = new PublicKey(saved.address);
      const [s, p] = await Promise.all([getMultisigState(connection, pda), listProposals(connection, pda)]);
      setMsState(s);
      setProposals(p);
      onLoadedRef.current(s);
      let tokens: TokenBalance[] = [];
      try {
        const bal = await getWalletBalance(connection, new PublicKey(s.vault0Pda));
        setVaultSol(bal.solLamports);
        tokens = bal.tokens;
        setVaultTokens(bal.tokens);
      } catch {
        setVaultSol(null);
        setVaultTokens([]);
      }
      const mints = new Set(tokens.map((tk) => tk.mint));
      for (const pr of p.proposals) for (const a of pr.actions ?? []) if (a.kind === "token" && a.mint) mints.add(a.mint);
      if (mints.size > 0) {
        const res = await fetchMintInfos(connection, [...mints]).catch(() => new Map());
        const next = new Map<string, MintInfo>();
        for (const [m, r] of res) if (r.ok) next.set(m, r.info);
        setMintMeta(next);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [connection, saved.address]);

  useEffect(() => {
    void load();
  }, [load]);

  const signers = useMemberSigners(msState?.members);
  const opts = { allowMainnet: isMainnet ? mainnetAck : undefined };

  const approveAs = async (p: MultisigProposalSummary, s: MemberSigner) => {
    if (!s.keypair) return;
    setBusy(`approve-${p.transactionIndex}-${s.wallet.id}`);
    setActionMsg(null);
    try {
      const res = await approveMultisigProposal(connection, s.keypair, new PublicKey(saved.address), BigInt(p.transactionIndex), opts);
      if (res.error) setActionMsg({ index: p.transactionIndex, error: `${res.error.code}: ${res.error.message}` });
      else setActionMsg({ index: p.transactionIndex, ok: t("msx.approvedAs", { name: s.wallet.name }) });
      await load();
    } catch (e) {
      setActionMsg({ index: p.transactionIndex, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const executeAs = async (p: MultisigProposalSummary, s: MemberSigner) => {
    if (!s.keypair) return;
    setBusy(`execute-${p.transactionIndex}`);
    setActionMsg(null);
    try {
      const res = await executeMultisigProposal(connection, s.keypair, new PublicKey(saved.address), BigInt(p.transactionIndex), opts);
      if (res.error) setActionMsg({ index: p.transactionIndex, error: `${res.error.code}: ${res.error.message}` });
      else setActionMsg({ index: p.transactionIndex, ok: t("msx.executed") });
      await load();
    } catch (e) {
      setActionMsg({ index: p.transactionIndex, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const threshold = msState?.threshold ?? saved.threshold ?? 0;
  const memberCount = msState?.members.length ?? saved.memberCount ?? 0;
  const pendingCount = proposals?.proposals.filter((p) => p.status === "active" || p.status === "approved").length ?? 0;

  const header = (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {renaming ? (
          <span className="inline-flex items-center gap-1.5">
            <Input
              autoFocus
              className="w-48 py-1"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && nameDraft.trim()) {
                  onRename(nameDraft.trim());
                  setRenaming(false);
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setRenaming(false);
                }
              }}
            />
            <Button
              variant="primary"
              className="px-2 py-1 text-xs"
              disabled={!nameDraft.trim()}
              onClick={() => {
                onRename(nameDraft.trim());
                setRenaming(false);
              }}
            >
              {t("common.save")}
            </Button>
          </span>
        ) : (
          <>
            <span className="text-base font-semibold text-zinc-100">{saved.name}</span>
            <button type="button" className="text-xs text-zinc-500 hover:text-zinc-200" onClick={() => setRenaming(true)}>
              {t("msx.rename")}
            </button>
          </>
        )}
        {threshold > 0 && <Badge tone="success">{t("ms.thresholdOf", { threshold, n: memberCount })}</Badge>}
      </div>
      <div className="text-xs text-zinc-500">
        {t("msx.multisigShort")} <Address value={saved.address} className="text-zinc-400" />
      </div>
    </div>
  );

  const tabs = (
    <div className="flex items-center gap-4 text-sm">
      {(["proposals", "vault", "members"] as const).map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => setTab(k)}
          className={`-mb-px border-b-2 py-2 ${
            tab === k ? "border-emerald-500 text-zinc-100" : "border-transparent text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {t(`msx.tab.${k}`)}
          {k === "proposals" && pendingCount > 0 && (
            <span className="ml-1.5 rounded-full bg-amber-900/60 px-1.5 text-xs text-amber-300">{pendingCount}</span>
          )}
        </button>
      ))}
      <span className="ml-auto">
        <Button variant="ghost" className="px-2 py-0.5 text-xs" disabled={loading} onClick={() => void load()}>
          {loading ? t("common.refreshing") : t("common.refresh")}
        </Button>
      </span>
    </div>
  );

  return (
    <Modal onClose={onClose} header={header} tabs={tabs}>
      <div className="space-y-4 text-xs leading-5">
        {loadError && <ErrorBanner>{loadError}</ErrorBanner>}
        {!msState && loading && <div className="text-zinc-500">{t("common.loading")}</div>}
        {isMainnet && (
          <label className="flex items-center gap-2 text-sm text-amber-300">
            <input type="checkbox" checked={mainnetAck} onChange={(e) => setMainnetAck(e.target.checked)} />
            {t("common.mainnetAckSend")}
          </label>
        )}

        {/* ---------------- proposals ---------------- */}
        {msState && tab === "proposals" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-zinc-500">{t("msx.proposalFlow", { threshold })}</div>
              <Button variant="primary" className="shrink-0" onClick={() => setNewOpen(true)}>
                + {t("msx.newProposalBtn")}
              </Button>
            </div>
            {proposals && proposals.proposals.length === 0 && (
              <div className="rounded-md border border-dashed border-zinc-800 px-3 py-6 text-center text-sm text-zinc-500">
                {t("ms.noProposals")}
              </div>
            )}
            <ul className="space-y-3">
              {[...(proposals?.proposals ?? [])].reverse().map((p) => {
                const open = p.status === "active" || p.status === "approved";
                const need = Math.max(threshold - p.approvedBy.length, 0);
                const executor = signers.find((s) => s.keypair);
                return (
                  <li key={p.transactionIndex} className="space-y-3 rounded-md border border-zinc-800 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-zinc-100">
                        {t("msx.proposalNo", { n: p.transactionIndex })}
                      </span>
                      <Badge tone={STATUS_TONE[p.status] ?? "default"}>{t(`ms.status.${p.status}`)}</Badge>
                    </div>

                    <ProposalActions actions={p.actions} vault={msState.vault0Pda} meta={mintMeta} localNames={localNames} />

                    {/* approvals progress */}
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
                          <div
                            className="h-full rounded-full bg-emerald-500"
                            style={{ width: `${threshold ? Math.min((p.approvedBy.length / threshold) * 100, 100) : 0}%` }}
                          />
                        </div>
                        <span className="shrink-0 text-zinc-400">
                          {t("ms.approvedBy", { n: p.approvedBy.length, threshold })}
                        </span>
                      </div>
                      {p.approvedBy.length > 0 && (
                        <div className="text-zinc-500">
                          {t("msx.approvers")}{" "}
                          {p.approvedBy.map((a) => localNames.get(a) ?? `${a.slice(0, 4)}…${a.slice(-4)}`).join("、")}
                        </div>
                      )}
                    </div>

                    {open && (
                      <div className="space-y-2 border-t border-zinc-800 pt-3">
                        {p.status === "active" && (
                          <>
                            <div className="text-amber-300">{t("msx.needMore", { n: need })}</div>
                            {signers.length === 0 ? (
                              <div className="text-zinc-500">{t("msx.noLocalMember")}</div>
                            ) : (
                              <div className="flex flex-wrap items-center gap-2">
                                {signers.map((s) => {
                                  const done = p.approvedBy.includes(s.wallet.address);
                                  if (done)
                                    return (
                                      <Badge key={s.wallet.id} tone="success">
                                        ✓ {s.wallet.name}
                                      </Badge>
                                    );
                                  if (!s.keypair) return <UnlockButton key={s.wallet.id} wallet={s.wallet} />;
                                  return (
                                    <Button
                                      key={s.wallet.id}
                                      variant="default"
                                      className="px-2.5 py-1 text-xs"
                                      disabled={busy !== null}
                                      onClick={() => approveAs(p, s)}
                                    >
                                      {busy === `approve-${p.transactionIndex}-${s.wallet.id}`
                                        ? t("common.sending")
                                        : t("msx.approveAs", { name: s.wallet.name })}
                                    </Button>
                                  );
                                })}
                              </div>
                            )}
                          </>
                        )}
                        {p.executeReady && (
                          <div className="flex flex-wrap items-center gap-2">
                            {executor ? (
                              <Button variant="primary" disabled={busy !== null} onClick={() => executeAs(p, executor)}>
                                {busy === `execute-${p.transactionIndex}`
                                  ? t("common.sending")
                                  : t("msx.executeAs", { name: executor.wallet.name })}
                              </Button>
                            ) : (
                              <>
                                <span className="text-amber-300">{t("msx.unlockToExecute")}</span>
                                {signers.map((s) => (
                                  <UnlockButton key={s.wallet.id} wallet={s.wallet} />
                                ))}
                              </>
                            )}
                            <span className="text-zinc-500">{t("msx.executeHint")}</span>
                          </div>
                        )}
                      </div>
                    )}
                    {actionMsg?.index === p.transactionIndex && (
                      <div className={actionMsg.error ? "text-red-400" : "text-emerald-400"}>{actionMsg.error ?? actionMsg.ok}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* ---------------- vault ---------------- */}
        {msState && tab === "vault" && (
          <div className="space-y-3">
            <div className="space-y-1 rounded-md border border-zinc-800 p-3">
              <div className="text-sm font-semibold text-zinc-200">{t("ms.vault")}</div>
              <Address value={msState.vault0Pda} className="text-sm text-zinc-200" />
              <div className="text-zinc-500">{t("ms.vaultHint")}</div>
            </div>
            <ul className="divide-y divide-zinc-800 overflow-hidden rounded-md border border-zinc-800">
              <li className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="text-sm font-semibold text-zinc-100">SOL</span>
                <AmountValue raw={vaultSol} decimals={9} symbol="SOL" />
              </li>
              {vaultTokens.map((tk) => (
                <li key={tk.mint} className="flex items-start justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-zinc-100">
                      {tokenLabel(mintMeta.get(tk.mint)) ?? t("token.manage.unnamed")}
                    </div>
                    <Address value={tk.mint} className="text-zinc-500" />
                  </div>
                  <span className="shrink-0">
                    <AmountValue raw={tk.amount} decimals={tk.decimals} />
                  </span>
                </li>
              ))}
            </ul>
            {vaultTokens.length === 0 && <div className="text-zinc-500">{t("ms.noVaultTokens")}</div>}
          </div>
        )}

        {/* ---------------- members ---------------- */}
        {msState && tab === "members" && (
          <div className="space-y-3">
            <div className="space-y-2">
              <InfoRow label={t("ms.threshold")}>
                {t("ms.thresholdOf", { threshold, n: memberCount })} · {t("ms.thresholdHint", { n: threshold })}
              </InfoRow>
              <InfoRow label={t("msx.multisigShort")}>
                <Address value={msState.multisigPda} />
              </InfoRow>
              <InfoRow label={t("ms.vault")}>
                <Address value={msState.vault0Pda} />
              </InfoRow>
            </div>
            <ul className="divide-y divide-zinc-800 overflow-hidden rounded-md border border-zinc-800">
              {msState.members.map((m, i) => {
                const local = state.wallets.find((w) => w.address === m);
                const unlocked = local ? !!state.unlocked[local.id] : false;
                return (
                  <li key={m} className="flex items-start gap-3 px-3 py-2.5">
                    <span className="w-5 shrink-0 text-right text-zinc-500">{i + 1}.</span>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={local ? "text-sm text-zinc-100" : "text-sm text-zinc-500"}>
                          {local ? local.name : t("ms.externalTag")}
                        </span>
                        {local && (
                          <Badge tone={unlocked ? "success" : "default"}>
                            {unlocked ? t("wallet.status.unlocked") : t("wallet.status.locked")}
                          </Badge>
                        )}
                      </div>
                      <Address value={m} className="text-zinc-400" />
                    </div>
                    {local && !unlocked && <UnlockButton wallet={local} label={t("wallet.unlock")} />}
                  </li>
                );
              })}
            </ul>
            <div className="flex justify-end">
              <Button variant="ghost" className="text-red-400" onClick={() => setConfirmRemove(true)}>
                {t("msx.removeFromList")}
              </Button>
            </div>
          </div>
        )}
      </div>

      {newOpen && msState && (
        <NewProposalModal
          msState={msState}
          vaultSol={vaultSol}
          vaultTokens={vaultTokens}
          mintMeta={mintMeta}
          onClose={() => setNewOpen(false)}
          onCreated={(index) => {
            setNewOpen(false);
            setTab("proposals");
            setActionMsg({ index, ok: t("msx.proposalCreated", { n: index }) });
            void load();
          }}
        />
      )}

      {confirmRemove && (
        <ConfirmDialog
          title={t("msx.removeTitle")}
          description={t("msx.removeDesc", { name: saved.name })}
          confirmLabel={t("msx.removeFromList")}
          onConfirm={() => {
            setConfirmRemove(false);
            onRemove();
          }}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </Modal>
  );
}
