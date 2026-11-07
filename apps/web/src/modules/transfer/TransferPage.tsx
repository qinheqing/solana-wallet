import { useState } from "react";
import { Button } from "../../components/ui";
import { useApp } from "../../lib/AppContext";
import { SingleTransfer } from "./SingleTransfer";
import { BatchTransfer } from "./BatchTransfer";
import { MixedTransfer } from "./MixedTransfer";

type Tab = "single" | "batch" | "mixed";

export function TransferPage() {
  const { state } = useApp();
  const [tab, setTab] = useState<Tab>("single");

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Transfer</h2>
      {!state.unlockedKeypair && (
        <div className="rounded-md border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
          Select and unlock a wallet on the Wallets page to send transactions.
        </div>
      )}
      <div className="flex gap-2">
        <Button variant={tab === "single" ? "primary" : "default"} onClick={() => setTab("single")}>
          Single
        </Button>
        <Button variant={tab === "batch" ? "primary" : "default"} onClick={() => setTab("batch")}>
          Batch
        </Button>
        <Button variant={tab === "mixed" ? "primary" : "default"} onClick={() => setTab("mixed")}>
          Mixed
        </Button>
      </div>
      {tab === "single" && <SingleTransfer />}
      {tab === "batch" && <BatchTransfer />}
      {tab === "mixed" && <MixedTransfer />}
    </div>
  );
}
