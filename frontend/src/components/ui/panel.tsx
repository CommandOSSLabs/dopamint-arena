import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Panel — the platform's bordered surface with an uppercase title bar. Composable
 * like shadcn primitives (Panel + PanelHeader/PanelTitle/PanelAction/PanelContent)
 * and theme-aware via semantic tokens, so it works in light and dark.
 */
function Panel({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      data-slot="panel"
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground",
        className,
      )}
      {...props}
    />
  );
}

function PanelHeader({ className, ...props }: ComponentProps<"header">) {
  return (
    <header
      data-slot="panel-header"
      className={cn(
        "flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2",
        className,
      )}
      {...props}
    />
  );
}

function PanelTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-title"
      className={cn(
        "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function PanelAction({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-action"
      className={cn("flex shrink-0 items-center gap-1", className)}
      {...props}
    />
  );
}

function PanelContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-content"
      className={cn("min-h-0 flex-1 overflow-auto", className)}
      {...props}
    />
  );
}

export { Panel, PanelHeader, PanelTitle, PanelAction, PanelContent };
