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
              ? "text-[#fb7185] drop-shadow-[0_0_2px_rgba(251,113,133,0.3)]"
              : "text-[#cab1ff]/70",
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
                    ? "bg-[#fb7185] shadow-[0_0_4px_rgba(251,113,133,0.6)]"
                    : i < s.hits
                      ? "bg-[#eaff80] shadow-[0_0_4px_rgba(234,255,128,0.6)] animate-pulse"
                      : "bg-[#cab1ff]/40 border border-[#cab1ff]/20 shadow-[0_0_2px_rgba(202,177,255,0.2)]",
                )}
              />
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
