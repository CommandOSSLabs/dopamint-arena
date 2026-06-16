import type { ReactNode } from "react";

/** Shared panel chrome: bordered card with an uppercase title bar. */
export function Panel({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`flex min-h-0 flex-col rounded-md border border-arena-edge bg-arena-panel ${className}`}
    >
      <header className="shrink-0 border-b border-arena-edge px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-arena-muted">
        {title}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

export function StatusPill({ status }: { status: "Success" | "Failed" }) {
  const ok = status === "Success";
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] ${ok ? "text-arena-accent" : "text-red-400"}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-arena-accent" : "bg-red-400"}`}
      />
      {status}
    </span>
  );
}

/** Signed currency string, green for credits and red for debits. */
export function Amount({ value }: { value: string }) {
  const negative = value.trim().startsWith("-");
  return (
    <span className={negative ? "text-red-400" : "text-arena-accent"}>
      {value}
    </span>
  );
}
