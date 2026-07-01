/**
 * Adapter from the worker's PvpCell[] render stream to the rich WorldCanvas chrome props (bot
 * markers + the "Most painted" leaderboard) for SOLO self-play. Pure + framework-free so it can be
 * unit-tested without a DOM (the paint-stream fold into `paints` stays in SoloCanvasView, next to
 * the mutable ref it feeds).
 */
import type { PvpCell } from "sui-tunnel-ts/protocol/worldCanvasPvp";
import type { AgentMarker, PainterInfo } from "../useWorldCanvasOnchain";
import { PALETTE, WC } from "./tokens";

/** Stable synthetic painter addresses for the two bot seats (leaderboard keys + View targets). */
export const SEAT_ADDRESS: Record<"A" | "B", string> = {
  A: "bot-a",
  B: "bot-b",
};

const SEAT_TINT: Record<"A" | "B", string> = { A: WC.seatA, B: WC.seatB };

/** The most-recent cell painted by `seat`, or null if that seat hasn't painted yet. */
function latestBy(view: PvpCell[], seat: "A" | "B"): PvpCell | null {
  for (let i = view.length - 1; i >= 0; i--) {
    if (view[i].by === seat) return view[i];
  }
  return null;
}

/**
 * One marker per ACTIVE bot seat, anchored on that seat's most-recent cell (tinted by the color it
 * is currently painting). Seat A is dropped while `auto` is off — you drive it then, so a "flag over
 * yourself" is noise (mirrors the legacy solo, which showed seat B only after a take-over).
 */
export function deriveSoloAgents(view: PvpCell[], auto: boolean): AgentMarker[] {
  const out: AgentMarker[] = [];
  for (const seat of ["A", "B"] as const) {
    if (!auto && seat === "A") continue;
    const c = latestBy(view, seat);
    if (!c) continue;
    out.push({
      id: SEAT_ADDRESS[seat],
      label: `Bot ${seat}`,
      painter: SEAT_ADDRESS[seat],
      flagName: "free-draw",
      tint: PALETTE[c.color] ?? SEAT_TINT[seat],
      gx: c.gx,
      gy: c.gy,
      h: 6,
    });
  }
  return out;
}

/**
 * Per-seat leaderboard tallies keyed by synthetic address. `cells` is the seat's max per-seat
 * `pseq` — a monotonic count that SURVIVES the render cap (which drops the oldest cells), so the
 * board keeps climbing on an endless wall instead of pinning at the cap. `lastSeq` (global order)
 * is the tie-break; `tint` follows the seat's most-recent color.
 */
export function deriveSoloPainters(view: PvpCell[]): Map<string, PainterInfo> {
  const map = new Map<string, PainterInfo>();
  for (const seat of ["A", "B"] as const) {
    let cells = 0;
    let lastSeq = 0;
    let lastColor: number | null = null;
    for (const c of view) {
      if (c.by !== seat) continue;
      if (c.pseq > cells) cells = c.pseq;
      if (c.seq > lastSeq) {
        lastSeq = c.seq;
        lastColor = c.color;
      }
    }
    map.set(SEAT_ADDRESS[seat], {
      address: SEAT_ADDRESS[seat],
      label: `Bot ${seat}`,
      isAgent: true,
      tint: lastColor != null ? (PALETTE[lastColor] ?? SEAT_TINT[seat]) : SEAT_TINT[seat],
      cells,
      lastSeq,
    });
  }
  return map;
}
