/** Shared building blocks for the transaction viewer tables. */
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { Badge, Card } from "../../components/ui";
import { AmountValue } from "../../components/Amount";
import { Address } from "../../components/CopyButton";

const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** Shortened address (full key on hover / copy). */
export function Key({ value }: { value: string | null | undefined }) {
  return <Address value={value} short />;
}

/** One labelled address per line: "owner  abcde…vwxyz". */
export function KeyLine({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-center gap-2 whitespace-nowrap leading-5">
      <span className="w-12 shrink-0 text-[11px] text-zinc-500">{label}</span>
      <Key value={value} />
    </div>
  );
}

export function ProgramBadge({ programId }: { programId: string }) {
  if (programId === T22)
    return (
      <span className="whitespace-nowrap">
        <Badge tone="success">Token-2022</Badge>
      </span>
    );
  if (programId === SPL)
    return (
      <span className="whitespace-nowrap">
        <Badge>SPL Token</Badge>
      </span>
    );
  return <Key value={programId} />;
}

export function IxIndex({ index, inner }: { index: number; inner: number | null }) {
  return (
    <span className="font-mono text-zinc-400">
      #{index}
      {inner !== null && <span className="text-zinc-500">.{inner}</span>}
    </span>
  );
}

export function TypeCell({ type, inner, programId }: { type: string; inner: boolean; programId?: string }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="whitespace-nowrap font-mono text-zinc-200">{type}</span>
      {(programId || inner) && (
        <div className="flex gap-1 whitespace-nowrap">
          {programId && <ProgramBadge programId={programId} />}
          {inner && <Badge tone="warn">inner</Badge>}
        </div>
      )}
    </div>
  );
}

export function Delta({ raw, decimals, sol }: { raw: string | null; decimals: number | null; sol?: boolean }) {
  const t = useT();
  if (raw === null) return <span className="text-zinc-600">—</span>;
  const tone = raw.startsWith("-") ? "text-red-300" : raw === "0" ? "text-zinc-400" : "text-emerald-300";
  return (
    <span className={tone}>
      {sol ? (
        <AmountValue raw={raw} decimals={9} symbol="SOL" unit={t("common.lamports")} stacked />
      ) : (
        <AmountValue raw={raw} decimals={decimals} stacked />
      )}
    </span>
  );
}

/** Card with a titled header and a count pill; renders `empty` when count is 0. */
export function Section({
  title,
  count,
  empty,
  always = false,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  /** Show the card (with the `empty` text) even when count is 0. */
  always?: boolean;
  children: ReactNode;
}) {
  if (count === 0 && !always) return null;
  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
        <span className="rounded-full bg-zinc-800 px-2 text-xs leading-5 text-zinc-400">{count}</span>
      </div>
      {count === 0 ? <div className="text-sm text-zinc-500">{empty}</div> : children}
    </Card>
  );
}

export function Table({ head, children, minWidth }: { head: ReactNode[]; children: ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto rounded-md border border-zinc-800">
      <table className="w-full text-left text-xs text-zinc-300" style={minWidth ? { minWidth } : undefined}>
        <thead className="bg-zinc-900/80 text-zinc-500">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/70">{children}</tbody>
      </table>
    </div>
  );
}

export const TR = "align-top hover:bg-zinc-800/30";
export const TD = "px-3 py-2";
/** Amount cells: keep raw value and ≈ hint unbroken. */
export const TDN = "whitespace-nowrap px-3 py-2";

