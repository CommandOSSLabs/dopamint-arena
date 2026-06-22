import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { colorHex } from "../palette";
import type { PlacementEvent } from "../types";
import { DUEL } from "./tokens";

const SEAT_TINT: Record<Party, string> = { A: "#4DA2FF", B: "#CF6EE4" };

/** Recent placements (NIANEZ activity feed, repurposed). Renders plain content
 *  (no glass/position): the caller wraps it in a DraggablePanel that supplies the
 *  glass chrome and draggable positioning. */
export function ActivityFeed({ events }: { events: PlacementEvent[] }) {
  const now = Date.now();
  return (
    <div className="p-3">
      <div
        className="mb-2 text-[11px] font-extrabold uppercase tracking-wider"
        style={{ color: DUEL.muted }}
      >
        Live activity
      </div>
      {events.length === 0 ? (
        <div className="text-xs" style={{ color: DUEL.muted }}>
          No pixels yet.
        </div>
      ) : (
        <ul className="space-y-1">
          {events.slice(0, 12).map((e, i) => (
            <li key={i} className="flex items-center gap-2 text-[11px]">
              <span
                className="h-3 w-3 rounded-sm"
                style={{ background: colorHex(e.color) }}
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
