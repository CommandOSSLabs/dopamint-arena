import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { colorHex } from "../palette";
import type { PlacementEvent } from "../types";
import { DUEL, FONT_MONO } from "./tokens";

const SEAT_TINT: Record<Party, string> = { A: "#4DA2FF", B: "#CF6EE4" };

/** Recent placements (NIANEZ activity feed, repurposed). Renders plain content
 *  (no glass/position): the caller wraps it in a DraggablePanel that supplies the
 *  glass chrome and draggable positioning. */
export function ActivityFeed({ events }: { events: PlacementEvent[] }) {
  const now = Date.now();
  return (
    <div className="p-3.5">
      <div
        className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em]"
        style={{ color: DUEL.muted }}
      >
        Live activity
      </div>
      {events.length === 0 ? (
        <div className="text-xs" style={{ color: DUEL.muted }}>
          No pixels yet.
        </div>
      ) : (
        <ul className="space-y-0.5">
          {events.slice(0, 12).map((e, i) => (
            <li
              key={i}
              className="flex items-center gap-2 py-px text-[11px]"
              style={{ fontFamily: FONT_MONO }}
            >
              <span
                className="h-[11px] w-[11px] flex-none rounded-[3px]"
                style={{
                  background: colorHex(e.color),
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.15)",
                }}
              />
              <span
                className="font-bold tabular-nums"
                style={{ color: SEAT_TINT[e.by] }}
              >
                {e.by}
              </span>
              <span className="tabular-nums" style={{ color: DUEL.text }}>
                ({e.x},{e.y})
              </span>
              <span
                className="ml-auto tabular-nums"
                style={{ color: DUEL.muted }}
              >
                {ago(now - e.t)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ago(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 1) return "now";
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
}
