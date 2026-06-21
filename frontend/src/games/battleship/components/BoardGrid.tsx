import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { CellView } from "../view";
import { GridFrame } from "./GridFrame";
import { type Placement, placementCells, FLEET } from "../engine/fleet";
import { ShipSprite } from "./ShipSprite";

const ROW = 10;

/**
 * One 10×10 board. The fleet board passes its own `ship`/`sunk` cells; the firing
 * board passes only `water`/`hit`/`miss` (enemy ships stay hidden until struck).
 * Ship, hit and sunk cells are "solid" hull. When `interactive`, unfired water
 * squares are clickable to fire and show a crosshair on hover. The most recent
 * shot gets a one-shot splash ring.
 */
export function BoardGrid({
  title,
  cells,
  interactive = false,
  onCell,
  lastShot = null,
  placements,
}: {
  title: string;
  cells: CellView[];
  interactive?: boolean;
  onCell?: (cell: number) => void;
  lastShot?: number | null;
  placements?: readonly Placement[];
}) {
  const solid = (idx: number) =>
    idx >= 0 &&
    idx < cells.length &&
    (cells[idx] === "ship" || cells[idx] === "hit" || cells[idx] === "sunk");

  const hullRadius = (cell: number) => {
    const c = cell % ROW;
    const up = solid(cell - ROW);
    const down = solid(cell + ROW);
    const left = c > 0 && solid(cell - 1);
    const right = c < ROW - 1 && solid(cell + 1);
    return cn(
      !up && !left && "rounded-tl-[6px]",
      !up && !right && "rounded-tr-[6px]",
      !down && !left && "rounded-bl-[6px]",
      !down && !right && "rounded-br-[6px]",
    );
  };

  // Precalculate cell-to-ship layout mapping for O(1) rendering lookup
  const shipCoverage = useMemo(() => {
    const map = new Map<
      number,
      { id: string; index: number; orient: "H" | "V"; size: number }
    >();
    if (!placements) return map;
    for (const p of placements) {
      const shipCells = placementCells(p);
      if (!shipCells) continue;
      for (let index = 0; index < shipCells.length; index++) {
        map.set(shipCells[index], {
          id: p.id,
          index,
          orient: p.orient,
          size: shipCells.length,
        });
      }
    }
    return map;
  }, [placements]);

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="text-[11px] font-semibold tracking-wider text-cyan-400/80 uppercase">
        {title}
      </div>
      {/* Cap the board by the window height (cqh) so two stacked / side-by-side
          boards fit a short window without scrolling; width still bounds tall ones. */}
      <div className="mx-auto w-full max-w-[min(100%,40cqh)] rounded-lg bg-slate-950/40 p-1.5 ring-1 ring-cyan-500/20 shadow-lg shadow-cyan-950/20 backdrop-blur-md @[30rem]:max-w-[min(100%,78cqh)]">
        <GridFrame
          renderCell={(cell) => {
            const v = cells[cell];
            const isSolid = v === "ship" || v === "hit" || v === "sunk";
            const canFire = interactive && v === "water";
            const isLast = lastShot === cell;
            const hasShip = shipCoverage.has(cell);

            return (
              <button
                key={cell}
                type="button"
                disabled={!canFire}
                onClick={canFire ? () => onCell?.(cell) : undefined}
                className={cn(
                  "group relative flex aspect-square items-center justify-center border transition-all duration-150 overflow-hidden z-20",
                  isSolid ? hullRadius(cell) : "rounded-[4px]",
                  // If cell contains a ship, make background/border transparent so the overlay shows through
                  hasShip
                    ? "border-transparent bg-transparent"
                    : v === "water" || v === "miss"
                      ? "border-cyan-500/10 bg-cyan-950/20 hover:border-cyan-500/30"
                      : v === "hit"
                        ? "border-red-500/40 bg-gradient-to-b from-slate-950 to-slate-900 shadow-md"
                        : v === "sunk"
                          ? "border-red-950 bg-gradient-to-b from-red-950/40 to-slate-950"
                          : "",
                  canFire && "cursor-crosshair hover:bg-cyan-500/20",
                  isLast &&
                    "ring-2 ring-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)]",
                )}
              >
                {/* HIT Overlay: Fire & pulsing glow */}
                {v === "hit" && (
                  <>
                    <span className="absolute inset-0 bg-red-500/20 animate-pulse pointer-events-none" />
                    <span className="size-[45%] animate-ping absolute rounded-full bg-red-400/50 pointer-events-none" />
                    <span className="size-[50%] rounded-full bg-amber-400 shadow-[0_0_12px_6px_rgba(248,113,113,0.9)] z-10 pointer-events-none" />
                  </>
                )}

                {/* SUNK Overlay: Completely wrecked */}
                {v === "sunk" && (
                  <>
                    <span className="absolute inset-0 bg-red-950/40 pointer-events-none" />
                    <span className="text-[12px] leading-none font-bold text-red-500/80 drop-shadow-[0_0_3px_rgba(239,68,68,0.8)] z-10 select-none">
                      ✕
                    </span>
                  </>
                )}

                {/* MISS Overlay: Sonar splash circle */}
                {v === "miss" && (
                  <span className="size-[40%] rounded-full border-2 border-cyan-400/50 shadow-[0_0_6px_rgba(34,211,238,0.3)] animate-pulse" />
                )}

                {/* One-shot splash on the latest shot */}
                {isLast && (
                  <span className="pointer-events-none absolute inset-0 animate-out fade-out-0 zoom-out-150 ring-4 ring-cyan-400/70 duration-1000 z-10" />
                )}

                {/* Crosshair preview while hovering a fireable cell. */}
                {canFire && (
                  <span className="pointer-events-none absolute inset-0 hidden items-center justify-center text-cyan-400 group-hover:flex z-10">
                    <span className="absolute h-px w-4 bg-current shadow-[0_0_4px_rgba(34,211,238,0.5)]" />
                    <span className="absolute h-4 w-px bg-current shadow-[0_0_4px_rgba(34,211,238,0.5)]" />
                    <span className="absolute size-2 rounded-full border border-current opacity-60 animate-ping" />
                  </span>
                )}
              </button>
            );
          }}
        >
          {/* Continuous Ship Overlays */}
          {placements && (
            <>
              {placements.map((p) => {
                const row = Math.floor(p.cell / 10);
                const col = p.cell % 10;
                const spec = FLEET.find((s) => s.id === p.id);
                if (!spec) return null;
                const size = spec.size;

                const shipCells = placementCells(p) ?? [];
                const isSunk = shipCells.every((c) => cells[c] === "sunk");

                const gridStyle = {
                  gridRowStart: row + 2,
                  gridColumnStart: col + 2,
                  gridRowEnd: p.orient === "V" ? row + 2 + size : row + 2 + 1,
                  gridColumnEnd:
                    p.orient === "H" ? col + 2 + size : col + 2 + 1,
                };

                return (
                  <div
                    key={p.id}
                    className={cn(
                      "pointer-events-none relative overflow-hidden transition-all duration-300",
                      isSunk ? "opacity-35 grayscale" : "opacity-95",
                    )}
                    style={gridStyle}
                  >
                    <ShipSprite
                      id={p.id}
                      size={size}
                      horizontal={p.orient === "H"}
                    />
                  </div>
                );
              })}
            </>
          )}
        </GridFrame>
      </div>
    </div>
  );
}
