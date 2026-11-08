import { useState } from "react";
import { Button } from "../../components/ui";
import { WalletList } from "./WalletList";
import { GenerateWalletFlow } from "./GenerateWalletFlow";
import { ImportWalletFlow } from "./ImportWalletFlow";
import { AddressToolsCard } from "./AddressToolsCard";

type Tab = "list" | "generate" | "import";

export function WalletPage() {
  const [tab, setTab] = useState<Tab>("list");

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Wallets</h2>
      <div className="flex gap-2">
        <Button variant={tab === "list" ? "primary" : "default"} onClick={() => setTab("list")}>
          Manage
        </Button>
        <Button variant={tab === "generate" ? "primary" : "default"} onClick={() => setTab("generate")}>
          Generate new
        </Button>
        <Button variant={tab === "import" ? "primary" : "default"} onClick={() => setTab("import")}>
          Import
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
