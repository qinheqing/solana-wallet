import { useState } from "react";
import { Button } from "../../components/ui";
import { useApp } from "../../lib/AppContext";
import { useT } from "../../lib/i18n";
import { SingleTransfer } from "./SingleTransfer";
import { BatchTransfer } from "./BatchTransfer";
import { MixedTransfer } from "./MixedTransfer";

type Tab = "single" | "batch" | "mixed";

export function TransferPage() {
  const t = useT();
  const { state } = useApp();
  const [tab, setTab] = useState<Tab>("single");

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">{t("transfer.title")}</h2>
      {!state.unlockedKeypair && (
        <div className="rounded-md border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
          {t("transfer.unlockHint")}
        </div>
      )}
      <div className="flex gap-2">
        <Button variant={tab === "single" ? "primary" : "default"} onClick={() => setTab("single")}>
          {t("transfer.tab.single")}
        </Button>
        <Button variant={tab === "batch" ? "primary" : "default"} onClick={() => setTab("batch")}>
          {t("transfer.tab.batch")}
        </Button>
        <Button variant={tab === "mixed" ? "primary" : "default"} onClick={() => setTab("mixed")}>
          {t("transfer.tab.mixed")}
        </Button>
      </div>
      {tab === "single" && <SingleTransfer />}
      {tab === "batch" && <BatchTransfer />}
      {tab === "mixed" && <MixedTransfer />}
    </div>
  );
}
