import type { AppSettings, StoredWalletRecord } from "./types";

const WALLETS_KEY = "solwallet.wallets.v1";
const SETTINGS_KEY = "solwallet.settings.v1";

export function loadWallets(): StoredWalletRecord[] {
  try {
    const raw = localStorage.getItem(WALLETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredWalletRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveWallets(wallets: StoredWalletRecord[]): void {
  localStorage.setItem(WALLETS_KEY, JSON.stringify(wallets));
}

const DEFAULT_SETTINGS: AppSettings = {
  cluster: "devnet",
  customRpcUrl: "",
  currentWalletId: null,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function genId(): string {
  // crypto.randomUUID is secure-context-only (https / localhost); on a plain
  // http LAN address it's undefined. getRandomValues works everywhere.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40; // version 4
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
