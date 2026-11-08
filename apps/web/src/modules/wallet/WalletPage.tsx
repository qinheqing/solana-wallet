import { useState } from "react";
import { Button } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { WalletList } from "./WalletList";
import { GenerateWalletFlow } from "./GenerateWalletFlow";
import { ImportWalletFlow } from "./ImportWalletFlow";
import { AddressToolsCard } from "./AddressToolsCard";

type Tab = "list" | "generate" | "import";

export function WalletPage() {
  const t = useT();
  const [tab, setTab] = useState<Tab>("list");

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">{t("wallet.title")}</h2>
      <div className="flex gap-2">
        <Button variant={tab === "list" ? "primary" : "default"} onClick={() => setTab("list")}>
          {t("wallet.tab.manage")}
        </Button>
        <Button variant={tab === "generate" ? "primary" : "default"} onClick={() => setTab("generate")}>
          {t("wallet.tab.generate")}
        </Button>
        <Button variant={tab === "import" ? "primary" : "default"} onClick={() => setTab("import")}>
          {t("wallet.tab.import")}
        </Button>
      </div>

      {tab === "list" && (
        <>
          <WalletList />
          <AddressToolsCard />
        </>
      )}
      {tab === "generate" && <GenerateWalletFlow onDone={() => setTab("list")} />}
      {tab === "import" && <ImportWalletFlow onDone={() => setTab("list")} />}
    </div>
  );
}
