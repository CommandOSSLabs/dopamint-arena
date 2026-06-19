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
import { ShipSprite } from "./ShipSprite";

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

  // Pick up a ship for moving, syncing the orientation toggle to that ship's
  // CURRENT orientation — otherwise the stale global toggle would flip it.
  const pickUp = (id: string) => {
    const p = placements.find((pl) => pl.id === id);
    if (p) setOrient(p.orient);
    setSelected(id);
  };

  const placeAt = (cell: number) => {
    if (!selected) {
      // No ship picked up: clicking a placed ship picks it up.
      const owner = ownerByCell.get(cell);
      if (owner) pickUp(owner);
      return;
    }
    // A ship is picked up: only drop on a legal spot; an illegal click is ignored
    // (the red preview already signals it) so the ship stays in hand.
    const candidate = placements.map((p) =>
      p.id === selected ? { id: selected, cell, orient } : p,
    );
    if (placementCells({ id: selected, cell, orient }) === null) return;
    if (!fleetIsLegal(candidate)) return;
    setPlacements(candidate);
    // Drop complete → back to the normal, nothing-selected state.
    setSelected(null);
    setHover(null);
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
        } else if (e.key === "Escape" && selected) {
          e.preventDefault();
          setSelected(null); // drop the picked-up ship without moving it
          setHover(null);
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-cyan-400">
          Place your fleet
        </span>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={rotate}
            className="rounded-full border border-cyan-500/20 bg-cyan-950/20 px-3 py-1 text-xs text-cyan-400 hover:bg-cyan-500/10 hover:border-cyan-400 transition-colors"
          >
            Rotate (R) · {orient === "H" ? "→" : "↓"}
          </button>
          <button
            type="button"
            onClick={() => {
              setPlacements(placeFleetRandom(Math.random));
              setSelected(null);
            }}
            className="rounded-full border border-cyan-500/20 bg-cyan-950/20 px-3 py-1 text-xs text-cyan-400 hover:bg-cyan-500/10 hover:border-cyan-400 transition-colors"
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
            onClick={() => pickUp(ship.id)}
            className={cn(
              "flex items-center gap-1 rounded-full border px-3 py-1 text-[11px] transition-all duration-150",
              selected === ship.id
                ? "border-cyan-400 bg-cyan-400/10 text-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.2)]"
                : "border-cyan-500/10 text-cyan-500/60 hover:text-cyan-400 hover:border-cyan-500/30",
            )}
          >
            <Check className="size-3 text-emerald-400" />
            {ship.name} · {ship.size}
          </button>
        ))}
      </div>

      <div
        className="mx-auto w-full max-w-[18rem] rounded-lg bg-slate-950/40 p-1.5 ring-1 ring-cyan-500/20 shadow-lg backdrop-blur-md"
        onPointerLeave={() => setHover(null)}
      >
        <GridFrame
          renderCell={(cell) => {
            const owner = ownerByCell.get(cell);
            const isOwnerSelected = owner != null && owner === selected;
            // A ship is "lifted" if it is selected and we are hovering somewhere on the board to preview it
            const isLifted = isOwnerSelected && hover !== null;

            const showAsOccupied = owner != null && !isLifted;
            const isSelected = owner != null && owner === selected && !isLifted;
            const inPreview = preview?.cells.has(cell) ?? false;

            return (
              <button
                key={cell}
                type="button"
                onClick={() => placeAt(cell)}
                onPointerEnter={() => setHover(cell)}
                className={cn(
                  "aspect-square rounded-[4px] border relative transition-all duration-150 overflow-hidden z-20",
                  inPreview
                    ? preview!.valid
                      ? "border-cyan-400 bg-cyan-500/20"
                      : "border-red-500 bg-red-500/20"
                    : !showAsOccupied
                      ? "border-cyan-500/10 bg-cyan-950/20 hover:border-cyan-500/30"
                      : isSelected
                        ? "border-cyan-400 bg-cyan-950/50 shadow-[0_0_8px_rgba(34,211,238,0.3)]"
                        : "border-transparent bg-transparent", // Placed ship is transparent
                  selected && !showAsOccupied && !inPreview && "cursor-pointer",
                )}
              />
            );
          }}
        >
          {/* Continuous Ship Overlays */}
          <>
            {/* Placed ships (hide selected ship if it's currently floating in preview) */}
            {placements
              .filter((p) => p.id !== selected || hover === null)
              .map((p) => {
                const row = Math.floor(p.cell / 10);
                const col = p.cell % 10;
                const spec = FLEET.find((s) => s.id === p.id);
                if (!spec) return null;
                const size = spec.size;

                const gridStyle = {
                  gridRowStart: row + 2,
                  gridColumnStart: col + 2,
                  gridRowEnd: p.orient === "V" ? row + 2 + size : row + 2 + 1,
                  gridColumnEnd:
                    p.orient === "H" ? col + 2 + size : col + 2 + 1,
                };

                const isSelected = p.id === selected;

                return (
                  <div
                    key={p.id}
                    className={cn(
                      "pointer-events-none relative overflow-hidden transition-all duration-150",
                      isSelected
                        ? "opacity-60 shadow-[0_0_8px_rgba(34,211,238,0.2)]"
                        : "opacity-95",
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

            {/* Hover preview ship */}
            {selected &&
              hover !== null &&
              preview &&
              (() => {
                const row = Math.floor(hover / 10);
                const col = hover % 10;
                const spec = FLEET.find((s) => s.id === selected);
                if (!spec) return null;
                const size = spec.size;

                const inBounds =
                  placementCells({ id: selected, cell: hover, orient }) !==
                  null;
                if (!inBounds) return null; // do not render overlay if it overflows board edge

                const gridStyle = {
                  gridRowStart: row + 2,
                  gridColumnStart: col + 2,
                  gridRowEnd: orient === "V" ? row + 2 + size : row + 2 + 1,
                  gridColumnEnd: orient === "H" ? col + 2 + size : col + 2 + 1,
                };

                return (
                  <div
                    key="preview-ship"
                    className={cn(
                      "pointer-events-none relative overflow-hidden transition-all duration-75",
                      preview.valid
                        ? "opacity-75 animate-pulse shadow-[0_0_12px_rgba(34,211,238,0.4)]"
                        : "opacity-45 grayscale brightness-50",
                    )}
                    style={gridStyle}
                  >
                    <ShipSprite
                      id={selected}
                      size={size}
                      horizontal={orient === "H"}
                    />
                  </div>
                );
              })()}
          </>
        </GridFrame>
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-cyan-500/60">
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
          className="rounded-full bg-cyan-400 px-4 py-1.5 text-sm font-semibold text-black disabled:opacity-40 hover:bg-cyan-300 transition-colors shadow-[0_0_12px_rgba(34,211,238,0.3)]"
        >
          {ctaLabel}
        </button>
      </div>
    </div>
  );
}
