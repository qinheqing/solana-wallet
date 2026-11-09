import { useState } from "react";
import { createMultisig, PublicKey, type CreateMultisigResult } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT } from "../../lib/i18n";
import { Badge, Button, Input, Label, Textarea } from "../../components/ui";
import { Address } from "../../components/CopyButton";
import { Modal } from "../../components/Modal";
import { ResultView } from "../transfer/ResultView";
import { UnlockButton } from "./shared";

/**
 * Create a Squads V4 multisig: members from local wallets + external
 * addresses, threshold, optional local label. The fee payer / creator is any
 * unlocked local wallet (need not be a member).
 */
export function CreateMultisigModal({
  defaultName,
  onClose,
  onCreated,
}: {
  defaultName: string;
  onClose: () => void;
  onCreated: (r: { name: string; multisigPda: string; vaultPda: string; threshold: number; memberCount: number }) => void;
}) {
  const t = useT();
  const { connection, state, currentWallet } = useApp();
  const isMainnet = state.cluster === "mainnet-beta";
  const localWallets = state.wallets;
  const localNames = new Map(localWallets.map((w) => [w.address, w.name]));

  const [name, setName] = useState("");
  const [pickedLocal, setPickedLocal] = useState<Set<string>>(() => new Set(currentWallet ? [currentWallet.address] : []));
  const [membersText, setMembersText] = useState("");
  const [threshold, setThreshold] = useState("1");
  const unlockedWallets = localWallets.filter((w) => state.unlocked[w.id]);
  const [payerId, setPayerId] = useState<string>(
    () => (currentWallet && state.unlocked[currentWallet.id] ? currentWallet.id : unlockedWallets[0]?.id) ?? "",
  );
  // Fall back to any unlocked wallet (e.g. one unlocked from inside this modal).
  const effectivePayerId = state.unlocked[payerId] ? payerId : (unlockedWallets[0]?.id ?? "");
  const payer = state.unlocked[effectivePayerId] ?? null;
  const [mainnetAck, setMainnetAck] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateMultisigResult | null>(null);

  const externalLines = membersText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const invalidLines = externalLines.filter((l) => {
    try {
      new PublicKey(l);
      return false;
    } catch {
      return true;
    }
  });
  const members = [
    ...new Set([
      ...localWallets.map((w) => w.address).filter((a) => pickedLocal.has(a)),
      ...externalLines.filter((l) => !invalidLines.includes(l)),
    ]),
  ];
  const thresholdNum = Math.min(Math.max(Number(threshold) || 1, 1), Math.max(members.length, 1));

  const togglePicked = (addr: string) =>
    setPickedLocal((prev) => {
      const next = new Set(prev);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });
  const removeMember = (addr: string) => {
    if (pickedLocal.has(addr)) togglePicked(addr);
    setMembersText((txt) =>
      txt
        .split("\n")
        .filter((l) => l.trim() !== addr)
        .join("\n"),
    );
  };

  const blockReason = !payer
    ? t("msx.why.noPayer")
    : invalidLines.length > 0
      ? t("ms.invalidLines", { n: invalidLines.length })
      : members.length === 0
        ? t("ms.noMembers")
        : isMainnet && !mainnetAck
          ? t("msx.why.mainnetAck")
          : null;

  const create = async () => {
    if (!payer || blockReason) return;
    setError(null);
    setResult(null);
    setCreating(true);
    try {
      const res = await createMultisig(connection, payer, members.map((m) => new PublicKey(m)), thresholdNum, {
        allowMainnet: isMainnet ? mainnetAck : undefined,
      });
      setResult(res);
      if (!res.error && !res.simulatedOnly) {
        onCreated({
          name: name.trim() || defaultName,
          multisigPda: res.multisigPda,
          vaultPda: res.vaultPda,
          threshold: thresholdNum,
          memberCount: members.length,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal size="md" onClose={onClose} header={<div className="text-base font-semibold text-zinc-100">{t("ms.create")}</div>}>
      <div className="space-y-4">
        <div>
          <Label htmlFor="ms-create-name">{t("msx.name")}</Label>
          <Input id="ms-create-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName} />
          <div className="mt-1 text-xs text-zinc-500">{t("msx.nameHint")}</div>
        </div>

        <div>
          <Label>{t("ms.fromLocal")}</Label>
          {localWallets.length === 0 ? (
            <div className="text-xs text-zinc-500">{t("ms.noLocal")}</div>
          ) : (
            <ul className="divide-y divide-zinc-800 overflow-hidden rounded-md border border-zinc-800">
              {localWallets.map((w) => (
                <li key={w.id}>
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-zinc-800/40">
                    <input type="checkbox" className="mt-1" checked={pickedLocal.has(w.address)} onChange={() => togglePicked(w.address)} />
                    <div className="min-w-0 flex-1 text-sm leading-5">
                      <div className="flex items-center gap-2">
                        <span className="text-zinc-100">{w.name}</span>
                        {w.id === currentWallet?.id && <Badge tone="success">{t("ms.currentWallet")}</Badge>}
                      </div>
                      <Address value={w.address} copy={false} className="text-xs text-zinc-500" />
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <Label htmlFor="ms-create-external">{t("ms.external")}</Label>
          <Textarea
            id="ms-create-external"
            rows={3}
            className="font-mono"
            placeholder={t("ms.externalPlaceholder")}
            value={membersText}
            onChange={(e) => setMembersText(e.target.value)}
          />
          {invalidLines.length > 0 && (
            <div className="mt-1 text-xs text-red-400">
              <div>{t("ms.invalidLines", { n: invalidLines.length })}</div>
              <div className="break-all font-mono">{invalidLines.join(", ")}</div>
            </div>
          )}
        </div>

        <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="text-xs font-medium text-zinc-400">{t("ms.memberSummary", { n: members.length })}</div>
          {members.length === 0 ? (
            <div className="text-xs text-zinc-500">{t("ms.noMembers")}</div>
          ) : (
            <ol className="space-y-1.5 text-xs leading-5">
              {members.map((m, i) => (
                <li key={m} className="flex items-start gap-2">
                  <span className="w-5 shrink-0 text-right text-zinc-500">{i + 1}.</span>
                  <div className="min-w-0 flex-1">
                    <Address value={m} className="text-zinc-200" />
                    <span className={`ml-2 ${localNames.has(m) ? "text-zinc-500" : "text-zinc-600"}`}>
                      {localNames.get(m) ?? t("ms.externalTag")}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeMember(m)}
                    className="shrink-0 px-1 text-zinc-500 hover:text-red-400"
                    aria-label={t("ms.remove")}
                    title={t("ms.remove")}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1 text-sm">
            <label htmlFor="ms-create-threshold" className="text-xs font-medium text-zinc-400">
              {t("ms.threshold")}
            </label>
            <select
              id="ms-create-threshold"
              className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
              value={String(thresholdNum)}
              disabled={members.length === 0}
              onChange={(e) => setThreshold(e.target.value)}
            >
              {Array.from({ length: Math.max(members.length, 1) }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="text-zinc-400">/ {members.length}</span>
            <span className="text-xs text-zinc-500">{t("ms.thresholdHint", { n: thresholdNum })}</span>
          </div>
        </div>

        <div>
          <Label htmlFor="ms-create-payer">{t("msx.payer")}</Label>
          {unlockedWallets.length > 0 ? (
            <select
              id="ms-create-payer"
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100"
              value={effectivePayerId}
              onChange={(e) => setPayerId(e.target.value)}
            >
              {unlockedWallets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} · {w.address}
                </option>
              ))}
            </select>
          ) : (
            <div className="space-y-2">
              <div className="text-xs text-amber-300">{t("msx.why.noPayer")}</div>
              <div className="flex flex-wrap gap-2">
                {localWallets.map((w) => (
                  <UnlockButton key={w.id} wallet={w} />
                ))}
              </div>
            </div>
          )}
          <div className="mt-1 text-xs text-zinc-500">{t("msx.payerHint")}</div>
        </div>

        {isMainnet && (
          <label className="flex items-center gap-2 text-sm text-amber-300">
            <input type="checkbox" checked={mainnetAck} onChange={(e) => setMainnetAck(e.target.checked)} />
            {t("ms.mainnetAck")}
          </label>
        )}
        {error && <div className="text-sm text-red-400">{error}</div>}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={creating || blockReason !== null} onClick={create}>
            {creating ? t("ms.creating") : t("ms.createBtn")}
          </Button>
          {blockReason && <span className="text-xs text-amber-300">{blockReason}</span>}
        </div>
        {result && <ResultView result={result} />}
      </div>
    </Modal>
  );
}
