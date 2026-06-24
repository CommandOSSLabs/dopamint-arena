import { useRef } from "react";
import { ArrowLeft, LayoutGrid, Plus, Trash2 } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import {
  GridLayout,
  GridWindow,
  type GridBreakpoint,
  type GridItem,
} from "@/components/ui/grid-layout";
import { compact, nextPosition } from "@/components/ui/grid-layout-engine";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import { GAMES, type GameKey } from "./games";

/** Fewer columns on narrow screens; the layout refits when the count changes. */
const BREAKPOINTS: GridBreakpoint[] = [
  { minWidth: 0, cols: 4 },
  { minWidth: 680, cols: 8 },
  { minWidth: 1040, cols: 12 },
];

const SEED: Record<string, GameKey> = {
  w1: "ttt",
  w2: "coin",
  w3: "dice",
  w4: "clicker",
};

function seedLayout(): GridItem[] {
  const items = Object.entries(SEED).map(([id, key], i): GridItem => {
    const g = GAMES[key];
    return {
      id,
      x: (i * 4) % 12,
      y: 0,
      w: g.w,
      h: g.h,
      minW: g.minW,
      minH: g.minH,
    };
  });
  return compact(items);
}

/** Next free `w<n>` id, derived so it never collides with a persisted layout. */
function nextWindowId(layout: GridItem[]): number {
  return layout.reduce((max, it) => {
    const n = Number.parseInt(it.id.replace(/^w/, ""), 10);
    return Number.isNaN(n) ? max : Math.max(max, n + 1);
  }, 1);
}

export function PlaygroundPage() {
  const [types, setTypes] = useLocalStorageState<Record<string, GameKey>>(
    "mtps.playground.types",
    SEED,
  );
  const [layout, setLayout] = useLocalStorageState<GridItem[]>(
    "mtps.playground.layout",
    seedLayout,
  );
  const nextId = useRef(nextWindowId(layout));

  const addGame = (key: GameKey) => {
    const id = `w${nextId.current++}`;
    const g = GAMES[key];
    const { x, y } = nextPosition(layout);
    setTypes((prev) => ({ ...prev, [id]: key }));
    setLayout((prev) =>
      compact([
        ...prev,
        { id, x, y, w: g.w, h: g.h, minW: g.minW, minH: g.minH },
      ]),
    );
  };

  const closeWindow = (id: string) => {
    setLayout((prev) => compact(prev.filter((it) => it.id !== id)));
    setTypes((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  return (
    <div className="relative flex h-full flex-col text-foreground">
      <div className="wal-aurora" aria-hidden />

      <header className="relative z-10 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-background/70 px-4 py-3 backdrop-blur-xl">
        <div className="flex items-center gap-3 border-r border-border pr-4">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Arena
          </Link>
          <div className="flex flex-col leading-tight">
            <span className="wal-eyebrow text-[10px]">grid demo</span>
            <span className="wal-display text-sm">
              play<span className="wal-gradient-text">ground</span>
            </span>
          </div>
        </div>

        <div className="flex flex-1 flex-wrap gap-2">
          {(Object.keys(GAMES) as GameKey[]).map((key) => {
            const g = GAMES[key];
            const Icon = g.icon;
            return (
              <Button
                key={key}
                size="sm"
                variant="outline"
                onClick={() => addGame(key)}
              >
                <Icon className="text-primary" /> {g.name}
              </Button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <span className="wal-mono text-xs tabular-nums text-muted-foreground">
            {layout.length} windows
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setLayout((prev) => compact(prev))}
            title="Auto-arrange"
          >
            <LayoutGrid /> Arrange
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Close all"
            onClick={() => {
              setLayout([]);
              setTypes({});
            }}
          >
            <Trash2 />
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <div className="relative z-[1] min-h-0 flex-1 overflow-auto p-4">
        {layout.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
            <Plus className="size-7" />
            <p className="max-w-sm text-sm">
              No windows. Pick a game above to open one — then drag the title
              bar and resize from the corner.
            </p>
          </div>
        ) : (
          <GridLayout
            layout={layout}
            onLayoutChange={setLayout}
            breakpoints={BREAKPOINTS}
            renderItem={(item, handle) => {
              const key = types[item.id];
              const g = key && GAMES[key];
              if (!g) return null;
              const Game = g.Component;
              const Icon = g.icon;
              return (
                <GridWindow
                  title={g.name}
                  icon={<Icon className="size-3.5 text-primary" />}
                  dragHandleProps={handle.dragHandleProps}
                  isActive={handle.isActive}
                  onClose={() => closeWindow(item.id)}
                >
                  <Game />
                </GridWindow>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}
