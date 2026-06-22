import { useEffect, useRef } from "react";
import { laneKind, hazardsAt, spanCoversCol, COLUMN_COUNT, WIN_LANE } from "sui-tunnel-ts/protocol/cross";
import type { CrossDir } from "sui-tunnel-ts/protocol/cross";
import "../cross.css";
import type { CrossView } from "../session-core";

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
  stake,
  done = false,
  auto = false,
  onToggleAuto,
}: {
  view: CrossView;
  winner: "A" | "B" | null;
  /** Seat the human controls, or null when spectating a bot-vs-bot self-play race. */
  role: "A" | "B" | null;
  onDir: (d: CrossDir) => void;
  onPlayAgain: () => void;
  seed: number;
  /** Per-seat stake (MIST); surfaced in the outcome banner as the on-chain payout. */
  stake: number;
  /** Settled with no winner = a push (tick-cap draw); the view's winner stays null. */
  done?: boolean;
  /** Auto/autopilot: when true a bot steers this chicken; hides controls + ignores keyboard. */
  auto?: boolean;
  /** When provided, renders the Auto/Manual toggle pill. */
  onToggleAuto?: () => void;
}) {
  const settled = winner !== null || done;
  const spectating = role === null;
  const canPlay = !spectating && !auto;
  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (canPlay) boardRef.current?.focus();
  }, [canPlay]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (settled || !canPlay) return;
    switch (e.key) {
      case "ArrowUp": case "w": case "W": e.preventDefault(); onDir("north"); break;
      case "ArrowDown": case "s": case "S": e.preventDefault(); onDir("south"); break;
      case "ArrowRight": case "d": case "D": e.preventDefault(); onDir("east"); break;
      case "ArrowLeft": case "a": case "A": e.preventDefault(); onDir("west"); break;
    }
  };

  const lanes = visibleLanes(view);
  const myIndex = role === "A" ? 0 : role === "B" ? 1 : null;
  const won = !spectating && winner === role;
  const celebratory = winner !== null && (spectating || won);

  const title = () => {
    if (winner === null) return "Draw";
    if (spectating) return winner === "A" ? "🐔 Bot A wins" : "🐤 Bot B wins";
    return won ? "You win!" : "Opponent wins";
  };
  const sub = () => {
    if (winner === null) return "Stakes returned";
    return won || spectating ? `+$${stake} on-chain` : `−$${stake} on-chain`;
  };

  return (
    <div ref={boardRef} tabIndex={canPlay ? 0 : -1} onKeyDown={handleKeyDown} className="cross-root outline-none">
      <div className="cross-hud">
        <div className="cross-seat">
          <span className="cross-seat__badge cross-seat__badge--a">🐔</span>
          <span className="cross-seat__meta">
            <span className="cross-seat__name">{spectating ? "Bot A" : role === "A" ? "A · you" : "A"}</span>
            <span className="cross-seat__stat wal-doto text-gold">L{view.players[0]?.lane ?? 0}</span>
          </span>
        </div>

        <div className="cross-hud__center">
          <span className="cross-hud__tick wal-doto">{view.tick}</span>
          <span className="cross-hud__live">ticks</span>
        </div>

        <div className="cross-seat cross-seat--right">
          <span className="cross-seat__badge cross-seat__badge--b">🐤</span>
          <span className="cross-seat__meta">
            <span className="cross-seat__name">{spectating ? "Bot B" : role === "B" ? "B · you" : "B"}</span>
            <span className="cross-seat__stat wal-doto text-gold">L{view.players[1]?.lane ?? 0}</span>
          </span>
        </div>
      </div>

      <div className="cross-grid">
        {lanes.map((L) => {
          const kind = laneKind(L);
          const hazards = hazardsAt(BigInt(seed), L, BigInt(view.tick));
          return (
            <div key={L} className={`cross-lane cross-lane--${kind}`}>
              {Array.from({ length: COLUMN_COUNT }).map((_, col) => {
                const onHaz = hazards.some((s) => spanCoversCol(s, col));
                const aHere = view.players[0]?.lane === L && view.players[0]?.col === col;
                const bHere = view.players[1]?.lane === L && view.players[1]?.col === col;
                const here = aHere || bHere;
                const isMine = (aHere && myIndex === 0) || (bHere && myIndex === 1);
                const hit = onHaz && here;
                const hazGlyph = onHaz ? (kind === "road" ? "🚗" : kind === "rails" ? "🚆" : "🪵") : "";
                return (
                  <div key={col} className="cross-cell">
                    {here ? (
                      <span
                        key={`${L}-${col}-${hit ? "hit" : "ok"}`}
                        className={`cross-chick cross-chick--${aHere ? "a" : "b"}${isMine ? " cross-chick--mine" : ""}${hit ? " cross-chick--hit" : ""}`}
                      >
                        {aHere ? "🐔" : "🐤"}
                      </span>
                    ) : onHaz ? (
                      <span className={`cross-haz cross-haz--${kind}`}>{hazGlyph}</span>
                    ) : (
                      ""
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {!settled && canPlay && (
        <div className="cross-controls">
          <button className="cross-btn" onPointerDown={() => onDir("north")} aria-label="Move north">▲</button>
          <div className="flex gap-1">
            <button className="cross-btn" onPointerDown={() => onDir("west")} aria-label="Move west">◀</button>
            <button className="cross-btn" onPointerDown={() => onDir("south")} aria-label="Move south">▼</button>
            <button className="cross-btn" onPointerDown={() => onDir("east")} aria-label="Move east">▶</button>
          </div>
        </div>
      )}

      {onToggleAuto && !settled && (
        <button
          className={`arena-auto${auto ? " arena-auto--on" : ""}`}
          onClick={onToggleAuto}
          title={auto ? "Bot is racing for you — click to take over" : "You're racing — click to autopilot"}
        >
          {auto ? "🤖 Auto" : "✋ Manual"}
        </button>
      )}

      {!settled && spectating && <p className="cross-spectate">Bot vs bot · co-signing every tick on-chain</p>}

      {settled && (
        <div className="cross-result">
          {celebratory && <div className="cross-result__trophy">🏆</div>}
          <div className={`cross-result__line wal-doto ${celebratory ? "text-gold" : "text-arena-text"}`}>{title()}</div>
          <div className="cross-result__sub">{sub()}</div>
          <button className="cross-play-again" onClick={onPlayAgain}>Play Again</button>
        </div>
      )}
    </div>
  );
}
