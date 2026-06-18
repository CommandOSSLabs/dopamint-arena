import type { ReactNode } from "react";

/**
 * Section chrome for the design-system page: a mono eyebrow + tight display
 * title over a glassy bordered surface that frames a group of component demos.
 */
export function ShowcaseSection({
  id,
  eyebrow,
  title,
  description,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <div className="mb-5">
        <p className="wal-eyebrow mb-2">{eyebrow}</p>
        <h2 className="wal-display text-3xl text-foreground">{title}</h2>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="rounded-[20px] border border-border bg-card/75 p-6 backdrop-blur-xl">
        {children}
      </div>
    </section>
  );
}

/** A labelled cell inside a section, captioning an individual variant. */
export function ShowcaseItem({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <span className="wal-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}
