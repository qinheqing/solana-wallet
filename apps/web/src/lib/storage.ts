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
  return crypto.randomUUID();
}
