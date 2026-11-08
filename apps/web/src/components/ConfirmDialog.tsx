import { useState, type ReactNode } from "react";
import { Button } from "./ui";

interface ConfirmDialogProps {
  title: string;
  description: ReactNode;
  /** When set, the user must type this exact text to enable confirmation. */
  requireText?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  description,
  requireText,
  confirmLabel = "Confirm",
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const locked = requireText !== undefined && typed !== requireText;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl">
        <h3 className="mb-2 text-base font-semibold text-zinc-100">{title}</h3>
        <div className="mb-4 text-sm text-zinc-300">{description}</div>
        {requireText !== undefined && (
          <div className="mb-4">
            <label htmlFor="confirm-dialog-typed" className="mb-1 block text-xs text-zinc-400">
              Type &quot;{requireText}&quot; to confirm
            </label>
            <input
              id="confirm-dialog-typed"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 focus:border-emerald-600 focus:outline-none"
              autoFocus
            />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} disabled={locked} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
