import {
  Gamepad2,
  LayoutDashboard,
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
 * stays put across all four. The right side carries the floor's controls — the
 * layout-tools menu and a primary `+ Add` — so the floor itself stays clean. On the
 * "All" floor those controls act on every group at once (see `toolTargets` in
 * Desktop.tsx); on a single workspace they act on just that floor.
 */
// Per-tab category identity color (see categoryStyle / --cat-* tokens): a solid fill when active,
// a colored icon when idle. Class strings are LITERAL so Tailwind's scanner emits them.
const WORKSPACE_TABS: {
  section: MobileSection;
  label: string;
  icon: LucideIcon;
  solid: string;
  text: string;
}[] = [
  // The aggregate "All" floor — every workspace's live windows at once — is the default
  // landing (the bare `/` with no `section` param). Its floor tools act on all groups.
  {
    section: "all",
    label: "All",
    icon: LayoutDashboard,
    solid: "bg-cat-all",
    text: "text-cat-all",
  },
  {
    section: "games",
    label: "Game",
    icon: Gamepad2,
    solid: "bg-cat-game",
    text: "text-cat-game",
  },
  {
    section: "payment",
    label: "Payment",
    icon: Wallet,
    solid: "bg-cat-payment",
    text: "text-cat-payment",
  },
  {
    section: "chat",
    label: "Chat",
    icon: MessagesSquare,
    solid: "bg-cat-chat",
    text: "text-cat-chat",
  },
];

const tabBase =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-transparent px-3 py-2.5 text-sm font-semibold transition-colors";
const tabIdle = "text-foreground/60 hover:bg-secondary hover:text-foreground";
const tabActive = "text-primary-foreground shadow-sm";

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
      <nav className="grid flex-1 grid-cols-4 gap-1">
        {WORKSPACE_TABS.map((t) => {
          const Icon = t.icon;
          const isActive = active === t.section;
          return (
            <Link
              key={t.section}
              to="/"
              search={t.section === "all" ? {} : { section: t.section }}
              className={cn(
                tabBase,
                isActive ? cn(t.solid, tabActive) : tabIdle,
              )}
            >
              {/* Idle tabs keep the category color on the icon so the whole bar reads as colored;
                  the active tab is a solid category pill with cream text (icon inherits it). */}
              <Icon className={cn("size-4", !isActive && t.text)} />
              {t.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex items-center gap-2">
        <Popover open={toolsOpen} onOpenChange={setToolsOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  size="icon"
                  variant="secondary"
                  aria-label="Layout tools"
                  className="size-10 border border-border"
                >
                  <LayoutGrid className="size-5" />
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
          className="h-10 gap-1.5 px-4 text-sm font-semibold"
        >
          <Plus className="size-5" />
          Add
        </Button>
      </div>
    </div>
  );
}
