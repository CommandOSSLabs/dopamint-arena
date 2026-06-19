import { cn } from "@/lib/utils";
import type { ShipStatus } from "../engine/fleet";

/** Your fleet's ships with per-cell damage pips: steel = intact, amber = hit, red = sunk. */
export function FleetRoster({ fleet }: { fleet: ShipStatus[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
      {fleet.map((s) => (
        <div
          key={s.id}
          className={cn(
            "flex items-center gap-1",
            s.sunk ? "text-red-400" : "text-arena-muted",
          )}
        >
          <span
            className={cn("hidden @[22rem]:inline", s.sunk && "line-through")}
          >
            {s.name}
          </span>
          <span className="flex gap-px">
            {Array.from({ length: s.size }).map((_, i) => (
              <span
                key={i}
                className={cn(
                  "size-1.5 rounded-[1px]",
                  s.sunk
                    ? "bg-red-500/80"
                    : i < s.hits
                      ? "bg-amber-400"
                      : "bg-slate-400/70",
                )}
              />
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
