// Render-layer types + helpers shared by the canvas views (solo engine removed; PvP keeps these).

export type Seat = "A" | "B";

/** Stable cell key for the live canvas map. */
export function cellKey(cx: bigint, cy: bigint, x: number, y: number): string {
  return `${cx}:${cy}:${x}:${y}`;
}

/** A single painted cell retained for rendering (the protocol keeps only a digest). */
export interface PaintedCell {
  cx: bigint;
  cy: bigint;
  x: number;
  y: number;
  color: number;
  /** Which seat laid the most recent paint here. */
  by: Seat;
  /** Monotonic co-signed sequence number of that paint. */
  seq: number;
  /** Display address of the CURRENT painter of this cell (updates on every overpaint). */
  painter: string;
}

/** Running tally for one painter (the human or one seat bot), keyed by display address. */
export interface PainterInfo {
  address: string;
  /** "You" for the human seat, "Bot A" / "Bot B" for the seat bots. */
  label: string;
  isAgent: boolean;
  /** Accent color for leaderboard rows / agent markers. */
  tint: string;
  /** Total cells this painter has co-signed (increments on every paint, incl. overpaint). */
  cells: number;
  /** Co-signed seq of this painter's latest paint (leaderboard tie-break). */
  lastSeq: number;
}

/** A live seat bot's location, surfaced so the canvas can mark + jump to it. */
export interface AgentMarker {
  id: string;
  /** "Bot A" / "Bot B". */
  label: string;
  painter: string;
  /** Name of the design currently being drawn (e.g. "Vietnam" / "Scatter"). */
  flagName: string;
  tint: string;
  /** Global-pixel center of the current design (camera jump + marker anchor). */
  gx: number;
  gy: number;
  /** Current design height in cells (lets the marker anchor just above it). */
  h: number;
}

/** A camera-jump request: center this global-pixel point; `seq` bumps per request. An
 *  optional `scale` overrides the camera zoom on arrival (px per cell); omit to keep the
 *  view's default focus zoom. */
export interface CanvasFocus {
  gx: number;
  gy: number;
  seq: number;
  scale?: number;
}
