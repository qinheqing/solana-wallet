import { useState } from "react";
import {
  buildTransferInstructions,
  createMultisigProposal,
  PublicKey,
  type MultisigState,
  type TokenBalance,
} from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT } from "../../lib/i18n";
import { tokenLabel, type MintInfo } from "../../lib/tokenMeta";
import { Button, Input, Label } from "../../components/ui";
import { AmountHint, AmountValue, parseBaseUnits } from "../../components/Amount";
import { Modal } from "../../components/Modal";
import { SignerPicker, useMemberSigners } from "./shared";

/** Propose a transfer out of vault 0: SOL or any token the vault holds. */
export function NewProposalModal({
  msState,
  vaultSol,
  vaultTokens,
  mintMeta,
  onClose,
  onCreated,
}: {
  msState: MultisigState;
  vaultSol: number | null;
  vaultTokens: TokenBalance[];
  mintMeta: Map<string, MintInfo>;
  onClose: () => void;
  onCreated: (index: string) => void;
}) {
  const t = useT();
  const { connection, state } = useApp();
  const isMainnet = state.cluster === "mainnet-beta";
  const signers = useMemberSigners(msState.members);
  const unlocked = signers.filter((s) => s.keypair);
  const [proposerId, setProposerId] = useState("");
  const proposer = (unlocked.find((s) => s.wallet.id === proposerId) ?? unlocked[0])?.keypair ?? null;

  const [asset, setAsset] = useState("");
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [mainnetAck, setMainnetAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = vaultTokens.find((tk) => tk.mint === asset);
  const balance = asset ? (token ? BigInt(token.amount) : null) : vaultSol !== null ? BigInt(vaultSol) : null;

  const blockReason = ((): string | null => {
    if (!proposer) return signers.length === 0 ? t("msx.noLocalMember") : t("msx.allLocked");
    const dest = destination.trim();
    if (!dest) return t("ms.why.noDest");
    try {
      new PublicKey(dest);
    } catch {
      return t("ms.why.badDest");
    }
    const amt = amount.trim();
    if (!amt) return t("ms.why.noAmount");
    if (!/^\d+$/.test(amt) || BigInt(amt) <= 0n) return t("amount.invalid");
    if (balance !== null && BigInt(amt) > balance) return t("ms.why.overBalance", { balance: balance.toString() });
    if (isMainnet && !mainnetAck) return t("msx.why.mainnetAck");
    return null;
  })();

  const submit = async () => {
    if (!proposer || blockReason) return;
    setBusy(true);
    setError(null);
    try {
      const amt = parseBaseUnits(amount, t);
      const dest = new PublicKey(destination.trim());
      const multisigPda = new PublicKey(msState.multisigPda);
      const opts = { allowMainnet: isMainnet ? mainnetAck : undefined };
      let res;
      if (asset) {
        // Vault is payer + source owner; recipient ATA is created from vault funds when missing.
        const built = await buildTransferInstructions(connection, {
          payer: new PublicKey(msState.vault0Pda),
          destination: dest,
          mint: new PublicKey(asset),
          amount: amt,
          decimals: token?.decimals ?? mintMeta.get(asset)?.decimals,
        });
        res = await createMultisigProposal(connection, proposer, multisigPda, { instructions: built.instructions, ...opts });
      } else {
        res = await createMultisigProposal(connection, proposer, multisigPda, { destination: dest, amount: amt, ...opts });
      }
      if (res.error) {
        setError(`${res.error.code}: ${res.error.message}`);
        return;
      }
      onCreated(res.transactionIndex);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      size="md"
      onClose={onClose}
      header={
        <div>
          <div className="text-base font-semibold text-zinc-100">{t("ms.newProposal")}</div>
          <div className="mt-0.5 text-xs text-zinc-500">{t("ms.proposalHint")}</div>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="ms-prop-proposer">{t("msx.proposer")}</Label>
          <SignerPicker
            id="ms-prop-proposer"
            signers={signers}
            value={proposerId || unlocked[0]?.wallet.id || ""}
            onChange={setProposerId}
          />
        </div>

        <div>
          <Label htmlFor="ms-prop-asset">{t("ms.asset")}</Label>
          <select
            id="ms-prop-asset"
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100"
            value={asset}
            onChange={(e) => setAsset(e.target.value)}
          >
            <option value="">SOL</option>
            {vaultTokens.map((tk) => (
              <option key={tk.mint} value={tk.mint}>
                {(tokenLabel(mintMeta.get(tk.mint)) ?? t("token.manage.unnamed")) + " · " + tk.mint}
              </option>
            ))}
          </select>
          <div className="mt-1 text-xs text-zinc-500">
            {t("msx.vaultBalance")}{" "}
            {asset ? (
              token ? (
                <AmountValue raw={token.amount} decimals={token.decimals} />
              ) : (
                "—"
              )
            ) : (
              <AmountValue raw={vaultSol} decimals={9} symbol="SOL" />
            )}
          </div>
          {vaultTokens.length === 0 && <div className="mt-1 text-xs text-zinc-500">{t("ms.noVaultTokens")}</div>}
        </div>

        <div>
          <Label htmlFor="ms-prop-amount">{asset ? t("ms.amountToken") : t("ms.amount")}</Label>
          <Input
            id="ms-prop-amount"
            inputMode="numeric"
            placeholder={asset ? "1000000" : "1000000000"}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <AmountHint value={amount} decimals={asset ? (token?.decimals ?? null) : 9} sol={!asset} />
        </div>

        <div>
          <Label htmlFor="ms-prop-dest">{t("ms.propDestination")}</Label>
          <Input
            id="ms-prop-dest"
            className="font-mono"
            placeholder={t("ms.destinationPlaceholder")}
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          />
          {asset && <div className="mt-1 text-xs text-zinc-500">{t("ms.ataHint")}</div>}
        </div>

        {isMainnet && (
          <label className="flex items-center gap-2 text-sm text-amber-300">
            <input type="checkbox" checked={mainnetAck} onChange={(e) => setMainnetAck(e.target.checked)} />
            {t("common.mainnetAckSend")}
          </label>
        )}
        {error && <div className="text-sm text-red-400">{error}</div>}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={busy || blockReason !== null} onClick={submit}>
            {busy ? t("common.sending") : t("ms.propose")}
          </Button>
          {blockReason && <span className="text-xs text-amber-300">{blockReason}</span>}
        </div>
      </div>
    </Modal>
  );
}
