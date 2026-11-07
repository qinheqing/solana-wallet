import { useState } from "react";
import { Button } from "../../components/ui";
import { TokenCreatePage } from "./TokenCreatePage";
import { TokenManagePage } from "./TokenManagePage";

type Tab = "create" | "manage";

export function TokenPage() {
  const [tab, setTab] = useState<Tab>("create");
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Tokens</h2>
      <div className="flex gap-2">
        <Button variant={tab === "create" ? "primary" : "default"} onClick={() => setTab("create")}>
          Create mint
        </Button>
        <Button variant={tab === "manage" ? "primary" : "default"} onClick={() => setTab("manage")}>
          Manage / mint / burn
        </Button>
      </div>
      {tab === "create" && <TokenCreatePage />}
      {tab === "manage" && <TokenManagePage />}
    </div>
  );
}
