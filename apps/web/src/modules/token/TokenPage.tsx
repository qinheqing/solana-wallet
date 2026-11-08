import { useState } from "react";
import { Button } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { TokenCreatePage } from "./TokenCreatePage";
import { TokenManagePage } from "./TokenManagePage";

type Tab = "create" | "manage";

export function TokenPage() {
  const t = useT();
  const [tab, setTab] = useState<Tab>("create");
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">{t("token.title")}</h2>
      <div className="flex gap-2">
        <Button variant={tab === "create" ? "primary" : "default"} onClick={() => setTab("create")}>
          {t("token.tab.create")}
        </Button>
        <Button variant={tab === "manage" ? "primary" : "default"} onClick={() => setTab("manage")}>
          {t("token.tab.manage")}
        </Button>
      </div>
      {tab === "create" && <TokenCreatePage />}
      {tab === "manage" && <TokenManagePage />}
    </div>
  );
}
