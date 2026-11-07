import { useState } from "react";
import {
  approveMultisigProposal,
  createMultisig,
  createMultisigProposal,
  executeMultisigProposal,
  getMultisigState,
  listProposals,
  parseAmount,
  PublicKey,
  type CreateMultisigResult,
  type MultisigProposalList,
  type MultisigState,
} from "../../lib/coreShim";
import { useApp } from "../../lib/AppContext";
import { Badge, Button, Card, Input, Label, RiskBanner } from "../../components/ui";
import { ResultView } from "../transfer/ResultView";

/**
 * Simplified multisig UI (task 13.7 was lowest priority): supports creating a
 * Squads V4 multisig, viewing its state + proposal list, a minimal SOL-only
 * proposal creator (vault -> destination), and approve/execute per proposal.
 * Full arbitrary-instruction proposal building is NOT implemented.
 */
export function MultisigPage() {
  const { connection, state } = useApp();
  const keypair = state.unlockedKeypair;
  const isMainnet = state.cluster === "mainnet-beta";

  // --- create ---
  const [membersText, setMembersText] = useState("");
  const [threshold, setThreshold] = useState("1");
  const [createResult, setCreateResult] = useState<CreateMultisigResult | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [mainnetAck, setMainnetAck] = useState(false);

  // --- lookup ---
  const [multisigAddress, setMultisigAddress] = useState("");
  const [msState, setMsState] = useState<MultisigState | null>(null);
  const [proposals, setProposals] = useState<MultisigProposalList | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [loadingState, setLoadingState] = useState(false);

  // --- new proposal (SOL only) ---
  const [propDestination, setPropDestination] = useState("");
  const [propAmount, setPropAmount] = useState("");
  const [proposalBusy, setProposalBusy] = useState(false);
  const [proposalError, setProposalError] = useState<string | null>(null);

  const create = async () => {
    setCreateError(null);
    setCreateResult(null);
    if (!keypair) {
      setCreateError("Select/unlock a wallet first.");
      return;
    }
    try {
      const members = membersText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => new PublicKey(l));
      setCreating(true);
      const res = await createMultisig(connection, keypair, members, Number(threshold), {
        allowMainnet: isMainnet ? mainnetAck : undefined,
      });
      setCreateResult(res);
      if (!res.error) setMultisigAddress(res.multisigPda);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const refreshState = async () => {
    setLookupError(null);
    try {
      const pda = new PublicKey(multisigAddress.trim());
      setLoadingState(true);
      const [s, p] = await Promise.all([getMultisigState(connection, pda), listProposals(connection, pda)]);
      setMsState(s);
      setProposals(p);
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : String(e));
      setMsState(null);
      setProposals(null);
    } finally {
      setLoadingState(false);
    }
  };

  const propose = async () => {
    setProposalError(null);
    if (!keypair || !msState) return;
    try {
      setProposalBusy(true);
      const lamports = parseAmount(propAmount, 9);
      await createMultisigProposal(connection, keypair, new PublicKey(msState.multisigPda), {
        destination: propDestination,
        amount: lamports,
      });
      await refreshState();
    } catch (e) {
      setProposalError(e instanceof Error ? e.message : String(e));
    } finally {
      setProposalBusy(false);
    }
  };

  const approve = async (index: string) => {
    if (!keypair || !msState) return;
    await approveMultisigProposal(connection, keypair, new PublicKey(msState.multisigPda), BigInt(index));
    await refreshState();
  };

  const execute = async (index: string) => {
    if (!keypair || !msState) return;
    await executeMultisigProposal(connection, keypair, new PublicKey(msState.multisigPda), BigInt(index));
    await refreshState();
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Multisig (Squads V4)</h2>
      <RiskBanner>
        Simplified module: creation, state/proposal viewing and approve/execute are supported. Creating a proposal
        is limited to a vault SOL transfer. Arbitrary-instruction proposals are not available in this UI.
      </RiskBanner>

      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-300">Create multisig</h3>
        <div>
          <Label>Member public keys (one per line)</Label>
          <textarea
            rows={4}
            value={membersText}
            onChange={(e) => setMembersText(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs text-zinc-100"
          />
        </div>
        <div className="w-32">
          <Label>Threshold</Label>
          <Input value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </div>
        {isMainnet && (
          <label className="flex items-center gap-2 text-sm text-amber-300">
            <input type="checkbox" checked={mainnetAck} onChange={(e) => setMainnetAck(e.target.checked)} />
            I confirm creating this multisig on mainnet-beta.
          </label>
        )}
        {createError && <div className="text-sm text-red-400">{createError}</div>}
        <Button variant="primary" disabled={creating || !keypair} onClick={create}>
          {creating ? "Creating…" : "Create multisig"}
        </Button>
        {createResult && (
          <div className="space-y-1">
            <ResultView result={createResult} />
            {!createResult.error && (
              <div className="font-mono text-xs text-zinc-400">
                multisigPda: {createResult.multisigPda}
                <br />
                vaultPda: {createResult.vaultPda}
              </div>
            )}
          </div>
        )}
      </Card>

      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-300">Inspect multisig</h3>
        <div className="flex gap-2">
          <Input
            value={multisigAddress}
            onChange={(e) => setMultisigAddress(e.target.value)}
            placeholder="multisig PDA address"
          />
          <Button variant="default" onClick={refreshState} disabled={loadingState}>
            {loadingState ? "Loading…" : "Load"}
          </Button>
        </div>
        {lookupError && <div className="text-sm text-red-400">{lookupError}</div>}
        {msState && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs uppercase text-zinc-500">Threshold</div>
                <div>
                  {msState.threshold} of {msState.members.length}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase text-zinc-500">Vault (index 0)</div>
                <div className="font-mono text-xs">{msState.vault0Pda}</div>
              </div>
              <div className="col-span-2">
                <div className="text-xs uppercase text-zinc-500">Members</div>
                <ul className="font-mono text-xs text-zinc-400">
                  {msState.members.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="space-y-2 border-t border-zinc-800 pt-3">
              <Label>New proposal — vault SOL transfer</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="destination"
                  value={propDestination}
                  onChange={(e) => setPropDestination(e.target.value)}
                />
                <Input placeholder="SOL amount" value={propAmount} onChange={(e) => setPropAmount(e.target.value)} />
                <Button variant="primary" disabled={proposalBusy || !keypair} onClick={propose}>
                  {proposalBusy ? "…" : "Propose"}
                </Button>
              </div>
              {proposalError && <div className="text-sm text-red-400">{proposalError}</div>}
            </div>

            <div className="space-y-2 border-t border-zinc-800 pt-3">
              <Label>Proposals</Label>
              {proposals && proposals.proposals.length === 0 && (
                <div className="text-sm text-zinc-500">No proposals yet.</div>
              )}
              <ul className="space-y-2">
                {proposals?.proposals.map((p) => (
                  <li key={p.transactionIndex} className="rounded-md border border-zinc-800 p-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm">#{p.transactionIndex}</span>
                      <Badge
                        tone={
                          p.status === "executed"
                            ? "success"
                            : p.status === "approved"
                              ? "success"
                              : p.status === "rejected" || p.status === "cancelled"
                                ? "danger"
                                : "default"
                        }
                      >
                        {p.status}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      approved by {p.approvedBy.length}/{msState.threshold}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <Button variant="default" onClick={() => approve(p.transactionIndex)} disabled={!keypair}>
                        Approve
                      </Button>
                      <Button
                        variant="primary"
                        onClick={() => execute(p.transactionIndex)}
                        disabled={!keypair || !p.executeReady}
                      >
                        Execute
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
