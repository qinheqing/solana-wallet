import { useState } from "react";
import { getMultisigState, PublicKey } from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { useT } from "../../lib/i18n";
import { clusterKey, useSavedMultisigs } from "../../lib/multisigStore";
import { Badge, Button, Card, Input, Label, RiskBanner } from "../../components/ui";
import { Address } from "../../components/CopyButton";
import { Modal } from "../../components/Modal";
import { CreateMultisigModal } from "./CreateMultisigModal";
import { MultisigDetailModal } from "./MultisigDetailModal";

/**
 * Multisig home: the locally saved "My multisigs" list for the current
 * cluster, plus modals to create / import one and a detail modal per
 * multisig (proposals, vault, members).
 */
export function MultisigPage() {
  const t = useT();
  const { state } = useApp();
  const cKey = clusterKey(state.cluster, state.customRpcUrl);
  const { list, upsert, patch, remove } = useSavedMultisigs(cKey);

  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [openAddress, setOpenAddress] = useState<string | null>(null);
  const opened = list.find((m) => m.address === openAddress) ?? null;
  const nextName = t("msx.defaultName", { n: list.length + 1 });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("ms.title")}</h2>
        <div className="flex gap-2">
          <Button variant="default" onClick={() => setImportOpen(true)}>
            {t("msx.import")}
          </Button>
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            + {t("ms.create")}
          </Button>
        </div>
      </div>
      <RiskBanner>{t("ms.banner")}</RiskBanner>

      <Card className="space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-zinc-300">{t("msx.mine", { n: list.length })}</h3>
          <span className="text-xs text-zinc-500">{t("msx.savedOn", { cluster: state.cluster })}</span>
        </div>

        {list.length === 0 ? (
          <div className="space-y-3 rounded-md border border-dashed border-zinc-800 px-4 py-8 text-center">
            <div className="text-sm text-zinc-400">{t("msx.empty")}</div>
            <div className="flex justify-center gap-2">
              <Button variant="default" onClick={() => setImportOpen(true)}>
                {t("msx.import")}
              </Button>
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                + {t("ms.create")}
              </Button>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800 overflow-hidden rounded-md border border-zinc-800">
            {list.map((m) => (
              <li key={m.address}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setOpenAddress(m.address)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setOpenAddress(m.address);
                  }}
                  className="flex cursor-pointer items-center gap-3 px-3 py-3 hover:bg-zinc-800/50 focus:bg-zinc-800/50 focus:outline-none"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-900/40 text-xs font-semibold text-sky-300 ring-1 ring-sky-800">
                    MS
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5 text-xs leading-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-zinc-100">{m.name}</span>
                      {m.threshold !== undefined && m.memberCount !== undefined && (
                        <Badge tone="success">{t("ms.thresholdOf", { threshold: m.threshold, n: m.memberCount })}</Badge>
                      )}
                    </div>
                    <div className="text-zinc-500" onClick={(e) => e.stopPropagation()}>
                      {t("msx.vaultShort")} <Address value={m.vault} className="text-zinc-400" />
                    </div>
                    <div className="text-zinc-600" onClick={(e) => e.stopPropagation()}>
                      {t("msx.multisigShort")} <Address value={m.address} className="text-zinc-500" />
                    </div>
                  </div>
                  <span className="shrink-0 text-zinc-500">›</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {createOpen && (
        <CreateMultisigModal
          defaultName={nextName}
          onClose={() => setCreateOpen(false)}
          onCreated={(r) => {
            upsert({ address: r.multisigPda, vault: r.vaultPda, name: r.name, threshold: r.threshold, memberCount: r.memberCount });
            setCreateOpen(false);
            setOpenAddress(r.multisigPda);
          }}
        />
      )}

      {importOpen && (
        <ImportMultisigModal
          defaultName={nextName}
          onClose={() => setImportOpen(false)}
          onImported={(r) => {
            upsert(r);
            setImportOpen(false);
            setOpenAddress(r.address);
          }}
        />
      )}

      {opened && (
        <MultisigDetailModal
          key={opened.address}
          saved={opened}
          onClose={() => setOpenAddress(null)}
          onRename={(name) => patch(opened.address, { name })}
          onRemove={() => {
            remove(opened.address);
            setOpenAddress(null);
          }}
          onLoaded={(s) => {
            if (s.threshold !== opened.threshold || s.members.length !== opened.memberCount || s.vault0Pda !== opened.vault) {
              patch(opened.address, { threshold: s.threshold, memberCount: s.members.length, vault: s.vault0Pda });
            }
          }}
        />
      )}
    </div>
  );
}

/** Add an existing multisig to the local list by its multisig (config) address. */
function ImportMultisigModal({
  defaultName,
  onClose,
  onImported,
}: {
  defaultName: string;
  onClose: () => void;
  onImported: (r: { address: string; vault: string; name: string; threshold: number; memberCount: number }) => void;
}) {
  const t = useT();
  const { connection } = useApp();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    let pda: PublicKey;
    try {
      pda = new PublicKey(address.trim());
    } catch {
      setError(t("ms.why.badDest"));
      return;
    }
    setBusy(true);
    try {
      const s = await getMultisigState(connection, pda);
      onImported({
        address: s.multisigPda,
        vault: s.vault0Pda,
        name: name.trim() || defaultName,
        threshold: s.threshold,
        memberCount: s.members.length,
      });
    } catch (e) {
      setError(`${e instanceof Error ? e.message : String(e)} ${t("msx.importHint")}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal size="md" onClose={onClose} header={<div className="text-base font-semibold text-zinc-100">{t("msx.import")}</div>}>
      <div className="space-y-4">
        <div>
          <Label htmlFor="ms-import-address">{t("msx.multisigAddrLabel")}</Label>
          <Input
            id="ms-import-address"
            className="font-mono"
            autoFocus
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder={t("ms.pdaPlaceholder")}
          />
          <div className="mt-1 text-xs text-zinc-500">{t("msx.importAddrHint")}</div>
        </div>
        <div>
          <Label htmlFor="ms-import-name">{t("msx.name")}</Label>
          <Input id="ms-import-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName} />
        </div>
        {error && <div className="text-sm text-red-400">{error}</div>}
        <Button variant="primary" disabled={busy || !address.trim()} onClick={submit}>
          {busy ? t("ms.loading") : t("msx.importBtn")}
        </Button>
      </div>
    </Modal>
  );
}
