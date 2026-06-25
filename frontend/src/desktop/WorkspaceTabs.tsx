import {
  Gamepad2,
  LayoutGrid,
  MessagesSquare,
  PanelBottom,
  PanelRight,
  Plus,
  RotateCcw,
  Trash2,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { MobileSection } from "./AppShell";

type DockSide = "bottom" | "right";

/**
 * Desktop workspaces switch from a tab bar at the top of the arena body — chrome
 * INSIDE the `/` route, not the global header. Each tab is just the `section`
 * search param (so refresh / share keeps the workspace); the telemetry dock below
 * stays put across all three. The right side carries the floor's controls — the
 * layout-tools menu and a primary `+ Add` — so the floor itself stays clean.
 */
const WORKSPACE_TABS: {
  section: MobileSection;
  label: string;
  icon: LucideIcon;
}[] = [
  { section: "games", label: "Game", icon: Gamepad2 },
  { section: "payment", label: "Payment", icon: Wallet },
  { section: "chat", label: "Chat", icon: MessagesSquare },
];

const tab =
  "inline-flex items-center gap-1.5 rounded-md border border-transparent px-3 py-1.5 text-xs font-medium transition-colors";
const tabInactive = "text-foreground/60 hover:text-foreground";
const tabActive = "border-border bg-secondary text-foreground shadow-sm";

/** A row action in the layout-tools menu. */
function ToolItem({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        danger
          ? "text-destructive hover:bg-destructive/10"
          : "text-foreground hover:bg-secondary",
      )}
    >
      <Icon className="size-4" />
      {label}
    </button>
  );
}

export function WorkspaceTabs({
  active,
  dockSide,
  onAdd,
  onArrange,
  onAddAll,
  onResetLayout,
  onRemoveAll,
  onToggleDock,
}: {
  active: MobileSection;
  dockSide: DockSide;
  onAdd: () => void;
  onArrange: () => void;
  onAddAll: () => void;
  onResetLayout: () => void;
  onRemoveAll: () => void;
  onToggleDock: () => void;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const tool = (fn: () => void) => () => {
    fn();
    setToolsOpen(false);
  };
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-background/60 px-2 py-1.5 backdrop-blur">
      <nav className="flex items-center gap-1">
        {WORKSPACE_TABS.map((t) => {
          const Icon = t.icon;
          return (
            <Link
              key={t.section}
              to="/"
              search={t.section === "games" ? {} : { section: t.section }}
              className={cn(tab, active === t.section ? tabActive : tabInactive)}
            >
              <Icon className="size-3.5" />
              {t.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex items-center gap-1.5">
        <Popover open={toolsOpen} onOpenChange={setToolsOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  size="icon"
                  variant="secondary"
                  aria-label="Layout tools"
                  className="size-8 border border-border"
                >
                  <LayoutGrid className="size-4" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>Layout tools</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" side="bottom" className="w-48 p-1">
            <ToolItem
              icon={LayoutGrid}
              label="Auto-arrange"
              onClick={tool(onArrange)}
            />
            <ToolItem icon={Plus} label="Add all" onClick={tool(onAddAll)} />
            <ToolItem
              icon={dockSide === "bottom" ? PanelRight : PanelBottom}
              label={dockSide === "bottom" ? "Dock to right" : "Dock to bottom"}
              onClick={tool(onToggleDock)}
            />
            <ToolItem
              icon={RotateCcw}
              label="Reset layout"
              onClick={tool(onResetLayout)}
            />
            <div className="my-1 border-t border-border" />
            <ToolItem
              icon={Trash2}
              label="Remove all"
              danger
              onClick={tool(onRemoveAll)}
            />
          </PopoverContent>
        </Popover>

        <Button
          size="sm"
          onClick={onAdd}
          aria-label="Add an app"
          data-testid="add-app"
          className="h-8 gap-1"
        >
          <Plus className="size-4" />
          Add
        </Button>
      </div>
    </div>
  );
}
