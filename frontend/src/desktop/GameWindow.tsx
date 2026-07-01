import { useEffect, useRef, type ReactNode } from "react";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { engineClient } from "@/engine/engineClient";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { GridDragHandleProps } from "@/components/ui/grid-layout";

/** Small header action; stops pointer-down so it doesn't start a window drag. */
function HeaderButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClick}
          className={cn(
            "grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
            danger && "hover:bg-destructive/15 hover:text-destructive",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Window chrome for a desktop game: a centered title bar (also the drag handle)
 * with minimize / maximize / close actions that reveal on hover. Minimize hides
 * the window off the floor (managed by the parent); it is re-opened from the
 * floor's Panels menu, not from an in-place collapsed bar. When `onRestore` is
 * given (the window is maximized to fill the floor) the maximize action becomes
 * a restore-down action instead.
 */
export function GameWindow({
  title,
  icon,
  domId,
  dragHandleProps,
  isActive = false,
  onMinimize,
  onMaximize,
  onRestore,
  onClose,
  className,
  children,
}: {
  title: string;
  icon?: ReactNode;
  /** Marks the root with `data-window` so the parent can read its rect (minimize flight). */
  domId?: string;
  dragHandleProps?: GridDragHandleProps;
  isActive?: boolean;
  onMinimize?: () => void;
  onMaximize?: () => void;
  onRestore?: () => void;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  // Render virtualization (ADR-0030): report on-screen/off-screen to the engine so an off-screen
  // window (hidden workspace `display:none`, minimized, or scrolled away — all collapse to a single
  // IntersectionObserver signal) keeps its match running in the worker but stops painting. `domId`
  // is the engine window id (WorkspaceFloor passes `item.id` to both `domId` and `windowId`).
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!domId || !el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) engineClient.setWindowVisible(domId, e.isIntersecting);
      },
      { threshold: 0 },
    );
    obs.observe(el);
    return () => {
      obs.disconnect();
      engineClient.setWindowVisible(domId, true); // unmount: don't strand the slot as hidden
    };
  }, [domId]);

  return (
    <div
      ref={rootRef}
      data-window={domId}
      className={cn(
        "group/window flex h-full min-h-0 w-full flex-col overflow-hidden rounded-none border bg-card shadow-lg transition-shadow",
        isActive
          ? "border-primary shadow-2xl ring-1 ring-primary/30"
          : "border-border",
        className,
      )}
    >
      <header
        {...dragHandleProps}
        className={cn(
          "relative flex h-9 shrink-0 items-center justify-center border-b border-border bg-secondary/40 px-2 text-xs font-semibold text-foreground",
          dragHandleProps &&
            "cursor-grab touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
        )}
      >
        <span className="flex max-w-[60%] items-center gap-1.5">
          {icon}
          <span className="truncate">{title}</span>
        </span>

        <div className="absolute right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/window:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
          {onMinimize && (
            <HeaderButton label="Minimize (hide)" onClick={onMinimize}>
              <Minus className="size-3.5" />
            </HeaderButton>
          )}
          {onRestore ? (
            <HeaderButton label="Restore" onClick={onRestore}>
              <Minimize2 className="size-3.5" />
            </HeaderButton>
          ) : (
            onMaximize && (
              <HeaderButton label="Maximize" onClick={onMaximize}>
                <Maximize2 className="size-3.5" />
              </HeaderButton>
            )
          )}
          <HeaderButton label="Close window" onClick={onClose} danger>
            <X className="size-3.5" />
          </HeaderButton>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}
