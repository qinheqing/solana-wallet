import { useEffect, useState } from "react";
import {
  burnTokens,
  freezeTokenAccount,
  getWalletBalance,
  mintTokens,
  parseAmount,
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
import { Button, Card, Input, Label } from "../../components/ui";
import { ResultView } from "../transfer/ResultView";
import type { SimpleTxOutcome } from "../transfer/ResultView";
import { ConfirmDialog } from "../../components/ConfirmDialog";

type Action =
  | "mint"
  | "burn"
  | "freeze"
  | "thaw"
  | "setMintAuthority"
  | "setFreezeAuthority"
  | "updateMetadata";

const ACTION_LABEL: Record<Action, string> = {
  mint: "Mint",
  burn: "Burn",
  freeze: "Freeze account",
  thaw: "Thaw account",
  setMintAuthority: "Set mint authority",
  setFreezeAuthority: "Set freeze authority",
  updateMetadata: "Update metadata",
};

/** Normalize a core TokenManageResult (which may carry .error instead of throwing) into the UI outcome shape. */
function toOutcome(res: TokenManageResult): SimpleTxOutcome {
  if (res.error) return { error: res.error };
  return { signature: res.signature, slot: res.slot, feeLamports: res.feeLamports, simulatedOnly: res.simulatedOnly };
}

export function TokenManagePage() {
  const { connection, state, currentWallet } = useApp();
  const keypair = state.unlockedKeypair;
  const isMainnet = state.cluster === "mainnet-beta";

  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [action, setAction] = useState<Action>("mint");

  // mint/burn
  const [amount, setAmount] = useState("");
  // freeze/thaw
  const [accountOwner, setAccountOwner] = useState("");
  // authority rotation
  const [newAuthority, setNewAuthority] = useState("");
  const [revoke, setRevoke] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  // metadata
  const [metaField, setMetaField] = useState<"name" | "symbol" | "uri" | "custom">("name");
  const [metaCustomField, setMetaCustomField] = useState("");
  const [metaValue, setMetaValue] = useState("");

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SimpleTxOutcome | null>(null);
  const [mainnetAck, setMainnetAck] = useState(false);

  const activeToken = tokens.find((t) => t.mint === active) ?? null;
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
          const base = parseAmount(amount, activeToken.decimals);
          outcome = toOutcome(await mintTokens(connection, keypair, activeToken.mint, keypair.publicKey, base, opts));
          break;
        }
        case "burn": {
          const base = parseAmount(amount, activeToken.decimals);
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

  const run = () => {
    if ((action === "setMintAuthority" || action === "setFreezeAuthority") && revoke) {
      setConfirmingRevoke(true);
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
        <h3 className="text-sm font-semibold text-zinc-300">Your token assets</h3>
        <Button variant="ghost" onClick={refresh}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {!currentWallet && <div className="text-sm text-zinc-500">Select a wallet first.</div>}
      {currentWallet && tokens.length === 0 && !loading && (
        <div className="text-sm text-zinc-500">No token accounts found.</div>
      )}
      <ul className="space-y-1">
        {tokens.map((t) => (
          <li
            key={t.mint}
            className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 ${
              active === t.mint ? "border-emerald-700 bg-emerald-900/10" : "border-zinc-800"
            }`}
          >
            <div className="font-mono text-xs text-zinc-400">
              {t.mint} ({t.program}) — {t.uiAmount ?? 0}
            </div>
            <Button
              variant="default"
              onClick={() => {
                setActive(t.mint);
                setAction("mint");
                setResult(null);
              }}
            >
              Manage
            </Button>
          </li>
        ))}
      </ul>

      {active && activeToken && (
        <div className="space-y-3 rounded-md border border-zinc-800 p-3">
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
                {ACTION_LABEL[a]}
              </Button>
            ))}
          </div>

          {(action === "mint" || action === "burn") && (
            <div>
              <Label>Amount</Label>
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          )}

          {(action === "freeze" || action === "thaw") && (
            <div>
              <Label>Account owner (defaults to current wallet)</Label>
              <Input value={accountOwner} onChange={(e) => setAccountOwner(e.target.value)} />
            </div>
          )}

          {(action === "setMintAuthority" || action === "setFreezeAuthority") && (
            <div className="space-y-2">
              <div>
                <Label>New authority address</Label>
                <Input
                  value={newAuthority}
                  disabled={revoke}
                  onChange={(e) => setNewAuthority(e.target.value)}
                  placeholder="New authority public key"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-amber-300">
                <input type="checkbox" checked={revoke} onChange={(e) => setRevoke(e.target.checked)} />
                Permanently revoke this authority instead (irreversible)
              </label>
            </div>
          )}

          {action === "updateMetadata" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Field</Label>
                <select
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
                  <Label>Custom field key</Label>
                  <Input value={metaCustomField} onChange={(e) => setMetaCustomField(e.target.value)} />
                </div>
              )}
              <div className={metaField === "custom" ? "col-span-2" : ""}>
                <Label>New value</Label>
                <Input value={metaValue} onChange={(e) => setMetaValue(e.target.value)} />
              </div>
            </div>
          )}

          {isMainnet && (
            <label className="flex items-center gap-2 text-sm text-amber-300">
              <input type="checkbox" checked={mainnetAck} onChange={(e) => setMainnetAck(e.target.checked)} />
              I confirm this action on mainnet-beta.
            </label>
          )}

          <Button variant="primary" disabled={busy || !keypair} onClick={run}>
            {busy ? "Working…" : ACTION_LABEL[action]}
          </Button>

          <ResultView result={result} />
        </div>
      )}

      {confirmingRevoke && activeToken && (
        <ConfirmDialog
          title={`Revoke ${action === "setMintAuthority" ? "mint" : "freeze"} authority`}
          description={
            <div className="space-y-1">
              <div>
                This permanently renounces the {action === "setMintAuthority" ? "mint" : "freeze"} authority of{" "}
                <span className="font-mono text-xs">{activeToken.mint}</span>.
              </div>
              <div className="text-amber-300">
                After this, nobody will ever be able to{" "}
                {action === "setMintAuthority" ? "mint more of this token" : "freeze/thaw accounts of this token"}{" "}
                again. This cannot be undone.
              </div>
            </div>
          }
          requireText="REVOKE"
          confirmLabel="Revoke permanently"
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
