import { laneKind, hazardsAt, spanCoversCol, COLUMN_COUNT, WIN_LANE } from "sui-tunnel-ts/protocol/cross";
import "../cross.css";
import type { CrossView, SessionResult } from "../session-core";

const LANE_BG: Record<string, string> = {
  grass: "#1f3b1f",
  road: "#2b2b2b",
  water: "#16324a",
  rails: "#3a2f1a",
};

/** A small window of lanes around the leader, drawn top = forward. */
function visibleLanes(view: CrossView): number[] {
  const lead = Math.max(view.players[0]?.lane ?? 0, view.players[1]?.lane ?? 0);
  const min = Math.max(0, lead - 3);
  const max = Math.min(WIN_LANE, lead + 7);
  const out: number[] = [];
  for (let L = max; L >= min; L--) out.push(L); // forward at the top
  return out;
}

export function CrossBoard({
  view,
  result,
  settled,
  onPlayAgain,
  seed,
}: {
  view: CrossView;
  result: SessionResult | null;
  settled: boolean;
  onPlayAgain: () => void;
  seed: number;
}) {
  const lanes = visibleLanes(view);
  return (
    <div className="flex h-full w-full flex-col gap-2 bg-arena-bg p-3">
      <div className="flex items-center justify-between text-[11px] text-arena-muted">
        <span>🐔 A · lane {view.players[0]?.lane ?? 0} · ${view.balanceA}</span>
        <span>tick {view.tick}</span>
        <span>🐔 B · lane {view.players[1]?.lane ?? 0} · ${view.balanceB}</span>
      </div>

      <div className="cross-grid flex-1 overflow-hidden rounded border border-arena-edge">
        {lanes.map((L) => {
          const kind = laneKind(L);
          const hazards = hazardsAt(BigInt(seed), L, BigInt(view.tick));
          return (
            <div key={L} className="cross-lane" style={{ background: LANE_BG[kind] }}>
              {Array.from({ length: COLUMN_COUNT }).map((_, col) => {
                const onHaz = hazards.some((s) => spanCoversCol(s, col));
                const aHere = view.players[0]?.lane === L && view.players[0]?.col === col;
                const bHere = view.players[1]?.lane === L && view.players[1]?.col === col;
                const haz = onHaz ? (kind === "road" ? "🚗" : kind === "rails" ? "🚆" : "🪵") : "";
                return (
                  <div key={col} className="cross-cell">
                    {aHere ? "🐔" : bHere ? "🐤" : haz}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {settled && (
        <div className="flex flex-col items-center gap-2 py-1">
          <p className="text-gold text-sm font-bold uppercase tracking-widest">
            {result === "push" ? "Push — stakes returned" : `Chicken ${result} wins the pot!`}
          </p>
          <button
            onClick={onPlayAgain}
            className="rounded border border-arena-edge px-3 py-1.5 text-sm text-arena-text hover:opacity-90"
          >
            Play Again
          </button>
        </div>
      )}
    </div>
  );
}
