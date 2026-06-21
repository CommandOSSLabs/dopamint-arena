import { cn } from "@/lib/utils";
import type { ShipStatus } from "../engine/fleet";

/** Your fleet's ships with per-cell damage pips: steel = intact, amber = hit, red = sunk. */
export function FleetRoster({ fleet }: { fleet: ShipStatus[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px]">
      {fleet.map((s) => (
        <div
          key={s.id}
          className={cn(
            "flex items-center gap-1.5 font-medium tracking-wide",
            s.sunk
              ? "text-red-400 drop-shadow-[0_0_2px_rgba(248,113,113,0.3)]"
              : "text-cyan-400/70",
          )}
        >
          <span
            className={cn(
              "hidden @[22rem]:inline",
              s.sunk && "line-through opacity-60",
            )}
          >
            {s.name}
          </span>
          <span className="flex gap-[2px]">
            {Array.from({ length: s.size }).map((_, i) => (
              <span
                key={i}
                className={cn(
                  "h-2 w-1.5 rounded-[1px] transition-all duration-300",
                  s.sunk
                    ? "bg-red-500 shadow-[0_0_4px_rgba(239,68,68,0.6)]"
                    : i < s.hits
                      ? "bg-amber-400 shadow-[0_0_4px_rgba(251,191,36,0.6)] animate-pulse"
                      : "bg-cyan-500/40 border border-cyan-400/20 shadow-[0_0_2px_rgba(6,182,212,0.2)]",
                )}
              />
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
