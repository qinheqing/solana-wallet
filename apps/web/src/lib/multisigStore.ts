/**
 * Locally saved multisigs ("My multisigs"), per cluster. Browser storage
 * only — a convenience list of addresses + labels; the chain is the source
 * of truth for members / threshold (cached here for the list view only).
 */
import { useCallback, useEffect, useState } from "react";

export interface SavedMultisig {
  /** Cluster key (cluster name, or "custom:<url>"). */
  cluster: string;
  address: string;
  vault: string;
  name: string;
  addedAt: number;
  /** Cached from the last on-chain load (display only). */
  threshold?: number;
  memberCount?: number;
}

const KEY = "solwallet.multisigs.v1";

function loadAll(): SavedMultisig[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as SavedMultisig[]) : [];
  } catch {
    return [];
  }
}

function saveAll(list: SavedMultisig[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // storage unavailable — the list simply won't persist
  }
}

export function clusterKey(cluster: string, customRpcUrl: string): string {
  return cluster === "custom" ? `custom:${customRpcUrl}` : cluster;
}

export function useSavedMultisigs(cluster: string) {
  const [all, setAll] = useState<SavedMultisig[]>(loadAll);

  // keep tabs in sync
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setAll(loadAll());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = useCallback((fn: (prev: SavedMultisig[]) => SavedMultisig[]) => {
    setAll((prev) => {
      const next = fn(prev);
      saveAll(next);
      return next;
    });
  }, []);

  const list = all.filter((m) => m.cluster === cluster).sort((a, b) => b.addedAt - a.addedAt);

  const upsert = useCallback(
    (entry: Omit<SavedMultisig, "cluster" | "addedAt"> & { addedAt?: number }) =>
      update((prev) => {
        const existing = prev.find((m) => m.cluster === cluster && m.address === entry.address);
        const merged: SavedMultisig = {
          ...existing,
          ...entry,
          cluster,
          addedAt: existing?.addedAt ?? entry.addedAt ?? Date.now(),
        };
        return [...prev.filter((m) => !(m.cluster === cluster && m.address === entry.address)), merged];
      }),
    [cluster, update],
  );

  const patch = useCallback(
    (address: string, fields: Partial<Pick<SavedMultisig, "name" | "threshold" | "memberCount" | "vault">>) =>
      update((prev) => prev.map((m) => (m.cluster === cluster && m.address === address ? { ...m, ...fields } : m))),
    [cluster, update],
  );

  const remove = useCallback(
    (address: string) => update((prev) => prev.filter((m) => !(m.cluster === cluster && m.address === address))),
    [cluster, update],
  );

  return { list, upsert, patch, remove };
}
