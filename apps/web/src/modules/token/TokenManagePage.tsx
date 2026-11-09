import { useEffect, useState } from "react";
import {
  burnTokens,
  freezeTokenAccount,
  getWalletBalance,
  inspectMint,
  mintTokens,
  parseTransactionError,
  setFreezeAuthority,
  setMintAuthority,
  thawTokenAccount,
  updateTokenMetadata,
  PublicKey,
  type TokenBalance,
  type TokenManageResult,
} from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT, type TKey } from "../../lib/i18n";
import { Badge, Button, Card, Input, Label } from "../../components/ui";
import { AmountHint, AmountValue, parseBaseUnits } from "../../components/Amount";
import { ResultView } from "../transfer/ResultView";
import type { SimpleTxOutcome } from "../transfer/ResultView";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { MintInspectionPanel } from "./MintInspectionPanel";
import { ExtensionManagePanel } from "./ExtensionManagePanel";
import { Modal } from "../../components/Modal";
import { Address } from "../../components/CopyButton";
import { fetchMintInfos, type MintInfo } from "../../lib/tokenMeta";

type Action =
  | "mint"
  | "burn"
  | "freeze"
  | "thaw"
  | "setMintAuthority"
  | "setFreezeAuthority"
  | "updateMetadata";

const ACTION_LABEL: Record<Action, TKey> = {
  mint: "token.action.mint",
  burn: "token.action.burn",
  freeze: "token.action.freeze",
  thaw: "token.action.thaw",
  setMintAuthority: "token.action.setMintAuthority",
  setFreezeAuthority: "token.action.setFreezeAuthority",
  updateMetadata: "token.action.updateMetadata",
};

/** Normalize a core TokenManageResult (which may carry .error instead of throwing) into the UI outcome shape. */
function toOutcome(res: TokenManageResult): SimpleTxOutcome {
  if (res.error) return { error: res.error };
  return { signature: res.signature, slot: res.slot, feeLamports: res.feeLamports, simulatedOnly: res.simulatedOnly };
}

export function TokenManagePage() {
  const t = useT();
  const { connection, state, currentWallet } = useApp();
  const keypair = state.unlockedKeypair;
  const isMainnet = state.cluster === "mainnet-beta";

  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  /** mint → name/symbol (best-effort; missing = unnamed). */
  const [metas, setMetas] = useState<Map<string, MintInfo>>(new Map());
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [action, setAction] = useState<Action>("mint");
  const [detailTab, setDetailTab] = useState<"overview" | "basic" | "extensions">("overview");

  // mint/burn — raw base units
  const [amount, setAmount] = useState("");
  // freeze/thaw
  const [accountOwner, setAccountOwner] = useState("");
  // authority rotation
  const [newAuthority, setNewAuthority] = useState("");
  const [revoke, setRevoke] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [confirmingTransfer, setConfirmingTransfer] = useState(false);
  // metadata
  const [metaField, setMetaField] = useState<"name" | "symbol" | "uri" | "custom">("name");
  const [metaCustomField, setMetaCustomField] = useState("");
  const [metaValue, setMetaValue] = useState("");

  const [busy, setBusy] = useState(false);
  /** Bumped after every on-chain change so detail panels re-fetch. */
  const [refreshKey, setRefreshKey] = useState(0);
  const [result, setResult] = useState<SimpleTxOutcome | null>(null);
  const [mainnetAck, setMainnetAck] = useState(false);

  /** Mints opened by address that this wallet holds no account for (e.g. fresh mints with 0 supply). */
  const [extraTokens, setExtraTokens] = useState<TokenBalance[]>([]);
  const [manualMint, setManualMint] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualBusy, setManualBusy] = useState(false);

  const allTokens = [...tokens, ...extraTokens.filter((x) => !tokens.some((tk) => tk.mint === x.mint))];
  const activeToken = allTokens.find((tk) => tk.mint === active) ?? null;

  const openToken = (mint: string) => {
    setActive(mint);
    setAction("mint");
    setDetailTab("overview");
    setResult(null);
  };

  const label = (mint: string) => {
    const m = metas.get(mint);
    return { symbol: m?.symbol || m?.name || null, name: m?.name && m?.symbol && m.name !== m.symbol ? m.name : null };
  };

  const openManual = async () => {
    const addr = manualMint.trim();
    if (!addr) return;
    setManualError(null);
    setManualBusy(true);
    try {
      const info = await inspectMint(connection, addr);
      const entry: TokenBalance = {
        mint: info.address,
        tokenAccount: "",
        amount: "0",
        decimals: info.decimals,
        program: info.program,
      };
      setExtraTokens((prev) => [...prev.filter((x) => x.mint !== entry.mint), entry]);
      openToken(entry.mint);
      setManualMint("");
      fetchMintInfos(connection, [entry.mint])
        .then((res) => {
          const r = res.get(entry.mint);
          if (r?.ok) setMetas((prev) => new Map(prev).set(entry.mint, r.info));
        })
        .catch(() => undefined);
    } catch (e) {
      const pe = parseTransactionError(e);
      setManualError(`${pe.code}: ${pe.message}`);
    } finally {
      setManualBusy(false);
    }
  };
  const isToken2022 = activeToken?.program === "token-2022";

  const refresh = () => {
    if (!currentWallet) return;
    setLoading(true);
    getWalletBalance(connection, new PublicKey(currentWallet.address))
      .then(async (b) => {
        setTokens(b.tokens);
        try {
          const res = await fetchMintInfos(connection, b.tokens.map((tk) => tk.mint));
          const next = new Map<string, MintInfo>();
          for (const [mint, r] of res) if (r.ok) next.set(mint, r.info);
          setMetas(next);
        } catch {
          setMetas(new Map());
        }
      })
      .catch(() => setTokens([]))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, [connection, currentWallet]);

  useEffect(() => {
    // reset action-specific inputs when switching the managed mint
    setAccountOwner(currentWallet?.address ?? "");
    setNewAuthority("");
    setRevoke(false);
    setMetaValue("");
    setResult(null);
  }, [active, currentWallet]);

  const opts = { allowMainnet: isMainnet ? mainnetAck : undefined };

  const execute = async () => {
    if (!keypair || !active || !activeToken) return;
    setBusy(true);
    setResult(null);
    try {
      let outcome: SimpleTxOutcome;
      switch (action) {
        case "mint": {
          const base = parseBaseUnits(amount, t);
          outcome = toOutcome(await mintTokens(connection, keypair, activeToken.mint, keypair.publicKey, base, opts));
          break;
        }
        case "burn": {
          const base = parseBaseUnits(amount, t);
          outcome = toOutcome(await burnTokens(connection, keypair, activeToken.mint, base, opts));
          break;
        }
        case "freeze":
          outcome = toOutcome(await freezeTokenAccount(connection, keypair, activeToken.mint, accountOwner, opts));
          break;
        case "thaw":
          outcome = toOutcome(await thawTokenAccount(connection, keypair, activeToken.mint, accountOwner, opts));
          break;
        case "setMintAuthority":
          outcome = toOutcome(
            await setMintAuthority(connection, keypair, activeToken.mint, revoke ? null : newAuthority, {
              ...opts,
              confirmRevoke: revoke,
            }),
          );
          break;
        case "setFreezeAuthority":
          outcome = toOutcome(
            await setFreezeAuthority(connection, keypair, activeToken.mint, revoke ? null : newAuthority, {
              ...opts,
              confirmRevoke: revoke,
            }),
          );
          break;
        case "updateMetadata":
          outcome = toOutcome(
            await updateTokenMetadata(
              connection,
              keypair,
              activeToken.mint,
              { field: metaField === "custom" ? metaCustomField : metaField, value: metaValue },
              opts,
            ),
          );
          break;
      }
      setResult(outcome);
      refresh();
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setResult({ error: parseTransactionError(e) });
    } finally {
      setBusy(false);
    }
  };

  const isAuthorityAction = action === "setMintAuthority" || action === "setFreezeAuthority";
  const authorityKind = action === "setMintAuthority" ? t("token.manage.kind.mint") : t("token.manage.kind.freeze");
  // Handing the authority to any address other than the current wallet is a loss of control for this wallet.
  const transfersAway =
    isAuthorityAction && !revoke && newAuthority.trim().length > 0 && newAuthority.trim() !== currentWallet?.address;

  const run = () => {
    if (isAuthorityAction && revoke) {
      setConfirmingRevoke(true);
      return;
    }
    if (transfersAway) {
      setConfirmingTransfer(true);
      return;
    }
    void execute();
  };

  const availableActions: Action[] = isToken2022
    ? ["mint", "burn", "freeze", "thaw", "setMintAuthority", "setFreezeAuthority", "updateMetadata"]
    : ["mint", "burn"];

  const activeLabel = activeToken ? label(activeToken.mint) : null;

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-300">{t("token.manage.assets")}</h3>
        <Button variant="ghost" onClick={refresh}>
          {loading ? t("common.refreshing") : t("common.refresh")}
        </Button>
      </div>
      <div className="flex gap-2">
        <Input
          aria-label={t("token.manage.byAddress")}
          className="font-mono"
          value={manualMint}
          onChange={(e) => setManualMint(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void openManual();
          }}
          placeholder={t("token.manage.byAddressPlaceholder")}
        />
        <Button variant="default" className="shrink-0 whitespace-nowrap" disabled={manualBusy || !manualMint.trim()} onClick={openManual}>
          {t("token.manage.open")}
        </Button>
      </div>
      {manualError && <div className="text-xs text-red-400">{manualError}</div>}

      {!currentWallet && <div className="text-sm text-zinc-500">{t("token.manage.selectWallet")}</div>}
      {currentWallet && allTokens.length === 0 && !loading && (
        <div className="rounded-md border border-dashed border-zinc-800 px-3 py-6 text-center text-sm text-zinc-500">
          {t("token.manage.noAccounts")}
        </div>
      )}

      {allTokens.length > 0 && (
        <ul className="divide-y divide-zinc-800 overflow-hidden rounded-md border border-zinc-800">
          {allTokens.map((tk) => {
            const lb = label(tk.mint);
            return (
              <li key={tk.mint}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => openToken(tk.mint)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") openToken(tk.mint);
                  }}
                  className="flex cursor-pointer items-center gap-3 px-3 py-3 hover:bg-zinc-800/50 focus:bg-zinc-800/50 focus:outline-none"
                >
                  <TokenAvatar text={lb.symbol} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`truncate text-sm font-semibold ${lb.symbol ? "text-zinc-100" : "text-zinc-500"}`}>
                        {lb.symbol ?? t("token.manage.unnamed")}
                      </span>
                      {lb.name && <span className="truncate text-xs text-zinc-400">{lb.name}</span>}
                      <ProgramBadge program={tk.program} />
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      <Address value={tk.mint} />
                    </div>
                  </div>
                  <div className="shrink-0 text-right font-mono text-sm text-zinc-200">
                    {tk.tokenAccount ? (
                      <AmountValue raw={tk.amount} decimals={tk.decimals} />
                    ) : (
                      <span className="font-sans text-xs text-zinc-500">{t("token.manage.notHeld")}</span>
                    )}
                  </div>
                  <span className="shrink-0 text-zinc-500">›</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {active && activeToken && (
        <Modal
          onClose={() => setActive(null)}
          header={
            <div className="flex items-center gap-3">
              <TokenAvatar text={activeLabel?.symbol ?? null} large />
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold text-zinc-100">
                    {activeLabel?.symbol ?? t("token.manage.unnamed")}
                  </span>
                  {activeLabel?.name && <span className="text-sm text-zinc-400">{activeLabel.name}</span>}
                  <ProgramBadge program={activeToken.program} />
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  <Address value={activeToken.mint} />
                </div>
                <div className="text-xs text-zinc-400">
                  {t("token.manage.balance")}:{" "}
                  {activeToken.tokenAccount ? (
                    <AmountValue raw={activeToken.amount} decimals={activeToken.decimals} />
                  ) : (
                    <span className="text-zinc-500">{t("token.manage.notHeld")}</span>
                  )}
                </div>
              </div>
            </div>
          }
          tabs={
            <div className="flex gap-4 text-sm">
              {(["overview", "basic", ...(isToken2022 ? (["extensions"] as const) : [])] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setDetailTab(k)}
                  className={`-mb-px border-b-2 py-2 ${
                    detailTab === k ? "border-emerald-500 text-zinc-100" : "border-transparent text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {t(`token.manage.tab.${k}`)}
                </button>
              ))}
            </div>
          }
        >
          {detailTab === "overview" && <MintInspectionPanel mint={activeToken.mint} refreshKey={refreshKey} />}

          {detailTab === "basic" && (
            <div className="space-y-3">
              {!keypair && <div className="text-xs text-amber-300">{t("common.selectUnlockFirst")}</div>}
          <div className="flex flex-wrap gap-2">
            {availableActions.map((a) => (
              <Button
                key={a}
                variant={action === a ? "primary" : "default"}
                onClick={() => {
                  setAction(a);
                  setResult(null);
                }}
              >
                {t(ACTION_LABEL[a])}
              </Button>
            ))}
          </div>

          {(action === "mint" || action === "burn") && (
            <div>
              <Label htmlFor="tokenmanagepage-amount">{t("token.manage.amount")}</Label>
              <Input id="tokenmanagepage-amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <AmountHint value={amount} decimals={activeToken.decimals} />
            </div>
          )}

          {(action === "freeze" || action === "thaw") && (
            <div>
              <Label htmlFor="tokenmanagepage-account-owner">{t("token.manage.accountOwner")}</Label>
              <Input className="font-mono" id="tokenmanagepage-account-owner" value={accountOwner} onChange={(e) => setAccountOwner(e.target.value)} />
            </div>
          )}

          {(action === "setMintAuthority" || action === "setFreezeAuthority") && (
            <div className="space-y-2">
              <div>
                <Label htmlFor="tokenmanagepage-new-authority-address">{t("token.manage.newAuthority")}</Label>
                <Input className="font-mono"
                  id="tokenmanagepage-new-authority-address"
                  value={newAuthority}
                  disabled={revoke}
                  onChange={(e) => setNewAuthority(e.target.value)}
                  placeholder={t("token.manage.newAuthorityPlaceholder")}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-amber-300">
                <input type="checkbox" checked={revoke} onChange={(e) => setRevoke(e.target.checked)} />
                {t("token.manage.revoke")}
              </label>
            </div>
          )}

          {action === "updateMetadata" && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="tokenmanagepage-field">{t("token.manage.field")}</Label>
                <select
                  id="tokenmanagepage-field"
                  className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100"
                  value={metaField}
                  onChange={(e) => setMetaField(e.target.value as typeof metaField)}
                >
                  <option value="name">name</option>
                  <option value="symbol">symbol</option>
                  <option value="uri">uri</option>
                  <option value="custom">custom</option>
                </select>
              </div>
              {metaField === "custom" && (
                <div>
                  <Label htmlFor="tokenmanagepage-custom-field-key">{t("token.manage.customKey")}</Label>
                  <Input id="tokenmanagepage-custom-field-key" value={metaCustomField} onChange={(e) => setMetaCustomField(e.target.value)} />
                </div>
              )}
              <div className={metaField === "custom" ? "sm:col-span-2" : ""}>
                <Label htmlFor="tokenmanagepage-new-value">{t("token.manage.newValue")}</Label>
                <Input id="tokenmanagepage-new-value" value={metaValue} onChange={(e) => setMetaValue(e.target.value)} />
              </div>
            </div>
          )}

          {isMainnet && (
            <label className="flex items-center gap-2 text-sm text-amber-300">
              <input type="checkbox" checked={mainnetAck} onChange={(e) => setMainnetAck(e.target.checked)} />
              {t("token.manage.mainnetAck")}
            </label>
          )}

          <Button variant="primary" disabled={busy || !keypair} onClick={run}>
            {busy ? t("token.manage.working") : t(ACTION_LABEL[action])}
          </Button>

          <ResultView result={result} />
            </div>
          )}

          {detailTab === "extensions" && isToken2022 && (
            <ExtensionManagePanel
              mint={activeToken.mint}
              tokenAccount={activeToken.tokenAccount || null}
              refreshKey={refreshKey}
              onChanged={() => {
                refresh();
                setRefreshKey((k) => k + 1);
              }}
            />
          )}
        </Modal>
      )}

      {confirmingTransfer && activeToken && (
        <ConfirmDialog
          title={t("token.manage.transferTitle", { kind: authorityKind })}
          description={
            <div className="space-y-1">
              <div className="break-all">
                {t("token.manage.transferDesc", { kind: authorityKind, mint: activeToken.mint, to: newAuthority.trim() })}
              </div>
              <div className="text-amber-300">
                {t("token.manage.transferWarn", {
                  ability: action === "setMintAuthority" ? t("token.manage.ability.mint") : t("token.manage.ability.freeze"),
                })}
              </div>
            </div>
          }
          confirmLabel={t("token.manage.transferConfirm")}
          danger
          onConfirm={() => {
            setConfirmingTransfer(false);
            void execute();
          }}
          onCancel={() => setConfirmingTransfer(false)}
        />
      )}

      {confirmingRevoke && activeToken && (
        <ConfirmDialog
          title={t("token.manage.revokeTitle", { kind: authorityKind })}
          description={
            <div className="space-y-1">
              <div className="break-all">{t("token.manage.revokeDesc", { kind: authorityKind, mint: activeToken.mint })}</div>
              <div className="text-amber-300">
                {t("token.manage.revokeWarn", {
                  ability: action === "setMintAuthority" ? t("token.manage.ability.mintMore") : t("token.manage.ability.freeze"),
                })}
              </div>
            </div>
          }
          requireText="REVOKE"
          confirmLabel={t("token.manage.revokeConfirm")}
          danger
          onConfirm={() => {
            setConfirmingRevoke(false);
            void execute();
          }}
          onCancel={() => setConfirmingRevoke(false)}
        />
      )}
    </Card>
  );
}

function TokenAvatar({ text, large = false }: { text: string | null; large?: boolean }) {
  const letters = (text ?? "?").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "?";
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full bg-emerald-900/40 font-semibold text-emerald-300 ring-1 ring-emerald-800 ${
        large ? "h-11 w-11 text-sm" : "h-9 w-9 text-xs"
      }`}
    >
      {letters}
    </div>
  );
}

function ProgramBadge({ program }: { program: string }) {
  return <Badge tone={program === "token-2022" ? "success" : "default"}>{program === "token-2022" ? "Token-2022" : "SPL"}</Badge>;
}
