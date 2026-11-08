/**
 * Tiny dependency-free i18n. The English dictionary is the source of truth
 * for the key set; `zh` must provide every key (enforced by its type).
 *
 * - `t(key, vars?)` with `{name}` interpolation
 * - locale persisted in localStorage (`solwallet.locale`)
 * - default from navigator.language (zh* → zh, else en)
 * - document.title and <html lang> follow the locale
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en } from "../locales/en";
import { zh } from "../locales/zh";

export type Locale = "zh" | "en";
export type TKey = keyof typeof en;
export type TVars = Record<string, string | number>;
export type TFn = (key: TKey, vars?: TVars) => string;

const STORAGE_KEY = "solwallet.locale";
const DICTS: Record<Locale, Record<TKey, string>> = { en, zh };

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // localStorage unavailable (private mode / sandboxed iframe) — fall through.
  }
  const lang = typeof navigator !== "undefined" ? navigator.language : "en";
  return /^zh/i.test(lang) ? "zh" : "en";
}

/** Type guard for dynamically composed keys (e.g. `preflight.${code}`). */
export function hasKey(key: string): key is TKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

export function translate(locale: Locale, key: TKey, vars?: TVars): string {
  const template = DICTS[locale][key] ?? DICTS.en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

interface I18nApi {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: TFn;
}

const I18nCtx = createContext<I18nApi | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore persistence failures
    }
  }, []);

  const t = useCallback<TFn>((key, vars) => translate(locale, key, vars), [locale]);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    document.title = translate(locale, "app.title");
  }, [locale]);

  const api = useMemo<I18nApi>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nCtx.Provider value={api}>{children}</I18nCtx.Provider>;
}

function useI18n(): I18nApi {
  const ctx = useContext(I18nCtx);
  if (!ctx) throw new Error("useT/useLocale must be used within I18nProvider");
  return ctx;
}

/** Returns `t(key, vars?)` for the active locale. */
export function useT(): TFn {
  return useI18n().t;
}

export function useLocale(): { locale: Locale; setLocale: (next: Locale) => void } {
  const { locale, setLocale } = useI18n();
  return { locale, setLocale };
}
