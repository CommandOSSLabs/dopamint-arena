import { useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronDown,
  Eye,
  LayoutGrid,
  PanelBottom,
  PanelRight,
  Plus,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { disposeWindow } from "@/lib/windowSessions";
import { forgetWindow, markWindowActive } from "@/lib/activeWindows";
import { flyFromDock, flyToDock } from "@/lib/dockFlight";
import { useTelemetry } from "@/telemetry/TelemetryProvider";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { useSearch } from "@tanstack/react-router";
import type { TelemetrySnapshot } from "../panels/types";
import { ChatPanel } from "../panels/ChatPanel";
import { LiveTransactionsFeed } from "../panels/LiveTransactionsFeed";
import { LocalTransactionsFeed } from "../panels/LocalTransactionsFeed";
import { SystemDashboard } from "../panels/SystemDashboard";
import { TpsChart } from "../panels/TpsChart";
import { GameWindow } from "./GameWindow";
import { GameCabinet } from "@/shell/cabinet/GameCabinet";
import { MobileArena } from "./MobileArena";
import type { MobileSection } from "./AppShell";

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

// Every game window opens at the SAME size so the floor reads as one uniform grid
// rather than a patchwork of per-game footprints. minW/minH is the global resize floor.
const TILE = { w: 4, h: 4, minW: 3, minH: 3 } as const;

// Column counts are all multiples of TILE.w (4) so uniform windows always pack into
// full rows: 3 per row on a wide floor, 2 on a tablet-width dock, 1 on a narrow one.
const BREAKPOINTS: GridBreakpoint[] = [
  { minWidth: 0, cols: 4 },
  { minWidth: 640, cols: 8 },
  { minWidth: 1024, cols: 12 },
];

// Tile against the widest breakpoint so auto-arrange fills the full row.
const COLS = Math.max(...BREAKPOINTS.map((b) => b.cols));

/**
 * First-fit pack: drop each window into the first free grid slot, scanning rows
 * top-to-bottom and columns left-to-right. Unlike a plain row-packer this fills
 * holes — e.g. the empty cells to the right of a tall window's lower half — so a
 * newly added or re-arranged window slots into space on an existing row before
 * opening a new row below. Footprints never overlap; each window keeps its size.
 */
function tile(items: GridItem[]): GridItem[] {
  const placed: GridItem[] = [];
  const free = (x: number, y: number, w: number, h: number) =>
    placed.every(
      (p) => x + w <= p.x || x >= p.x + p.w || y + h <= p.y || y >= p.y + p.h,
    );
  return items.map((item) => {
    const w = Math.min(item.w, COLS);
    const h = item.h;
    let x = 0;
    let y = 0;
    search: for (y = 0; ; y++) {
      for (x = 0; x <= COLS - w; x++) {
        if (free(x, y, w, h)) break search;
      }
    }
    const placedItem = { ...item, x, y, w };
    placed.push(placedItem);
    return placedItem;
  });
}

// Edge/corner grab zones for a floating window's free pixel resize.
const FLOAT_HANDLES = [
  { dir: "n", cls: "top-0 right-3 left-3 h-1.5 cursor-ns-resize" },
  { dir: "s", cls: "right-3 bottom-0 left-3 h-1.5 cursor-ns-resize" },
  { dir: "w", cls: "top-3 bottom-3 left-0 w-1.5 cursor-ew-resize" },
  { dir: "e", cls: "top-3 right-0 bottom-3 w-1.5 cursor-ew-resize" },
  { dir: "nw", cls: "top-0 left-0 size-3 cursor-nwse-resize" },
  { dir: "ne", cls: "top-0 right-0 size-3 cursor-nesw-resize" },
  { dir: "sw", cls: "bottom-0 left-0 size-3 cursor-nesw-resize" },
  { dir: "se", cls: "right-0 bottom-0 size-3 cursor-nwse-resize" },
] as const;

// Community Chat is built but hidden for now — flip to re-enable everywhere.
const SHOW_CHAT = false;

/** One tiled window per catalog game (floating-widget modules are excluded by `list()`). */
function seedLayout(): GridItem[] {
  return tile(list().map((mod) => ({ id: mod.id, x: 0, y: 0, ...TILE })));
}

// Utility surfaces opened as centered floating widgets in the first-run / reset
// layout (registered with catalog: false, so they never tile or show in the picker).
const FLOATING_DEFAULTS = ["regular-payments", "chat"] as const;

/** Floating widgets spread across the screen `space-around` for the default layout —
 *  each centered in its 1/n slice of the width, so the gap to either edge is equal
 *  and they sit toward the middle. Vertically centered. */
function seedFloating(): Record<string, FloatState> {
  if (typeof window === "undefined") return {};
  const out: Record<string, FloatState> = {};
  const margin = 24;
  const n = FLOATING_DEFAULTS.length;
  FLOATING_DEFAULTS.forEach((id, i) => {
    if (!get(id)) return; // not registered → skip
    const w = Math.min(360, window.innerWidth - 2 * margin);
    const h = Math.min(440, window.innerHeight - 2 * margin);
    const x = ((2 * i + 1) / (2 * n)) * window.innerWidth - w / 2;
    const y = (window.innerHeight - h) / 2;
    out[id] = {
      x: clampNum(x, 0, window.innerWidth - w),
      y: clampNum(y, 0, window.innerHeight - h),
      w,
      h,
      z: 100 + i,
      item: { id, x: 0, y: 0, ...TILE },
    };
  });
  return out;
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
              data-testid={`launch-${g.id}`}
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
  side: "left" | "right";
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
    <div className={cn("flex flex-col items-end gap-2", className)}>
      <Popover open={toolsOpen} onOpenChange={setToolsOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                size="icon"
                variant="secondary"
                aria-label="Layout tools"
                className="size-10 border border-border shadow-lg"
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

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            onClick={onOpenAdd}
            aria-label="Add game"
            data-testid="add-game"
            className="size-12 shadow-lg [&_svg]:size-5"
          >
            <Plus />
          </Button>
        </TooltipTrigger>
        <TooltipContent side={side}>Add game</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * The arena body (`/`): a draggable/resizable floor of self-playing game windows
 * over a resizable, collapsible telemetry dock (bottom or right). Maximizing pops
 * a window out into a free-floating layer. On phones it renders one section at a
 * time (`section` search param, driven by the shell's bottom tabs). The navbar and
 * tab bar live in AppShell so this view swaps without remounting the chrome.
 */
export function ArenaView() {
  const [layout, setLayout] = useLocalStorageState<GridItem[]>(
    "dopamint.desktop.layout.v4",
    seedLayout,
  );
  // Minimized windows: id → saved geometry, restored from the right-edge dock.
  const [hidden, setHidden] = useLocalStorageState<Record<string, GridItem>>(
    "dopamint.desktop.hidden.v2",
    {},
  );
  // Popped-out windows: free-floating over the desktop, click-to-front z-order.
  const [floating, setFloating] = useLocalStorageState<
    Record<string, FloatState>
  >("dopamint.desktop.floating.v6", seedFloating);
  const floatZ = useRef(100);
  const [addOpen, setAddOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [resetDefault, setResetDefault] = useState(false);
  // The phone section is driven by the shell's bottom tabs via the `section` search param.
  const section =
    (useSearch({ strict: false }) as { section?: MobileSection }).section ??
    "games";
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
    disposeWindow(id); // tear down the game's live session (sockets, timers)
    forgetWindow(id); // stop the phone resuming this now-dead instance
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

  // A newly packed window can land below the fold; scroll the floor to bring the
  // given window into view so the user sees where it ended up.
  const revealWindow = (id: string) =>
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-window="${id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );

  // Add a fresh window for a game — duplicates allowed; the floor re-tiles so the new
  // window fills the first free slot (right-of-row before opening a new row), then
  // scrolls into view.
  const addGame = (gameId: string) => {
    const id = newInstanceId(gameId);
    setLayout((cur) => tile([...cur, { id, x: 0, y: 0, ...TILE }]));
    revealWindow(id);
  };

  // One window per game not already on the floor.
  const addAll = () =>
    setLayout((cur) => {
      const present = new Set(cur.map((w) => gameOf(w.id)));
      const adds = list()
        .filter((m) => !present.has(m.id))
        .map((m) => ({ id: newInstanceId(m.id), x: 0, y: 0, ...TILE }));
      return tile([...cur, ...adds]);
    });

  // Confirmed from the Remove-all dialog: clear everything, optionally reseeding
  // the default layout (all games) instead of an empty floor.
  const confirmRemove = () => {
    // Dispose every open/hidden/floating window's session before clearing.
    for (const id of [
      ...layout.map((w) => w.id),
      ...Object.keys(hidden),
      ...Object.keys(floating),
    ]) {
      disposeWindow(id);
    }
    setLayout(resetDefault ? seedLayout() : []);
    setHidden({});
    setFloating(resetDefault ? seedFloating() : {});
    setResetDefault(false);
    setRemoveOpen(false);
  };

  // Auto-arrange: reset every window to the uniform tile size and re-pack into a
  // clean grid. Manual resizes are intentionally dropped — a tidy grid is the point.
  const arrange = () => {
    setLayout((cur) => tile(cur.map((w) => ({ ...w, ...TILE }))));
    // The re-packed grid anchors at the top; jump there so the tidy-up is visible.
    requestAnimationFrame(() =>
      document
        .querySelector("[data-floor]")
        ?.scrollTo({ top: 0, behavior: "smooth" }),
    );
  };

  // --- Floating (maximized) windows -------------------------------------
  const focusFloat = (id: string) => {
    markWindowActive(id);
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
  const hiddenEntries = layerEntries.filter((e) => e.hidden);

  const renderFloorControls = (className: string, side: "left" | "right") => (
    <FloorControls
      className={className}
      side={side}
      dockSide={dockSide}
      onOpenAdd={() => setAddOpen(true)}
      onArrange={arrange}
      onAddAll={addAll}
      onRemoveAll={() => setRemoveOpen(true)}
      onToggleDock={toggleDockSide}
    />
  );

  // Every window (docked + minimized + floating) is rendered by ONE GridLayout so a
  // window changing mode is a style change, not an unmount — gameplay state is never
  // lost on minimize/maximize. Minimized/floating items are detached via styleOverride
  // (excluded from grid math); docked windows still pack among themselves.
  const allWindows: GridItem[] = [
    ...layout,
    ...Object.values(hidden),
    ...Object.values(floating).map((f) => f.item),
  ];
  const styleFor = (item: GridItem): CSSProperties | null => {
    if (hidden[item.id]) return { display: "none" };
    const f = floating[item.id];
    if (f)
      return {
        position: "fixed",
        left: f.x,
        top: f.y,
        width: f.w,
        height: f.h,
        zIndex: f.z,
      };
    return null;
  };

  const floor =
    allWindows.length === 0 ? (
      <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        No games on the floor.
        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
          <Plus /> Add a game
        </Button>
      </div>
    ) : (
      <GridLayout
        layout={allWindows}
        onLayoutChange={(next) =>
          setLayout(next.filter((w) => !hidden[w.id] && !floating[w.id]))
        }
        onActivate={markWindowActive}
        breakpoints={BREAKPOINTS}
        rowHeight={72}
        styleOverride={styleFor}
        renderItem={(item, handle) => {
          const mod = get(gameOf(item.id));
          if (!mod) return null;
          const Content = mod.Window;
          const fl = floating[item.id];
          const win = (
            <GameWindow
              title={mod.name}
              icon={<GameIcon game={mod} className="size-5" />}
              domId={item.id}
              dragHandleProps={
                fl ? floatDragProps(item.id) : handle.dragHandleProps
              }
              isActive={fl ? true : handle.isActive}
              onMinimize={() => (fl ? minimizeFloat(item.id) : hide(item.id))}
              onMaximize={fl ? undefined : () => floatWindow(item.id)}
              onRestore={fl ? () => dockFloat(item.id) : undefined}
              onClose={() => close(item.id)}
            >
              {/* Shared arcade cabinet: hover → pause → take-over overlay, common to every
                  window. Inert for games that don't register a CabinetController yet. */}
              <GameCabinet>
                <Content windowId={item.id} onClose={() => close(item.id)} />
              </GameCabinet>
            </GameWindow>
          );
          // Always wrap identically — float-handles + focus-to-front only when
          // floating — so maximize/minimize is a style change, NOT a remount. That
          // keeps every game's component state alive across the transition, instead
          // of only games that stash it in a windowId store (Battleship). The grid's
          // own resize handles are suppressed for detached items, so no overlap.
          return (
            <div
              className="relative h-full w-full"
              onPointerDown={fl ? () => focusFloat(item.id) : undefined}
            >
              {win}
              {fl &&
                FLOAT_HANDLES.map((hdl) => (
                  <div
                    key={hdl.dir}
                    className={cn("absolute z-10 touch-none", hdl.cls)}
                    onPointerDown={startFloatResize(item.id, hdl.dir)}
                    aria-hidden
                  />
                ))}
            </div>
          );
        }}
      />
    );

  // Floor + its overlays (controls column + the minimized-windows dock).
  const floorArea = (controlsClass: string, side: "left" | "right") => (
    <div className="relative h-full">
      <div data-floor className="bg-dot-grid h-full overflow-auto p-2">
        {floor}
      </div>
      {renderFloorControls(controlsClass, side)}
      <MacDock
        entries={hiddenEntries}
        side={macDockSide}
        onShow={show}
        onClose={close}
      />
    </div>
  );

  const collapseRotate =
    dockSide === "bottom"
      ? bottomCollapsed
        ? "rotate-180"
        : ""
      : bottomCollapsed
        ? "rotate-90"
        : "-rotate-90";
  const collapseButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggleBottom}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={bottomCollapsed ? "Expand dock" : "Collapse dock"}
          className={cn(
            "z-50 flex items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg ring-2 ring-background transition-colors hover:bg-primary/90",
            dockSide === "bottom"
              ? "h-6 w-16 -translate-y-5"
              : "h-16 w-6 -translate-x-5",
          )}
        >
          <ChevronDown
            className={cn("size-4 transition-transform", collapseRotate)}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {bottomCollapsed ? "Expand dock" : "Collapse dock"}
      </TooltipContent>
    </Tooltip>
  );

  return (
    <>
      {isDesktop ? (
        dockSide === "bottom" ? (
          <ResizablePanelGroup
            orientation="vertical"
            className="h-full min-h-0"
          >
            <ResizablePanel defaultSize="58%" minSize="20%" className="min-h-0">
              {floorArea("absolute bottom-3 right-3 z-20", "left")}
            </ResizablePanel>
            <ResizableHandle>{collapseButton}</ResizableHandle>
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
            className="h-full min-h-0"
          >
            <ResizablePanel defaultSize="68%" minSize="35%" className="min-w-0">
              {floorArea("absolute bottom-3 right-3 z-20 items-end", "right")}
            </ResizablePanel>
            <ResizableHandle>{collapseButton}</ResizableHandle>
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
        )
      ) : (
        <main className="h-full overflow-auto">
          {section === "games" && <MobileArena />}
          {section === "stats" && (
            <div className="flex flex-col gap-2 p-2">
              <SystemDashboard snapshot={snapshot} />
              <TpsChart snapshot={snapshot} />
            </div>
          )}
          {section === "activity" && (
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
        </main>
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
    </>
  );
}
