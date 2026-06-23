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
        <span className="wal-mono text-[11px] uppercase tracking-wider text-[#cab1ff]">
          Place your fleet
        </span>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={rotate}
            className="rounded-full border border-[#cab1ff]/20 bg-[#cab1ff]/[0.06] px-3 py-1.5 text-xs font-medium text-[#cab1ff] transition-colors hover:border-[#cab1ff]/60 hover:bg-[#cab1ff]/10 active:scale-95"
          >
            Rotate (R) · {orient === "H" ? "→" : "↓"}
          </button>
          <button
            type="button"
            onClick={() => {
              setPlacements(placeFleetRandom(Math.random));
              setSelected(null);
            }}
            className="rounded-full border border-[#cab1ff]/20 bg-[#cab1ff]/[0.06] px-3 py-1.5 text-xs font-medium text-[#cab1ff] transition-colors hover:border-[#cab1ff]/60 hover:bg-[#cab1ff]/10 active:scale-95"
          >
            Randomize
          </button>
          {/* Start lives top-right (not bottom) so it's always reachable. */}
          <button
            type="button"
            disabled={!legal}
            onClick={() => onReady(placements)}
            className="rounded-full bg-[#cab1ff] px-4 py-1.5 text-xs font-semibold text-[#0c0f1d] shadow-[0_0_12px_rgba(202,177,255,0.3)] transition-all hover:bg-[#b79bff] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {ctaLabel}
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
                ? "border-[#cab1ff] bg-[#cab1ff]/10 text-[#cab1ff] shadow-[0_0_8px_rgba(202,177,255,0.2)]"
                : "border-[#cab1ff]/15 text-[#cab1ff]/55 hover:border-[#cab1ff]/40 hover:text-[#cab1ff]",
            )}
          >
            <Check className="size-3 text-[#9cefcf]" />
            {ship.name} · {ship.size}
          </button>
        ))}
      </div>

      {/* Size the board to the height LEFT OVER after the header/roster/footer
          (~12rem of chrome) so a short window never clips the controls — the
          parent is overflow-hidden — while a tall phone still fills the width. */}
      <div
        className="mx-auto w-full max-w-[min(100%,calc(100cqh_-_12rem))] rounded-lg bg-slate-950/40 p-1.5 ring-1 ring-[#cab1ff]/20 shadow-lg backdrop-blur-md"
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
                      ? "border-[#cab1ff] bg-[#cab1ff]/20"
                      : "border-[#fb7185] bg-[#fb7185]/20"
                    : !showAsOccupied
                      ? "border-[#cab1ff]/10 bg-[#cab1ff]/[0.04] hover:border-[#cab1ff]/30"
                      : isSelected
                        ? "border-[#cab1ff] bg-[#cab1ff]/[0.08] shadow-[0_0_8px_rgba(202,177,255,0.3)]"
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
                        ? "opacity-60 shadow-[0_0_8px_rgba(202,177,255,0.2)]"
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
                        ? "opacity-75 animate-pulse shadow-[0_0_12px_rgba(202,177,255,0.4)]"
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

      <div className="mt-auto text-[11px] text-arena-muted">
        {legal
          ? selected
            ? "Click to drop the ship; R rotates."
            : "Pick a ship to move it, or just start."
          : "Ships overlap, touch, or hang off-board — adjust or Randomize."}
      </div>
    </div>
  );
}
