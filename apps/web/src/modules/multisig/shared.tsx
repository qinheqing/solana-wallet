import { useState, type ReactNode } from "react";
import type { Keypair } from "../../lib/coreShim";
import type { ProposalAction } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT } from "../../lib/i18n";
import type { StoredWalletRecord } from "../../lib/types";
import { tokenLabel, type MintInfo } from "../../lib/tokenMeta";
import { Address } from "../../components/CopyButton";
import { AmountValue } from "../../components/Amount";
import { Button } from "../../components/ui";

export const STATUS_TONE: Record<string, "default" | "success" | "warn" | "danger"> = {
  draft: "default",
  active: "warn",
  approved: "success",
  executing: "warn",
  executed: "success",
  rejected: "danger",
  cancelled: "danger",
};

export function InfoRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-baseline gap-x-4 sm:grid-cols-[7rem_1fr]">
      <div className="text-zinc-500">{label}</div>
      <div className="min-w-0 text-zinc-200">{children}</div>
    </div>
  );
}

export interface MemberSigner {
  wallet: StoredWalletRecord;
  /** Present when the wallet is unlocked in memory. */
  keypair: Keypair | null;
}

/** Local wallets that are members of the multisig, current wallet first. */
export function useMemberSigners(members: string[] | undefined): MemberSigner[] {
  const { state } = useApp();
  if (!members) return [];
  const set = new Set(members);
  return state.wallets
    .filter((w) => set.has(w.address))
    .map((w) => ({ wallet: w, keypair: state.unlocked[w.id] ?? null }))
    .sort((a, b) => Number(b.wallet.id === state.currentWalletId) - Number(a.wallet.id === state.currentWalletId));
}

/** Unlock a wallet in place (does NOT change the current wallet). Encrypted wallets ask for the password inline. */
export function UnlockButton({ wallet, label }: { wallet: StoredWalletRecord; label?: string }) {
  const t = useT();
  const { unlockWallet } = useApp();
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doUnlock = async (pw?: string) => {
    setBusy(true);
    setError(null);
    try {
      await unlockWallet(wallet.id, pw, { select: false });
      setAsking(false);
      setPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (asking) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <input
          type="password"
          autoFocus
          value={password}
          placeholder={t("wallet.passwordFor", { name: wallet.name })}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void doUnlock(password);
            if (e.key === "Escape") {
              e.stopPropagation();
              setAsking(false);
            }
          }}
          className="w-44 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 focus:border-emerald-600 focus:outline-none"
        />
        <Button variant="primary" className="px-2 py-1 text-xs" disabled={busy || !password} onClick={() => doUnlock(password)}>
          {t("wallet.unlock")}
        </Button>
        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setAsking(false)}>
          {t("common.cancel")}
        </Button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </span>
    );
  }
  return (
    <Button
      variant="default"
      className="px-2 py-1 text-xs"
      disabled={busy}
      onClick={() => (wallet.encrypted ? setAsking(true) : void doUnlock())}
    >
      {label ?? t("msx.unlockName", { name: wallet.name })}
    </Button>
  );
}

/** Pick one unlocked member wallet (select), or show unlock buttons for locked ones. */
export function SignerPicker({
  id,
  signers,
  value,
  onChange,
}: {
  id: string;
  signers: MemberSigner[];
  value: string;
  onChange: (walletId: string) => void;
}) {
  const t = useT();
  const unlocked = signers.filter((s) => s.keypair);
  const locked = signers.filter((s) => !s.keypair);
  if (signers.length === 0) return <div className="text-xs text-amber-300">{t("msx.noLocalMember")}</div>;
  return (
    <div className="space-y-2">
      {unlocked.length > 0 ? (
        <select
          id={id}
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {unlocked.map((s) => (
            <option key={s.wallet.id} value={s.wallet.id}>
              {s.wallet.name} · {s.wallet.address}
            </option>
          ))}
        </select>
      ) : (
        <div className="text-xs text-amber-300">{t("msx.allLocked")}</div>
      )}
      {locked.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span>{t("msx.lockedMembers")}</span>
          {locked.map((s) => (
            <UnlockButton key={s.wallet.id} wallet={s.wallet} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Readable list of what a proposal does when executed. */
export function ProposalActions({
  actions,
  vault,
  meta,
  localNames,
}: {
  actions: ProposalAction[] | null;
  vault: string;
  meta: Map<string, MintInfo>;
  localNames: Map<string, string>;
}) {
  const t = useT();
  if (!actions) return <div className="text-zinc-500">{t("ms.act.unknown")}</div>;
  const visible = actions.filter((a) => a.kind !== "createAta");
  const createsAta = actions.some((a) => a.kind === "createAta");
  return (
    <div className="space-y-1.5 rounded border border-zinc-800/70 bg-zinc-950/40 p-2">
      {visible.map((a, i) => {
        if (a.kind === "sol") {
          return (
            <div key={i} className="space-y-0.5">
              <div className="text-zinc-200">
                {t("ms.act.transfer")} <AmountValue raw={a.amount} decimals={9} symbol="SOL" />
                {a.from !== vault && <span className="ml-2 text-amber-300">{t("ms.act.notFromVault")}</span>}
              </div>
              <div className="text-zinc-500">
                → <Address value={a.to} className="text-zinc-300" />
                {localNames.has(a.to) && <span className="ml-2 text-emerald-400">{localNames.get(a.to)}</span>}
              </div>
            </div>
          );
        }
        if (a.kind === "token") {
          const m = a.mint ? meta.get(a.mint) : undefined;
          const decimals = a.decimals ?? m?.decimals ?? null;
          const to = a.destinationOwner ?? a.destinationAccount;
          const label = tokenLabel(m);
          return (
            <div key={i} className="space-y-0.5">
              <div className="text-zinc-200">
                {t("ms.act.transfer")} <AmountValue raw={a.amount} decimals={decimals} symbol={label ?? undefined} />
              </div>
              {a.mint && (
                <div className="text-zinc-500">
                  {label ? <span className="mr-1 font-semibold text-zinc-300">{label}</span> : null}
                  <Address value={a.mint} className="text-zinc-400" />
                </div>
              )}
              <div className="text-zinc-500">
                → <Address value={to} className="text-zinc-300" />
                {localNames.has(to) && <span className="ml-2 text-emerald-400">{localNames.get(to)}</span>}
                {!a.destinationOwner && <span className="ml-2">{t("ms.act.tokenAccount")}</span>}
              </div>
            </div>
          );
        }
        if (a.kind === "other") {
          return (
            <div key={i} className="text-zinc-400">
              {t("ms.act.other")} <Address value={a.programId} className="text-zinc-300" />
            </div>
          );
        }
        return null;
      })}
      {createsAta && <div className="text-zinc-500">{t("ms.act.createsAta")}</div>}
    </div>
  );
}
