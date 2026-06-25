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
      className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-2 outline-none @[26rem]:gap-3 @[26rem]:p-3"
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
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <span className="sketch-eyebrow text-[clamp(9px,2.4cqmin,14px)] uppercase">
          Place your fleet
        </span>
        <div className="flex gap-1.5">
          <button type="button" onClick={rotate} className="sketch-btn">
            Rotate (R) · {orient === "H" ? "→" : "↓"}
          </button>
          <button
            type="button"
            onClick={() => {
              setPlacements(placeFleetRandom(Math.random));
              setSelected(null);
            }}
            className="sketch-btn"
          >
            Randomize
          </button>
          {/* Start lives top-right (not bottom) so it's always reachable. */}
          <button
            type="button"
            disabled={!legal}
            onClick={() => onReady(placements)}
            className="sketch-btn sketch-btn--go"
          >
            {ctaLabel}
          </button>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap gap-1.5">
        {FLEET.map((ship) => (
          <button
            key={ship.id}
            type="button"
            onClick={() => pickUp(ship.id)}
            className={cn("bs-pill", selected === ship.id && "bs-pill--on")}
          >
            <Check className="size-[1em] text-[var(--sketch-felt)]" />
            {ship.name} · {ship.size}
          </button>
        ))}
      </div>

      {/* The board takes the height left after the header/picker/footer and is the largest
          SQUARE fitting it (container-query units), so the controls never get clipped and the
          window needs no scroll. The 1.25rem trims the fixed A–J label row. */}
      <div className="grid min-h-0 flex-1 place-items-center [container-type:size]">
        <div
          className="bs-board w-[min(100cqw,calc(100cqh_-_1.25rem))] max-w-full"
          onPointerLeave={() => setHover(null)}
        >
          <GridFrame
            renderCell={(cell) => {
              const owner = ownerByCell.get(cell);
              const isOwnerSelected = owner != null && owner === selected;
              // A ship is "lifted" if it is selected and we are hovering somewhere on the board to preview it
              const isLifted = isOwnerSelected && hover !== null;

              const showAsOccupied = owner != null && !isLifted;
              const isSelected =
                owner != null && owner === selected && !isLifted;
              const inPreview = preview?.cells.has(cell) ?? false;

              return (
                <button
                  key={cell}
                  type="button"
                  onClick={() => placeAt(cell)}
                  onPointerEnter={() => setHover(cell)}
                  className={cn(
                    "bs-cell",
                    inPreview
                      ? preview!.valid
                        ? "!border-[var(--sketch-accent)] !bg-[var(--sketch-accent-fill)]"
                        : "!border-[var(--sketch-red)] !bg-[rgba(224,49,49,0.16)]"
                      : showAsOccupied && isSelected
                        ? "!border-[var(--sketch-accent)]"
                        : showAsOccupied
                          ? "border-transparent" // placed ship: inked overlay shows through
                          : "",
                    selected &&
                      !showAsOccupied &&
                      !inPreview &&
                      "cursor-pointer",
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
                        "bs-ship pointer-events-none transition-all duration-150",
                        isSelected && "bs-ship--ghost",
                      )}
                      style={gridStyle}
                    />
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
                    gridColumnEnd:
                      orient === "H" ? col + 2 + size : col + 2 + 1,
                  };

                  return (
                    <div
                      key="preview-ship"
                      className={cn(
                        "bs-ship pointer-events-none transition-all duration-75",
                        preview.valid
                          ? "bs-ship--ok motion-safe:animate-pulse"
                          : "bs-ship--bad",
                      )}
                      style={gridStyle}
                    />
                  );
                })()}
            </>
          </GridFrame>
        </div>
      </div>

      <div className="sketch-note mt-auto shrink-0 text-[clamp(10px,2.4cqmin,14px)]">
        {legal
          ? selected
            ? "Click to drop the ship; R rotates."
            : "Pick a ship to move it, or just start."
          : "Ships overlap, touch, or hang off-board — adjust or Randomize."}
      </div>
    </div>
  );
}
