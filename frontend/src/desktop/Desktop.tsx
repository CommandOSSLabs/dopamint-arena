import { useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronDown,
  Eye,
  Gamepad2,
  Gauge,
  LayoutGrid,
  MessageSquare,
  PanelBottom,
  PanelRight,
  Plus,
  ReceiptText,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { PanelImperativeHandle } from "react-resizable-panels";

import "../games"; // register all game modules (side-effect import)
import { GameIcon } from "../games/GameIcon";
import { get, list } from "../games/registry";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  GridLayout,
  type GridBreakpoint,
  type GridDragHandleProps,
  type GridItem,
} from "@/components/ui/grid-layout";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { flyFromDock, flyToDock } from "@/lib/dockFlight";
import { useTelemetry } from "@/telemetry/TelemetryProvider";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { WalletButton } from "@/wallet/WalletButton";
import type { TelemetrySnapshot } from "../panels/types";
import { ChatPanel } from "../panels/ChatPanel";
import { LiveTransactionsFeed } from "../panels/LiveTransactionsFeed";
import { LocalTransactionsFeed } from "../panels/LocalTransactionsFeed";
import { SystemDashboard } from "../panels/SystemDashboard";
import { TpsChart } from "../panels/TpsChart";
import { GameWindow } from "./GameWindow";

type GameModule = ReturnType<typeof list>[number];
type DockSide = "bottom" | "right";

/** One entry per open/hidden window instance. */
type LayerEntry = {
  instanceId: string;
  label: string;
  icon: string;
  image: string;
  hidden: boolean;
};

/** A window popped out of the grid: free-floating, draggable, stackable. */
type FloatState = {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  item: GridItem;
};

// Windows carry an instance id so the same game can open many times: a seeded
// window is just its `gameId`; added duplicates are `gameId#<uuid>`.
const gameOf = (instanceId: string) => instanceId.split("#")[0];
const newInstanceId = (gameId: string) =>
  `${gameId}#${crypto.randomUUID().slice(0, 8)}`;

const clampNum = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

/** Returns a copy of `obj` without `id` (or `obj` itself if absent). */
function dropKey<T>(obj: Record<string, T>, id: string): Record<string, T> {
  if (obj[id] == null) return obj;
  const next = { ...obj };
  delete next[id];
  return next;
}

const WINDOW_SIZE = { w: 4, h: 4, minW: 3, minH: 3 } as const;

const BREAKPOINTS: GridBreakpoint[] = [
  { minWidth: 0, cols: 4 },
  { minWidth: 640, cols: 8 },
  { minWidth: 1024, cols: 16 },
];

// Tile against the widest breakpoint so auto-arrange fills the full row.
const COLS = Math.max(...BREAKPOINTS.map((b) => b.cols));

/** Pack windows left-to-right, wrapping at COLS, preserving each window's size. */
function tile(items: GridItem[]): GridItem[] {
  let x = 0;
  let y = 0;
  let rowH = 0;
  return items.map((item) => {
    const w = Math.min(item.w, COLS);
    if (x + w > COLS) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    const placed = { ...item, x, y, w };
    x += w;
    rowH = Math.max(rowH, item.h);
    return placed;
  });
}

// Community Chat is built but hidden for now — flip to re-enable everywhere.
const SHOW_CHAT = false;

// Phone shell (< lg): one section at a time, switched from a bottom tab bar.
const MOBILE_TABS = [
  { id: "games", label: "Arena", icon: Gamepad2 },
  { id: "stats", label: "Stats", icon: Gauge },
  { id: "activity", label: "Activity", icon: ReceiptText },
  { id: "chat", label: "Chat", icon: MessageSquare },
] as const;
type MobileTab = (typeof MOBILE_TABS)[number]["id"];

/** One tiled window per registered game. */
function seedLayout(): GridItem[] {
  return tile(
    list().map((mod) => ({ id: mod.id, x: 0, y: 0, ...WINDOW_SIZE })),
  );
}

/**
 * Telemetry dock. `bottom` lays the panels out as a resizable horizontal strip;
 * `right` stacks them vertically as a scrolling rail.
 */
function Dock({
  snapshot,
  side,
}: {
  snapshot: TelemetrySnapshot;
  side: DockSide;
}) {
  if (side === "right") {
    return (
      <div className="flex h-full flex-col gap-2 overflow-y-auto p-2">
        <SystemDashboard snapshot={snapshot} />
        <TpsChart snapshot={snapshot} />
        <LiveTransactionsFeed snapshot={snapshot} className="min-h-72 flex-1" />
        <LocalTransactionsFeed
          snapshot={snapshot}
          className="min-h-72 flex-1"
        />
        {SHOW_CHAT && <ChatPanel className="h-72 shrink-0" />}
      </div>
    );
  }
  // Invisible (transparent) handles read as gaps; col-resize cursor is the cue.
  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full p-2">
      <ResizablePanel
        defaultSize={SHOW_CHAT ? "24%" : "32%"}
        minSize="15%"
        className="min-w-0"
      >
        <div className="flex h-full flex-col gap-2 overflow-y-auto">
          <SystemDashboard snapshot={snapshot} />
          <TpsChart snapshot={snapshot} />
        </div>
      </ResizablePanel>
      <ResizableHandle className="w-2 bg-transparent transition-colors hover:bg-border" />
      <ResizablePanel
        defaultSize={SHOW_CHAT ? "26%" : "34%"}
        minSize="16%"
        className="min-w-0"
      >
        <LiveTransactionsFeed snapshot={snapshot} className="h-full" />
      </ResizablePanel>
      <ResizableHandle className="w-2 bg-transparent transition-colors hover:bg-border" />
      <ResizablePanel
        defaultSize={SHOW_CHAT ? "24%" : "34%"}
        minSize="16%"
        className="min-w-0"
      >
        <LocalTransactionsFeed snapshot={snapshot} className="h-full" />
      </ResizablePanel>
      {SHOW_CHAT && (
        <>
          <ResizableHandle className="w-2 bg-transparent transition-colors hover:bg-border" />
          <ResizablePanel defaultSize="26%" minSize="16%" className="min-w-0">
            <ChatPanel className="h-full" />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}

/** A command palette (⌘-style) for adding a game window to the floor. */
function AddGameCommand({
  open,
  onOpenChange,
  games,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  games: GameModule[];
  onAdd: (id: string) => void;
}) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a game"
      description="Search and add a game window to the floor."
    >
      <CommandInput placeholder="Search games…" />
      <CommandList>
        <CommandEmpty>No games to add.</CommandEmpty>
        <CommandGroup heading="Games">
          {games.map((g) => (
            <CommandItem
              key={g.id}
              value={g.name}
              onSelect={() => {
                onAdd(g.id);
                onOpenChange(false);
              }}
            >
              <GameIcon game={g} className="size-5" />
              {g.name}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

/**
 * A macOS-style dock holding minimized windows; click restores, right-click
 * opens show/close, icons magnify on hover. It hugs whichever floor edge is free
 * of the telemetry dock — the right edge, or the bottom when the dock is on the
 * right.
 */
function MacDock({
  entries,
  side,
  onShow,
  onClose,
}: {
  entries: LayerEntry[];
  side: "right" | "bottom";
  onShow: (id: string) => void;
  onClose: (id: string) => void;
}) {
  if (entries.length === 0) return null;
  const vertical = side === "right";
  return (
    <div
      data-mac-dock
      className={cn(
        "absolute z-30 flex gap-2 rounded-2xl border border-border bg-card/80 p-2 shadow-lg backdrop-blur",
        vertical
          ? "top-1/2 right-2 max-h-[80%] -translate-y-1/2 flex-col"
          : "bottom-2 left-1/2 max-w-[90%] -translate-x-1/2 flex-row",
      )}
    >
      {entries.map((e) => (
        <ContextMenu key={e.instanceId}>
          <Tooltip>
            <TooltipTrigger asChild>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  data-dock-item={e.instanceId}
                  onClick={() => onShow(e.instanceId)}
                  aria-label={`Restore ${e.label}`}
                  className={cn(
                    "grid size-11 shrink-0 animate-in place-items-center overflow-hidden rounded-xl border border-border bg-secondary text-xl shadow-sm transition-transform duration-150 ease-out zoom-in-50 hover:scale-125",
                    vertical
                      ? "origin-right hover:-translate-x-1"
                      : "origin-bottom hover:-translate-y-1",
                  )}
                >
                  {e.image ? (
                    <img
                      src={e.image}
                      alt=""
                      aria-hidden
                      draggable={false}
                      className="size-full object-cover"
                    />
                  ) : (
                    <span aria-hidden>{e.icon}</span>
                  )}
                </button>
              </ContextMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side={vertical ? "left" : "top"}>
              {e.label}
            </TooltipContent>
          </Tooltip>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => onShow(e.instanceId)}>
              <Eye /> Show
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              onClick={() => onClose(e.instanceId)}
            >
              <X /> Close
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </div>
  );
}

/** A row action in the layout-tools popover. */
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

/**
 * Floor overlays: a layout-tools popover (arrange / add all / dock side / remove
 * all) and a prominent Add-game trigger. `side` is the edge the menus open
 * toward — flipped when the column itself moves to the left.
 */
function FloorControls({
  className,
  side,
  dockSide,
  onOpenAdd,
  onArrange,
  onAddAll,
  onRemoveAll,
  onToggleDock,
}: {
  className?: string;
  side: "left" | "right" | "top";
  dockSide: DockSide;
  onOpenAdd: () => void;
  onArrange: () => void;
  onAddAll: () => void;
  onRemoveAll: () => void;
  onToggleDock: () => void;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const tool = (fn: () => void) => () => {
    fn();
    setToolsOpen(false);
  };
  return (
    <div className={cn("flex items-stretch border border-border bg-card", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            onClick={onOpenAdd}
            aria-label="Add game"
            className="size-10 rounded-none border-0 shadow-none [&_svg]:size-4"
          >
            <Plus />
          </Button>
        </TooltipTrigger>
        <TooltipContent side={side}>Add game</TooltipContent>
      </Tooltip>

      <Popover open={toolsOpen} onOpenChange={setToolsOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                size="icon"
                variant="secondary"
                aria-label="Layout tools"
                className="size-10 rounded-none border-0 border-l border-border shadow-none"
              >
                <LayoutGrid className="size-4" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side={side}>Layout tools</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" side={side} className="w-48 p-1">
          <ToolItem
            icon={LayoutGrid}
            label="Auto-arrange"
            onClick={tool(onArrange)}
          />
          <ToolItem
            icon={Plus}
            label="Add all games"
            onClick={tool(onAddAll)}
          />
          <ToolItem
            icon={dockSide === "bottom" ? PanelRight : PanelBottom}
            label={dockSide === "bottom" ? "Dock to right" : "Dock to bottom"}
            onClick={tool(onToggleDock)}
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
    </div>
  );
}

/** Bottom bar: add/layout always visible; dock expand/collapse fills the rest on hover. */
function ArenaFooter({
  dockSide,
  bottomCollapsed,
  onToggleBottom,
  onOpenAdd,
  onArrange,
  onAddAll,
  onRemoveAll,
  onToggleDock,
}: {
  dockSide: DockSide;
  bottomCollapsed: boolean;
  onToggleBottom: () => void;
  onOpenAdd: () => void;
  onArrange: () => void;
  onAddAll: () => void;
  onRemoveAll: () => void;
  onToggleDock: () => void;
}) {
  const collapseRotate =
    dockSide === "bottom"
      ? bottomCollapsed
        ? "rotate-180"
        : ""
      : bottomCollapsed
        ? "rotate-90"
        : "-rotate-90";

  return (
    <footer className="group/footer pointer-events-auto absolute inset-x-3 bottom-3 z-30 flex h-10 items-stretch bg-transparent">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onToggleBottom}
            aria-label={bottomCollapsed ? "Expand dock" : "Collapse dock"}
            className={cn(
              "flex h-10 flex-1 items-center justify-center border border-r-0 border-border",
              "bg-transparent opacity-0 transition-opacity",
              "group-hover/footer:opacity-100 group-hover/footer:bg-background",
            )}
          >
            <ChevronDown
              className={cn("size-4 transition-transform", collapseRotate)}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {bottomCollapsed ? "Expand dock" : "Collapse dock"}
        </TooltipContent>
      </Tooltip>
      <FloorControls
        side="top"
        dockSide={dockSide}
        onOpenAdd={onOpenAdd}
        onArrange={onArrange}
        onAddAll={onAddAll}
        onRemoveAll={onRemoveAll}
        onToggleDock={onToggleDock}
        className="shrink-0 border border-border bg-card"
      />
    </footer>
  );
}

/**
 * The arena desktop (`/`): a draggable/resizable floor of self-playing game
 * windows over a resizable, collapsible telemetry dock (bottom or right).
 * Maximizing pops a window out into a free-floating layer; phones switch
 * sections from a bottom tab bar.
 */
export function Desktop() {
  const [layout, setLayout] = useLocalStorageState<GridItem[]>(
    "dopamint.desktop.layout.v3",
    seedLayout,
  );
  // Minimized windows: id → saved geometry, restored from the right-edge dock.
  const [hidden, setHidden] = useLocalStorageState<Record<string, GridItem>>(
    "dopamint.desktop.hidden.v1",
    {},
  );
  // Popped-out windows: free-floating over the desktop, click-to-front z-order.
  const [floating, setFloating] = useLocalStorageState<
    Record<string, FloatState>
  >("dopamint.desktop.floating.v2", {});
  const floatZ = useRef(100);
  const [addOpen, setAddOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [resetDefault, setResetDefault] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("games");
  const [dockSide, setDockSide] = useLocalStorageState<DockSide>(
    "dopamint.desktop.dockSide.v1",
    "bottom",
  );
  const { snapshot } = useTelemetry();
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  // Dock collapse — a no-drag alternative to the resize handle.
  const bottomRef = useRef<PanelImperativeHandle>(null);
  const [bottomCollapsed, setBottomCollapsed] = useState(false);

  const toggleBottom = () => {
    const panel = bottomRef.current;
    if (!panel) return;
    const collapsed = panel.isCollapsed();
    if (collapsed) panel.expand();
    else panel.collapse();
    setBottomCollapsed(!collapsed);
  };
  const toggleDockSide = () => {
    setDockSide((s) => (s === "bottom" ? "right" : "bottom"));
    setBottomCollapsed(false);
  };
  // The minimized dock hugs whichever floor edge the telemetry dock leaves free.
  const macDockSide: "right" | "bottom" =
    dockSide === "right" ? "bottom" : "right";

  // Animate a window's ghost into the dock, then read its rect (before unmount).
  const animateMinimize = (id: string) => {
    const el = document.querySelector(`[data-window="${id}"]`);
    if (el instanceof HTMLElement) {
      flyToDock(el, get(gameOf(id))?.image ?? "", macDockSide);
    }
  };

  const close = (id: string) => {
    setLayout((cur) => tile(cur.filter((w) => w.id !== id)));
    setHidden((h) => dropKey(h, id));
    setFloating((f) => dropKey(f, id));
  };

  // Minimize → fly into the dock, hide off the floor (keeping geometry), re-tile.
  const hide = (id: string) => {
    const item = layout.find((w) => w.id === id);
    if (!item) return;
    animateMinimize(id);
    setHidden((h) => ({ ...h, [id]: item }));
    setLayout((cur) => tile(cur.filter((w) => w.id !== id)));
  };

  // Restore from the dock → grid, flying the window back out of its dock tile.
  const show = (id: string) => {
    const item = hidden[id];
    if (!item) return;
    const dockEl = document.querySelector(`[data-dock-item="${id}"]`);
    const from =
      dockEl instanceof HTMLElement ? dockEl.getBoundingClientRect() : null;
    setHidden((h) => dropKey(h, id));
    setLayout((cur) => tile([...cur, item]));
    if (from) {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-window="${id}"]`);
        if (el instanceof HTMLElement) {
          flyFromDock(el, get(gameOf(id))?.image ?? "", from);
        }
      });
    }
  };

  // Add a fresh window for a game — duplicates allowed; the floor re-tiles.
  const addGame = (gameId: string) =>
    setLayout((cur) =>
      tile([...cur, { id: newInstanceId(gameId), x: 0, y: 0, ...WINDOW_SIZE }]),
    );

  // One window per game not already on the floor.
  const addAll = () =>
    setLayout((cur) => {
      const present = new Set(cur.map((w) => gameOf(w.id)));
      const adds = list()
        .filter((m) => !present.has(m.id))
        .map((m) => ({ id: newInstanceId(m.id), x: 0, y: 0, ...WINDOW_SIZE }));
      return tile([...cur, ...adds]);
    });

  // Confirmed from the Remove-all dialog: clear everything, optionally reseeding
  // the default layout (all games) instead of an empty floor.
  const confirmRemove = () => {
    setLayout(resetDefault ? seedLayout() : []);
    setHidden({});
    setFloating({});
    setResetDefault(false);
    setRemoveOpen(false);
  };

  // Auto-arrange: re-pack every window to fill the rows, keeping their sizes.
  const arrange = () => setLayout((cur) => tile(cur));

  // --- Floating (maximized) windows -------------------------------------
  const focusFloat = (id: string) => {
    floatZ.current += 1;
    const z = floatZ.current;
    setFloating((f) => (f[id] ? { ...f, [id]: { ...f[id], z } } : f));
  };

  // Maximize → pop the window out of the grid into the floating layer.
  const floatWindow = (id: string) => {
    const item = layout.find((w) => w.id === id);
    if (!item || floating[id]) return;
    const fw = window.innerWidth * 0.7;
    const fh = window.innerHeight * 0.7;
    const n = Object.keys(floating).length;
    floatZ.current += 1;
    setFloating((f) => ({
      ...f,
      [id]: {
        x: clampNum(
          (window.innerWidth - fw) / 2 + n * 28,
          0,
          window.innerWidth - fw,
        ),
        y: clampNum(
          (window.innerHeight - fh) / 2 + n * 28,
          0,
          window.innerHeight - fh,
        ),
        w: fw,
        h: fh,
        z: floatZ.current,
        item,
      },
    }));
    setLayout((cur) => tile(cur.filter((w) => w.id !== id)));
  };

  // Restore a floating window back into the grid.
  const dockFloat = (id: string) => {
    const st = floating[id];
    if (!st) return;
    setFloating((f) => dropKey(f, id));
    setLayout((cur) => tile([...cur, st.item]));
  };

  // Minimize a floating window straight into the hidden dock (with flight).
  const minimizeFloat = (id: string) => {
    const st = floating[id];
    if (!st) return;
    animateMinimize(id);
    setFloating((f) => dropKey(f, id));
    setHidden((h) => ({ ...h, [id]: st.item }));
  };

  const startFloatDrag = (id: string, e: ReactPointerEvent) => {
    e.preventDefault();
    focusFloat(id);
    const base = floating[id];
    if (!base) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const maxX = window.innerWidth - base.w;
    const maxY = window.innerHeight - base.h;
    const onMove = (ev: PointerEvent) =>
      setFloating((f) =>
        f[id]
          ? {
              ...f,
              [id]: {
                ...f[id],
                x: clampNum(base.x + ev.clientX - startX, 0, maxX),
                y: clampNum(base.y + ev.clientY - startY, 0, maxY),
              },
            }
          : f,
      );
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Free pixel resize from any edge or corner. Dragging the top/left edges also
  // shifts the window's origin so the opposite edge stays put.
  const startFloatResize =
    (id: string, dir: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw") =>
    (e: ReactPointerEvent) => {
      e.preventDefault();
      focusFloat(id);
      const base = floating[id];
      if (!base) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const left = dir.includes("w");
      const right = dir.includes("e");
      const top = dir.includes("n");
      const bottom = dir.includes("s");
      const MIN_W = 320;
      const MIN_H = 220;
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let { x, y, w, h } = base;
        if (right) w = clampNum(base.w + dx, MIN_W, window.innerWidth - base.x);
        if (left) {
          const edge = base.x + base.w;
          x = clampNum(base.x + dx, 0, edge - MIN_W);
          w = edge - x;
        }
        if (bottom)
          h = clampNum(base.h + dy, MIN_H, window.innerHeight - base.y);
        if (top) {
          const edge = base.y + base.h;
          y = clampNum(base.y + dy, 0, edge - MIN_H);
          h = edge - y;
        }
        setFloating((f) =>
          f[id] ? { ...f, [id]: { ...f[id], x, y, w, h } } : f,
        );
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
  // Keyboard parity with grid windows: arrows nudge the floating window, shift
  // for bigger steps.
  const onFloatKeyDown = (id: string) => (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 40 : 20;
    let dx = 0;
    let dy = 0;
    if (e.key === "ArrowLeft") dx = -step;
    else if (e.key === "ArrowRight") dx = step;
    else if (e.key === "ArrowUp") dy = -step;
    else if (e.key === "ArrowDown") dy = step;
    else return;
    e.preventDefault();
    focusFloat(id);
    setFloating((f) =>
      f[id]
        ? {
            ...f,
            [id]: {
              ...f[id],
              x: clampNum(f[id].x + dx, 0, window.innerWidth - f[id].w),
              y: clampNum(f[id].y + dy, 0, window.innerHeight - f[id].h),
            },
          }
        : f,
    );
  };
  const floatDragProps = (id: string): GridDragHandleProps => ({
    onPointerDown: (e) => startFloatDrag(id, e),
    onKeyDown: onFloatKeyDown(id),
    tabIndex: 0,
    role: "button",
    "aria-label": "Move window. Arrow keys move, shift for bigger steps.",
  });

  // Window instances, labelled with a per-game ordinal when duplicates exist.
  const windows = [
    ...layout.map((w) => ({ instanceId: w.id, hidden: false })),
    ...Object.values(hidden).map((w) => ({ instanceId: w.id, hidden: true })),
  ];
  const totals: Record<string, number> = {};
  for (const w of windows) {
    const g = gameOf(w.instanceId);
    totals[g] = (totals[g] ?? 0) + 1;
  }
  const seen: Record<string, number> = {};
  const layerEntries: LayerEntry[] = windows.map((w) => {
    const g = gameOf(w.instanceId);
    const mod = get(g);
    const n = (seen[g] = (seen[g] ?? 0) + 1);
    return {
      instanceId: w.instanceId,
      label: mod ? (totals[g] > 1 ? `${mod.name} ${n}` : mod.name) : g,
      icon: mod?.icon ?? "🎮",
      image: mod?.image ?? "",
      hidden: w.hidden,
    };
  });
  const hiddenCount = Object.keys(hidden).length;
  const hiddenEntries = layerEntries.filter((e) => e.hidden);

  const floor =
    layout.length === 0 ? (
      <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        No games on the floor.
        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
          <Plus /> Add a game
        </Button>
      </div>
    ) : (
      <GridLayout
        layout={layout}
        onLayoutChange={setLayout}
        breakpoints={BREAKPOINTS}
        rowHeight={72}
        gap={0}
        renderItem={(item, handle) => {
          const mod = get(gameOf(item.id));
          if (!mod) return null;
          const Content = mod.Window;
          return (
            <GameWindow
              title={mod.name}
              icon={<GameIcon game={mod} className="size-5" />}
              domId={item.id}
              dragHandleProps={handle.dragHandleProps}
              isActive={handle.isActive}
              onMinimize={() => hide(item.id)}
              onMaximize={() => floatWindow(item.id)}
              onClose={() => close(item.id)}
            >
              <Content windowId={item.id} onClose={() => close(item.id)} />
            </GameWindow>
          );
        }}
      />
    );

  // Floor + the minimized-windows dock (footer controls live on the desktop shell).
  const floorArea = () => (
    <div className="relative h-full">
      <div className="bg-dot-grid h-full overflow-auto">{floor}</div>
      <MacDock
        entries={hiddenEntries}
        side={macDockSide}
        onShow={show}
        onClose={close}
      />
    </div>
  );

  const mobileFloorControls = (
    <FloorControls
      side="top"
      dockSide={dockSide}
      onOpenAdd={() => setAddOpen(true)}
      onArrange={arrange}
      onAddAll={addAll}
      onRemoveAll={() => setRemoveOpen(true)}
      onToggleDock={toggleDockSide}
      className="fixed bottom-20 right-3 z-30 border border-border bg-card"
    />
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col text-foreground">
      {isDesktop ? (
        <>
          {dockSide === "bottom" ? (
            <ResizablePanelGroup
              orientation="vertical"
              className="relative z-[1] min-h-0 flex-1"
            >
              <ResizablePanel defaultSize="58%" minSize="20%" className="min-h-0">
                {floorArea()}
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel
                panelRef={bottomRef}
                collapsible
                collapsedSize="0%"
                defaultSize="42%"
                minSize="14%"
                className="min-h-0"
              >
                <Dock snapshot={snapshot} side="bottom" />
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <ResizablePanelGroup
              orientation="horizontal"
              className="relative z-[1] min-h-0 flex-1"
            >
              <ResizablePanel defaultSize="68%" minSize="35%" className="min-w-0">
                {floorArea()}
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel
                panelRef={bottomRef}
                collapsible
                collapsedSize="0%"
                defaultSize="32%"
                minSize="18%"
                className="min-w-0"
              >
                <Dock snapshot={snapshot} side="right" />
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
          <ArenaFooter
            dockSide={dockSide}
            bottomCollapsed={bottomCollapsed}
            onToggleBottom={toggleBottom}
            onOpenAdd={() => setAddOpen(true)}
            onArrange={arrange}
            onAddAll={addAll}
            onRemoveAll={() => setRemoveOpen(true)}
            onToggleDock={toggleDockSide}
          />
        </>
      ) : (
        <>
          <main className="relative z-[1] min-h-0 flex-1 overflow-auto">
            {mobileTab === "games" && (
              <div className="bg-dot-grid relative min-h-full">
                {floor}
                {mobileFloorControls}
                <MacDock
                  entries={hiddenEntries}
                  side="right"
                  onShow={show}
                  onClose={close}
                />
              </div>
            )}
            {mobileTab === "stats" && (
              <div className="flex flex-col gap-2 p-2">
                <SystemDashboard snapshot={snapshot} />
                <TpsChart snapshot={snapshot} />
              </div>
            )}
            {mobileTab === "activity" && (
              <div className="flex h-full flex-col gap-2 p-2">
                <LiveTransactionsFeed
                  snapshot={snapshot}
                  className="min-h-0 flex-1"
                />
                <LocalTransactionsFeed
                  snapshot={snapshot}
                  className="min-h-0 flex-1"
                />
              </div>
            )}
            {SHOW_CHAT && mobileTab === "chat" && (
              <div className="h-full p-2">
                <ChatPanel className="h-full" />
              </div>
            )}
          </main>

          <nav className="z-10 flex shrink-0 items-stretch border-t border-border bg-background/80 backdrop-blur-xl">
            {MOBILE_TABS.filter((t) => SHOW_CHAT || t.id !== "chat").map(
              (t) => {
                const Icon = t.icon;
                const active = mobileTab === t.id;
                const showBadge = t.id === "games" && hiddenCount > 0;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setMobileTab(t.id)}
                    aria-label={t.label}
                    aria-current={active}
                    className={cn(
                      "relative flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition-colors",
                      active
                        ? "text-primary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="size-5" />
                    {t.label}
                    {showBadge && (
                      <span className="absolute top-1.5 right-[calc(50%-1.25rem)] size-1.5 rounded-full bg-primary" />
                    )}
                  </button>
                );
              },
            )}
          </nav>
        </>
      )}

      <AddGameCommand
        open={addOpen}
        onOpenChange={setAddOpen}
        games={list()}
        onAdd={addGame}
      />

      <Dialog
        open={removeOpen}
        onOpenChange={(o) => {
          setRemoveOpen(o);
          if (!o) setResetDefault(false);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Clear the floor?</DialogTitle>
            <DialogDescription>
              Removes every open and minimized window.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={resetDefault}
              onCheckedChange={(v) => setResetDefault(v === true)}
            />
            Reset to default — re-open all games
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmRemove}>
              {resetDefault ? "Reset to default" : "Remove all"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Floating (maximized) windows — free over everything, click-to-front. */}
      {Object.entries(floating).map(([id, st]) => {
        const mod = get(gameOf(id));
        if (!mod) return null;
        const Content = mod.Window;
        return (
          <div
            key={id}
            className="absolute"
            style={{
              left: st.x,
              top: st.y,
              width: st.w,
              height: st.h,
              zIndex: st.z,
            }}
            onPointerDown={() => focusFloat(id)}
          >
            <GameWindow
              title={mod.name}
              icon={<GameIcon game={mod} className="size-5" />}
              domId={id}
              dragHandleProps={floatDragProps(id)}
              isActive
              onMinimize={() => minimizeFloat(id)}
              onRestore={() => dockFloat(id)}
              onClose={() => close(id)}
            >
              <Content windowId={id} onClose={() => close(id)} />
            </GameWindow>
            {/* Free resize from every edge + corner. */}
            {(
              [
                {
                  dir: "n",
                  cls: "top-0 right-3 left-3 h-1.5 cursor-ns-resize",
                },
                {
                  dir: "s",
                  cls: "right-3 bottom-0 left-3 h-1.5 cursor-ns-resize",
                },
                {
                  dir: "w",
                  cls: "top-3 bottom-3 left-0 w-1.5 cursor-ew-resize",
                },
                {
                  dir: "e",
                  cls: "top-3 right-0 bottom-3 w-1.5 cursor-ew-resize",
                },
                { dir: "nw", cls: "top-0 left-0 size-3 cursor-nwse-resize" },
                { dir: "ne", cls: "top-0 right-0 size-3 cursor-nesw-resize" },
                { dir: "sw", cls: "bottom-0 left-0 size-3 cursor-nesw-resize" },
                {
                  dir: "se",
                  cls: "right-0 bottom-0 size-3 cursor-nwse-resize",
                },
              ] as const
            ).map((hdl) => (
              <div
                key={hdl.dir}
                className={cn("absolute z-10 touch-none", hdl.cls)}
                onPointerDown={startFloatResize(id, hdl.dir)}
                aria-hidden
              />
            ))}
            <div
              className="pointer-events-none absolute right-0 bottom-0 grid size-5 place-items-center text-muted-foreground/70"
              aria-hidden
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M11 4 L4 11 M11 8 L8 11"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          </div>
        );
      })}

      <header className="pointer-events-none absolute inset-x-3 top-3 z-30 flex items-start justify-between bg-transparent">
        <div className="pointer-events-auto bg-background px-3 py-2">
          <span className="wal-display text-base">
            Dopamint<span className="wal-gradient-text">Arena</span>
          </span>
        </div>
        <div className="pointer-events-auto flex items-stretch border border-border bg-background">
          <WalletButton
            variant="ghost"
            className="h-10 rounded-none border-0 shadow-none px-3"
          />
          <ThemeToggle className="size-10 rounded-none border-0 border-l border-border shadow-none" />
        </div>
      </header>
    </div>
  );
}
