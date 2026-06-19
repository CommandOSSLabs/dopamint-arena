import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  FLEET,
  type Orientation,
  type Placement,
  fleetIsLegal,
  placeFleetRandom,
  placementCells,
} from "../engine/fleet";
import { GridFrame } from "./GridFrame";

/**
 * Fleet placement: starts from a random legal layout (so the start button works
 * immediately). Pick a ship, set orientation (button or `R`), and a live preview
 * follows the cursor — accent where it fits, red where it doesn't — then click to
 * drop it. Calls `onReady` with the placements once the whole fleet is legal.
 */
export function PlacementBoard({
  onReady,
  ctaLabel = "Start Battle",
}: {
  onReady: (placements: Placement[]) => void;
  ctaLabel?: string;
}) {
  const [placements, setPlacements] = useState<Placement[]>(() =>
    placeFleetRandom(Math.random),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [orient, setOrient] = useState<Orientation>("H");
  const [hover, setHover] = useState<number | null>(null);

  const ownerByCell = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of placements) {
      const cells = placementCells(p);
      if (!cells) continue;
      for (const c of cells) m.set(c, p.id);
    }
    return m;
  }, [placements]);

  const legal = useMemo(() => fleetIsLegal(placements), [placements]);

  // Where the selected ship would land under the cursor, and whether it's legal.
  const preview = useMemo(() => {
    if (!selected || hover === null) return null;
    const candidate = placements.map((p) =>
      p.id === selected ? { id: selected, cell: hover, orient } : p,
    );
    const cells = placementCells({ id: selected, cell: hover, orient });
    return {
      cells: new Set(cells ?? []),
      valid: cells !== null && fleetIsLegal(candidate),
    };
  }, [selected, hover, orient, placements]);

  const placeAt = (cell: number) => {
    if (!selected) {
      const owner = ownerByCell.get(cell);
      if (owner) setSelected(owner);
      return;
    }
    setPlacements((cur) =>
      cur.map((p) => (p.id === selected ? { id: selected, cell, orient } : p)),
    );
  };

  const rotate = () => setOrient((o) => (o === "H" ? "V" : "H"));

  return (
    <div
      className="flex h-full flex-col gap-2 p-2 outline-none @[26rem]:gap-3 @[26rem]:p-3"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "r" || e.key === "R") {
          e.preventDefault();
          rotate();
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-arena-text">
          Place your fleet
        </span>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={rotate}
            className="rounded border border-arena-edge px-2 py-1 text-xs text-arena-text hover:bg-arena-edge"
          >
            Rotate (R) · {orient === "H" ? "→" : "↓"}
          </button>
          <button
            type="button"
            onClick={() => {
              setPlacements(placeFleetRandom(Math.random));
              setSelected(null);
            }}
            className="rounded border border-arena-edge px-2 py-1 text-xs text-arena-text hover:bg-arena-edge"
          >
            Randomize
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FLEET.map((ship) => (
          <button
            key={ship.id}
            type="button"
            onClick={() => setSelected(ship.id)}
            className={cn(
              "flex items-center gap-1 rounded border px-2 py-1 text-[11px]",
              selected === ship.id
                ? "border-arena-accent text-arena-accent"
                : "border-arena-edge text-arena-muted hover:text-arena-text",
            )}
          >
            <Check className="size-3 text-emerald-400" />
            {ship.name} · {ship.size}
          </button>
        ))}
      </div>

      <div
        className="mx-auto w-full max-w-[18rem] rounded-md bg-sky-950/30 p-1 ring-1 ring-sky-500/10"
        onPointerLeave={() => setHover(null)}
      >
        <GridFrame
          renderCell={(cell) => {
            const owner = ownerByCell.get(cell);
            const isSelected = owner != null && owner === selected;
            const inPreview = preview?.cells.has(cell) ?? false;
            return (
              <button
                key={cell}
                type="button"
                onClick={() => placeAt(cell)}
                onPointerEnter={() => setHover(cell)}
                className={cn(
                  "aspect-square rounded-[3px] border",
                  inPreview
                    ? preview!.valid
                      ? "border-arena-accent bg-arena-accent/70"
                      : "border-red-500 bg-red-500/60"
                    : owner == null
                      ? "border-sky-400/15 bg-sky-900/40"
                      : isSelected
                        ? "border-arena-accent bg-arena-accent"
                        : "border-slate-500/60 bg-gradient-to-b from-slate-300 to-slate-500 shadow-inner",
                  selected && owner == null && !inPreview && "cursor-pointer",
                )}
              />
            );
          }}
        />
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-arena-muted">
          {legal
            ? selected
              ? "Click to drop the ship; R rotates."
              : "Pick a ship to move it, or just start."
            : "Ships overlap, touch, or hang off-board — adjust or Randomize."}
        </span>
        <button
          type="button"
          disabled={!legal}
          onClick={() => onReady(placements)}
          className="rounded bg-arena-accent px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-40"
        >
          {ctaLabel}
        </button>
      </div>
    </div>
  );
}
