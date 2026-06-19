import type { ReactNode } from "react";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";

import { cn } from "@/lib/utils";
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
            "grid size-6 place-items-center text-muted-foreground transition-colors hover:text-foreground",
            danger && "hover:text-destructive",
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
 * Window chrome for a desktop game: a floating title chip (left) and window
 * controls (right) overlay the content and only appear on hover. The bar itself
 * is transparent so the game fills the cell edge-to-edge. Minimize hides the
 * window off the floor (managed by the parent); it is re-opened from the
 * floor's Panels menu. When `onRestore` is given the maximize action becomes
 * restore-down instead.
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
  return (
    <div
      data-window={domId}
      className={cn(
        "group/window relative h-full min-h-0 w-full overflow-hidden border bg-card transition-[border-color,box-shadow]",
        isActive
          ? "border-primary ring-1 ring-primary/30"
          : "border-border",
        className,
      )}
    >
      <div className="h-full min-h-0 overflow-auto">{children}</div>

      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between bg-transparent">
        <div
          {...dragHandleProps}
          className={cn(
            "pointer-events-auto flex max-w-[55%] items-center gap-1.5 px-2 py-1 text-xs font-semibold text-foreground",
            "bg-transparent opacity-0 transition-opacity group-hover/window:opacity-100 group-hover/window:bg-background",
            "focus-within:opacity-100 focus-within:bg-background",
            dragHandleProps &&
              "cursor-grab touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
          )}
        >
          {icon}
          <span className="truncate">{title}</span>
        </div>

        <div className="pointer-events-auto flex items-center gap-0.5 bg-transparent px-1 py-0.5 opacity-0 transition-opacity group-hover/window:opacity-100 group-hover/window:bg-background focus-within:opacity-100 focus-within:bg-background">
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
    </div>
  );
}
