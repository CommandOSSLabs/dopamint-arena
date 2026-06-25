import { memo, useMemo } from "react";
import { cn } from "@/lib/utils";
import type { CellView } from "../view";
import { GridFrame } from "./GridFrame";
import { type Placement, placementCells, FLEET } from "../engine/fleet";

/**
 * One firing/fleet square. Memoised so a board repaint — every auto-play frame derives
 * a fresh `cells` array, re-rendering the parent ~once per frame — only re-renders the
 * handful of squares that actually changed, not all 100 (×2 boards). Props are
 * primitives plus the stable `onCell`, so React.memo's shallow compare can bail; the
 * per-cell `cn(...)` (the dominant cost) then runs only for changed cells.
 */
const BoardCell = memo(function BoardCell({
  cell,
  v,
  canFire,
  isLast,
  hasShip,
  onCell,
}: {
  cell: number;
  v: CellView;
  canFire: boolean;
  isLast: boolean;
  hasShip: boolean;
  onCell?: (cell: number) => void;
}) {
  // Plain letter markers (the symbol glyphs ✕/◯ have no Gochi Hand glyph and fall
  // back to a mismatched symbol font): X for a struck hull, O for a splash miss.
  const marker = v === "hit" || v === "sunk" ? "X" : v === "miss" ? "O" : "";
  return (
    <button
      type="button"
      disabled={!canFire}
      onClick={canFire ? () => onCell?.(cell) : undefined}
      className={cn(
        "bs-cell",
        // Ship cells stay transparent so the inked hull overlay shows through; the
        // hit/miss marker still draws on top.
        hasShip
          ? "border-transparent"
          : v === "hit"
            ? "bs-cell--hit"
            : v === "sunk"
              ? "bs-cell--sunk"
              : v === "miss"
                ? "bs-cell--miss"
                : "",
        canFire && "bs-cell--fire",
        isLast && "bs-cell--last",
      )}
    >
      {marker && (
        <span
          className={cn(
            "bs-mark select-none",
            v === "miss" ? "text-[var(--qp-ink-soft)]" : "text-[var(--qp-red)]",
            v === "hit" && "motion-safe:animate-pulse",
          )}
        >
          {marker}
        </span>
      )}
    </button>
  );
});

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
  // The firing board (no own placements) reads as the felt-green target grid.
  const isEnemy = !placements;

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
    <div className="flex w-full flex-col gap-1.5 lg:h-full lg:min-h-0">
      {title && (
        <div className="qp-eyebrow shrink-0 text-[clamp(9px,2.4cqmin,14px)] uppercase">
          {title}
        </div>
      )}
      {/* Desktop (≥lg): the board fills the height its grid cell allots and is the largest SQUARE
          that fits — sized by whichever of width/height binds (container-query units), so it never
          overflows a short window (no scroll). The 1.25rem trims the fixed A–J label row.
          Mobile (<lg): a FULL-WIDTH square (no height clamp, no container-query) so cells are big
          enough to tap; the page scrolls to reach the second board. */}
      <div className="grid place-items-center lg:min-h-0 lg:flex-1 lg:[container-type:size]">
        <div
          className={cn(
            "bs-board aspect-square w-full max-w-full lg:aspect-auto lg:w-[min(100cqw,calc(100cqh_-_1.25rem))]",
            isEnemy && "bs-board--enemy",
          )}
        >
          <GridFrame
            renderCell={(cell) => {
              const v = cells[cell];
              // Compute only primitives here; the memoised cell owns the heavy cn().
              return (
                <BoardCell
                  key={cell}
                  cell={cell}
                  v={v}
                  canFire={interactive && v === "water"}
                  isLast={lastShot === cell}
                  hasShip={shipCoverage.has(cell)}
                  onCell={onCell}
                />
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
                        "bs-ship pointer-events-none transition-all duration-300",
                        isSunk && "bs-ship--sunk",
                      )}
                      style={gridStyle}
                    />
                  );
                })}
              </>
            )}
          </GridFrame>
        </div>
      </div>
    </div>
  );
}
