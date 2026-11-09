import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 ${className}`}>
      {children}
    </div>
  );
}

export function Button({
  variant = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger" | "ghost" }) {
  const base = "whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed";
  const styles: Record<string, string> = {
    default: "bg-zinc-800 text-zinc-100 hover:bg-zinc-700",
    primary: "bg-emerald-600 text-white hover:bg-emerald-500",
    danger: "bg-red-700 text-white hover:bg-red-600",
    ghost: "bg-transparent text-zinc-300 hover:bg-zinc-800",
  };
  return <button className={`${base} ${styles[variant]} ${className}`} {...props} />;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 placeholder:font-sans focus:border-emerald-600 focus:outline-none ${props.className ?? ""}`}
    />
  );
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 placeholder:font-sans focus:border-emerald-600 focus:outline-none ${props.className ?? ""}`}
    />
  );
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-zinc-400">
      {children}
    </label>
  );
}

export function Badge({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "success" | "warn" | "danger" }) {
  const tones: Record<string, string> = {
    default: "bg-zinc-800 text-zinc-300",
    success: "bg-emerald-900/60 text-emerald-300",
    warn: "bg-amber-900/60 text-amber-300",
    danger: "bg-red-900/60 text-red-300",
  };
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function RiskBanner({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-300">
      {children}
    </div>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-red-700/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
      {children}
    </div>
  );
}
