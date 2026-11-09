import { useEffect, useRef, type ReactNode } from "react";

/** Open modals, bottom → top (Esc closes only the top one). */
const modalStack: number[] = [];
let modalSeq = 0;

/**
 * Large modal: full-screen on phones, centered card (max-w-3xl, 90vh) on
 * wider screens. Header and optional tab bar stay fixed; body scrolls.
 * Esc / backdrop click close it. z-40 so ConfirmDialog (z-50) stacks above.
 */
export function Modal({
  header,
  tabs,
  children,
  onClose,
  closeLabel = "×",
  size = "lg",
}: {
  header: ReactNode;
  tabs?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  /** lg = max-w-3xl (details), md = max-w-xl (forms). */
  size?: "md" | "lg";
}) {
  const id = useRef(0);
  if (id.current === 0) id.current = ++modalSeq;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const myId = id.current;
    modalStack.push(myId);
    const onKey = (e: KeyboardEvent) => {
      // Only the top-most modal reacts; an open ConfirmDialog handles its own Esc first.
      if (e.key !== "Escape" || document.querySelector("[data-confirm-dialog]")) return;
      if (modalStack[modalStack.length - 1] === myId) closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = modalStack.lastIndexOf(myId);
      if (i >= 0) modalStack.splice(i, 1);
      if (modalStack.length === 0) document.body.style.overflow = "";
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/70 sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`flex h-full w-full flex-col overflow-hidden border-zinc-700 bg-zinc-900 shadow-2xl sm:h-auto sm:max-h-[90vh] ${size === "md" ? "sm:max-w-xl" : "sm:max-w-3xl"} sm:rounded-lg sm:border`}
      >
        <div className="flex items-start gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0 flex-1">{header}</div>
          <button
            type="button"
            aria-label="close"
            onClick={onClose}
            className="-mr-1 rounded-md px-2 py-0.5 text-xl leading-none text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            {closeLabel}
          </button>
        </div>
        {tabs && <div className="border-b border-zinc-800 px-4">{tabs}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
