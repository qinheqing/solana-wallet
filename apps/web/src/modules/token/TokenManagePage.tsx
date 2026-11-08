import { useEffect, useState } from "react";
import {
  burnTokens,
  freezeTokenAccount,
  getWalletBalance,
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
import { Button, Card, Input, Label } from "../../components/ui";
import { AmountHint, AmountValue, parseBaseUnits } from "../../components/Amount";
import { ResultView } from "../transfer/ResultView";
import type { SimpleTxOutcome } from "../transfer/ResultView";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { MintInspectionPanel } from "./MintInspectionPanel";

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
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [action, setAction] = useState<Action>("mint");

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
  const [result, setResult] = useState<SimpleTxOutcome | null>(null);
  const [mainnetAck, setMainnetAck] = useState(false);

  const activeToken = tokens.find((tk) => tk.mint === active) ?? null;
  const isToken2022 = activeToken?.program === "token-2022";

  const refresh = () => {
    if (!currentWallet) return;
    setLoading(true);
    getWalletBalance(connection, new PublicKey(currentWallet.address))
      .then((b) => setTokens(b.tokens))
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

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-300">{t("token.manage.assets")}</h3>
        <Button variant="ghost" onClick={refresh}>
          {loading ? t("common.refreshing") : t("common.refresh")}
        </Button>
      </div>
      {!currentWallet && <div className="text-sm text-zinc-500">{t("token.manage.selectWallet")}</div>}
      {currentWallet && tokens.length === 0 && !loading && (
        <div className="text-sm text-zinc-500">{t("token.manage.noAccounts")}</div>
      )}
      <ul className="space-y-1">
        {tokens.map((tk) => (
          <li
            key={tk.mint}
            className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 ${
              active === tk.mint ? "border-emerald-700 bg-emerald-900/10" : "border-zinc-800"
            }`}
          >
            <div className="min-w-0 break-all font-mono text-xs text-zinc-400">
              {tk.mint} ({tk.program}) — <AmountValue raw={tk.amount} decimals={tk.decimals} />
            </div>
            <Button
              variant="default"
              onClick={() => {
                setActive(tk.mint);
                setAction("mint");
                setResult(null);
              }}
            >
              {t("token.manage.manage")}
            </Button>
          </li>
        ))}
      </ul>

      {active && activeToken && (
        <div className="space-y-3 rounded-md border border-zinc-800 p-3">
          <MintInspectionPanel mint={activeToken.mint} />
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
              <Input id="tokenmanagepage-account-owner" value={accountOwner} onChange={(e) => setAccountOwner(e.target.value)} />
            </div>
          )}

          {(action === "setMintAuthority" || action === "setFreezeAuthority") && (
            <div className="space-y-2">
              <div>
                <Label htmlFor="tokenmanagepage-new-authority-address">{t("token.manage.newAuthority")}</Label>
                <Input
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
