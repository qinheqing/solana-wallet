import { useState } from "react";
import {
  createSplToken,
  createToken2022,
  mintTokens,
  parseAmount,
  parseTransactionError,
  type CreateTokenResult,
} from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { Button, Card, Input, Label } from "../../components/ui";
import { ResultView, type SimpleTxOutcome } from "../transfer/ResultView";

type MintKind = "spl" | "token2022";

export function TokenCreatePage() {
  const { connection, state } = useApp();
  const keypair = state.unlockedKeypair;
  const isMainnet = state.cluster === "mainnet-beta";

  const [kind, setKind] = useState<MintKind>("spl");
  const [decimals, setDecimals] = useState("9");
  const [initialSupply, setInitialSupply] = useState("0");
  const [enableTransferFee, setEnableTransferFee] = useState(false);
  const [feeBps, setFeeBps] = useState("100");
  const [maxFee, setMaxFee] = useState("1000000");
  const [mainnetAck, setMainnetAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<(CreateTokenResult & { minted?: string }) | null>(null);
  const [outcome, setOutcome] = useState<SimpleTxOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    setCreated(null);
    setOutcome(null);
    if (!keypair) {
      setError("Select/unlock a wallet first.");
      return;
    }
    setBusy(true);
    try {
      const dec = Number(decimals);
      const opts = {
        decimals: dec,
        allowMainnet: isMainnet ? mainnetAck : undefined,
      };
      const result =
        kind === "spl"
          ? await createSplToken(connection, keypair, opts)
          : await createToken2022(connection, keypair, {
              ...opts,
              extensions: enableTransferFee
                ? {
                    transferFeeConfig: {
                      transferFeeBasisPoints: Number(feeBps),
                      maximumFee: BigInt(maxFee || "0"),
                    },
                  }
                : undefined,
            });

      let minted: string | undefined;
      const supply = parseAmount(initialSupply || "0", dec);
      if (supply > 0n) {
        const mintRes = await mintTokens(connection, keypair, result.mint, keypair.publicKey, supply, {
          allowMainnet: isMainnet ? mainnetAck : undefined,
        });
        minted = mintRes.signature;
      }
      setCreated({ ...result, minted });
      setOutcome({ signature: result.signature, slot: result.slot, feeLamports: result.feeLamports });
    } catch (e) {
      setOutcome({ error: parseTransactionError(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3">
      <h3 className="text-sm font-semibold text-zinc-300">Create a new mint</h3>
      <div className="flex gap-2">
        <Button variant={kind === "spl" ? "primary" : "default"} onClick={() => setKind("spl")}>
          Classic SPL Token
        </Button>
        <Button variant={kind === "token2022" ? "primary" : "default"} onClick={() => setKind("token2022")}>
          Token-2022
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Decimals</Label>
          <Input value={decimals} onChange={(e) => setDecimals(e.target.value)} />
        </div>
        <div>
          <Label>Initial supply (minted to yourself)</Label>
          <Input value={initialSupply} onChange={(e) => setInitialSupply(e.target.value)} />
        </div>
      </div>

      {kind === "token2022" && (
        <div className="space-y-2 rounded-md border border-zinc-800 p-3">
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={enableTransferFee} onChange={(e) => setEnableTransferFee(e.target.checked)} />
            Enable transferFeeConfig extension
          </label>
          {enableTransferFee && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Fee (basis points, 100 = 1%)</Label>
                <Input value={feeBps} onChange={(e) => setFeeBps(e.target.value)} />
              </div>
              <div>
                <Label>Max fee (base units)</Label>
                <Input value={maxFee} onChange={(e) => setMaxFee(e.target.value)} />
              </div>
            </div>
          )}
        </div>
      )}

      {isMainnet && (
        <label className="flex items-center gap-2 text-sm text-amber-300">
          <input type="checkbox" checked={mainnetAck} onChange={(e) => setMainnetAck(e.target.checked)} />
          I confirm creating this mint on mainnet-beta (real SOL rent).
        </label>
      )}
      {error && <div className="text-sm text-red-400">{error}</div>}
      <Button variant="primary" disabled={busy || !keypair} onClick={create}>
        {busy ? "Creating…" : "Create mint"}
      </Button>

      {outcome && (
        <div className="space-y-2">
          <ResultView result={outcome} />
          {created && !outcome.error && (
            <div className="font-mono text-xs text-zinc-400">
              mint: {created.mint}
              {created.extensions.length > 0 && <div>extensions: {created.extensions.join(", ")}</div>}
              {created.minted && <div>minted tx: {created.minted}</div>}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
