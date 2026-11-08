import { useLocale, useT, type Locale } from "../lib/i18n";

const OPTIONS: { value: Locale; label: string }[] = [
  { value: "zh", label: "中" },
  { value: "en", label: "EN" },
];

/** zh / EN segmented toggle; compact enough for the 375px sidebar header. */
export function LocaleToggle({ className = "" }: { className?: string }) {
  const t = useT();
  const { locale, setLocale } = useLocale();
  return (
    <div
      role="group"
      aria-label={t("app.language")}
      className={`inline-flex shrink-0 overflow-hidden rounded-md border border-zinc-700 text-xs ${className}`}
    >
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={locale === o.value}
          onClick={() => setLocale(o.value)}
          className={`px-2 py-1 font-medium transition ${
            locale === o.value ? "bg-emerald-600/30 text-emerald-300" : "text-zinc-400 hover:bg-zinc-800"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
