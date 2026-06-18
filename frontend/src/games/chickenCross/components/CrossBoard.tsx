import { useEffect, useRef } from "react";
import { laneKind, hazardsAt, spanCoversCol, COLUMN_COUNT, WIN_LANE } from "sui-tunnel-ts/protocol/cross";
import type { CrossDir } from "sui-tunnel-ts/protocol/cross";
import "../cross.css";
import type { CrossView } from "../session-core";

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
  winner,
  role,
  onDir,
  onPlayAgain,
  seed,
}: {
  view: CrossView;
  winner: "A" | "B" | null;
  role: "A" | "B" | null;
  onDir: (d: CrossDir) => void;
  onPlayAgain: () => void;
  seed: number;
}) {
  const settled = winner !== null;
  const boardRef = useRef<HTMLDivElement>(null);

  // Focus the board container on mount so keyboard events are scoped to it.
  useEffect(() => {
    boardRef.current?.focus();
  }, []);

  // Keyboard handler — Arrow/WASD → directions. Ignored when the game is over.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (winner !== null) return;
    switch (e.key) {
      case "ArrowUp":
      case "w":
      case "W":
        e.preventDefault();
        onDir("north");
        break;
      case "ArrowDown":
      case "s":
      case "S":
        e.preventDefault();
        onDir("south");
        break;
      case "ArrowRight":
      case "d":
      case "D":
        e.preventDefault();
        onDir("east");
        break;
      case "ArrowLeft":
      case "a":
      case "A":
        e.preventDefault();
        onDir("west");
        break;
    }
  };

  const lanes = visibleLanes(view);
  const myIndex = role === "A" ? 0 : role === "B" ? 1 : null;

  return (
    <div
      ref={boardRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="flex h-full w-full flex-col gap-2 bg-arena-bg p-3 outline-none"
    >
      <div className="flex items-center justify-between text-[11px] text-arena-muted">
        <span>
          {role === "A" ? (
            <span className="font-bold text-gold">🐔 A (you)</span>
          ) : (
            <span>🐔 A</span>
          )}{" "}
          · lane {view.players[0]?.lane ?? 0} · ${view.balanceA}
        </span>
        <span>tick {view.tick}</span>
        <span>
          {role === "B" ? (
            <span className="font-bold text-gold">🐤 B (you)</span>
          ) : (
            <span>🐤 B</span>
          )}{" "}
          · lane {view.players[1]?.lane ?? 0} · ${view.balanceB}
        </span>
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
                // Highlight this seat's chicken with a ring
                const isMine = (aHere && myIndex === 0) || (bHere && myIndex === 1);
                return (
                  <div
                    key={col}
                    className={`cross-cell${isMine ? " outline outline-2 outline-amber-400 rounded" : ""}`}
                  >
                    {aHere ? "🐔" : bHere ? "🐤" : haz}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* On-screen D-pad for mobile / click */}
      {!settled && (
        <div className="flex flex-col items-center gap-1 py-1">
          <button
            onPointerDown={() => onDir("north")}
            className="rounded border border-arena-edge px-4 py-1 text-xs text-arena-text hover:opacity-80 active:scale-95"
            aria-label="Move north"
          >
            ▲
          </button>
          <div className="flex gap-2">
            <button
              onPointerDown={() => onDir("west")}
              className="rounded border border-arena-edge px-4 py-1 text-xs text-arena-text hover:opacity-80 active:scale-95"
              aria-label="Move west"
            >
              ◀
            </button>
            <button
              onPointerDown={() => onDir("south")}
              className="rounded border border-arena-edge px-4 py-1 text-xs text-arena-text hover:opacity-80 active:scale-95"
              aria-label="Move south"
            >
              ▼
            </button>
            <button
              onPointerDown={() => onDir("east")}
              className="rounded border border-arena-edge px-4 py-1 text-xs text-arena-text hover:opacity-80 active:scale-95"
              aria-label="Move east"
            >
              ▶
            </button>
          </div>
        </div>
      )}

      {settled && (
        <div className="flex flex-col items-center gap-2 py-1">
          <p className="text-gold text-sm font-bold uppercase tracking-widest">
            {winner === role
              ? "You win the pot!"
              : winner !== null
                ? "Opponent wins"
                : ""}
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
