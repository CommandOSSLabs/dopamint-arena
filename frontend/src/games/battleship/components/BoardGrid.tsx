import { cn } from "@/lib/utils";
import type { CellView } from "../view";
import { GridFrame } from "./GridFrame";

const ROW = 10;

/**
 * One 10×10 board. The fleet board passes its own `ship`/`sunk` cells; the firing
 * board passes only `water`/`hit`/`miss` (enemy ships stay hidden until struck).
 * Ship, hit and sunk cells are "solid" hull — adjacent solids merge into one
 * rounded shape so a fleet reads as ships. When `interactive`, unfired water
 * squares are clickable to fire and show a crosshair on hover. The most recent
 * shot gets a one-shot splash ring.
 */
export function BoardGrid({
  title,
  cells,
  interactive = false,
  onCell,
  lastShot = null,
}: {
  title: string;
  cells: CellView[];
  interactive?: boolean;
  onCell?: (cell: number) => void;
  lastShot?: number | null;
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

  return (
    <div className="flex w-full flex-col gap-1">
      <div className="text-[11px] font-semibold tracking-wide text-arena-muted uppercase">
        {title}
      </div>
      {/* Cap the board by the window height (cqh) so two stacked / side-by-side
          boards fit a short window without scrolling; width still bounds tall ones. */}
      <div className="mx-auto w-full max-w-[min(100%,40cqh)] rounded-md bg-sky-950/30 p-1 ring-1 ring-sky-500/10 @[30rem]:max-w-[min(100%,78cqh)]">
        <GridFrame
          renderCell={(cell) => {
            const v = cells[cell];
            const isSolid = v === "ship" || v === "hit" || v === "sunk";
            const canFire = interactive && v === "water";
            const isLast = lastShot === cell;
            return (
              <button
                key={cell}
                type="button"
                disabled={!canFire}
                onClick={canFire ? () => onCell?.(cell) : undefined}
                className={cn(
                  "group relative flex aspect-square items-center justify-center border",
                  isSolid ? hullRadius(cell) : "rounded-[3px]",
                  (v === "water" || v === "miss") &&
                    "border-sky-400/15 bg-sky-900/40",
                  v === "ship" &&
                    "border-slate-500/60 bg-gradient-to-b from-slate-300 to-slate-500 shadow-inner",
                  v === "hit" &&
                    "border-red-900/60 bg-gradient-to-b from-red-500 to-red-800",
                  v === "sunk" &&
                    "border-slate-800 bg-gradient-to-b from-slate-700 to-slate-900",
                  canFire && "cursor-crosshair hover:bg-arena-accent/40",
                  isLast && "z-10 ring-2 ring-arena-accent",
                )}
              >
                {v === "hit" && (
                  <span className="size-[55%] animate-pulse rounded-full bg-amber-200 shadow-[0_0_10px_4px_rgba(248,113,113,0.85)]" />
                )}
                {v === "sunk" && (
                  <span className="text-[10px] leading-none font-bold text-slate-400">
                    ✕
                  </span>
                )}
                {v === "miss" && (
                  <span className="size-[34%] rounded-full border border-sky-200/70" />
                )}
                {/* One-shot splash on the latest shot — mounts fresh when lastShot moves. */}
                {isLast && (
                  <span className="pointer-events-none absolute inset-0 animate-in rounded-full fade-in-0 zoom-in-50 ring-2 ring-arena-accent/70 duration-500" />
                )}
                {/* Crosshair preview while hovering a fireable cell. */}
                {canFire && (
                  <span className="pointer-events-none absolute inset-0 hidden items-center justify-center text-arena-accent group-hover:flex">
                    <span className="absolute h-px w-3 bg-current" />
                    <span className="absolute h-3 w-px bg-current" />
                  </span>
                )}
              </button>
            );
          }}
        />
      </div>
    </div>
  );
}
