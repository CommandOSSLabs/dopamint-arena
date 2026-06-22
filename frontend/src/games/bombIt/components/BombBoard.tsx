import { useEffect, useRef } from "react";
import { GRID_W, GRID_H, CELL_WALL, CELL_CRATE } from "sui-tunnel-ts/protocol/bombIt";
import type { BombItAction } from "sui-tunnel-ts/protocol/bombIt";
import "../bomb-it.css";
import type { BombItView } from "../session-core";

export function BombBoard({
  view,
  winner,
  role,
  onAction,
  onPlayAgain,
  spectate = false,
}: {
  view: BombItView;
  winner: "A" | "B" | "draw" | null;
  role: "A" | "B" | null;
  onAction: (a: BombItAction) => void;
  onPlayAgain: () => void;
  /** Read-only view (bot-vs-bot bench): no human controls, no focus-grab, no Play Again. */
  spectate?: boolean;
}) {
  const settled = winner !== null;
  const boardRef = useRef<HTMLDivElement>(null);

  // Focus the board container on mount so keyboard events are scoped to it (not in spectate mode —
  // a looping bench would otherwise steal focus from the page every game).
  useEffect(() => {
    if (!spectate) boardRef.current?.focus();
  }, [spectate]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (settled) return;
    switch (e.key) {
      case "ArrowUp":
      case "w":
      case "W":
        e.preventDefault();
        onAction("north");
        break;
      case "ArrowDown":
      case "s":
      case "S":
        e.preventDefault();
        onAction("south");
        break;
      case "ArrowRight":
      case "d":
      case "D":
        e.preventDefault();
        onAction("east");
        break;
      case "ArrowLeft":
      case "a":
      case "A":
        e.preventDefault();
        onAction("west");
        break;
      case " ":
      case "Spacebar":
        e.preventDefault();
        onAction("bomb");
        break;
    }
  };

  const bombAt = (r: number, c: number) => view.bombs.some((b) => b.row === r && b.col === c);
  const playerAt = (r: number, c: number): "A" | "B" | null => {
    if (view.players[0]?.alive && view.players[0].row === r && view.players[0].col === c) return "A";
    if (view.players[1]?.alive && view.players[1].row === r && view.players[1].col === c) return "B";
    return null;
  };

  return (
    <div
      ref={boardRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="flex h-full w-full flex-col gap-2 bg-arena-bg p-3 outline-none"
    >
      <div className="flex items-center justify-between text-[11px] text-arena-muted">
        <span>
          {role === "A" ? <span className="font-bold text-gold">🤖 A (you)</span> : <span>🤖 A</span>} · $
          {view.balanceA}
          {view.players[0]?.alive ? "" : " 💀"}
        </span>
        <span>tick {view.tick}</span>
        <span>
          {role === "B" ? <span className="font-bold text-gold">👾 B (you)</span> : <span>👾 B</span>} · $
          {view.balanceB}
          {view.players[1]?.alive ? "" : " 💀"}
        </span>
      </div>

      <div
        className="bomb-grid flex-1 overflow-hidden rounded border border-arena-edge"
        style={{
          gridTemplateColumns: `repeat(${GRID_W}, 1fr)`,
          gridTemplateRows: `repeat(${GRID_H}, 1fr)`,
        }}
      >
        {Array.from({ length: GRID_H }).map((_, r) =>
          Array.from({ length: GRID_W }).map((_, c) => {
            const cell = view.grid[r * GRID_W + c];
            const who = playerAt(r, c);
            const mine = who !== null && who === role;
            let glyph = "";
            if (who === "A") glyph = "🤖";
            else if (who === "B") glyph = "👾";
            else if (bombAt(r, c)) glyph = "💣";
            else if (cell === CELL_CRATE) glyph = "📦";
            const bg = cell === CELL_WALL ? "#3a3a3a" : "#15171c";
            return (
              <div
                key={`${r}-${c}`}
                className={`bomb-cell${mine ? " outline outline-2 outline-amber-400" : ""}`}
                style={{ background: bg }}
              >
                {glyph}
              </div>
            );
          }),
        )}
      </div>

      {!settled && !spectate && (
        <div className="flex flex-col items-center gap-1 py-1">
          <button
            onPointerDown={() => onAction("north")}
            className="rounded border border-arena-edge px-4 py-1 text-xs text-arena-text hover:opacity-80 active:scale-95"
            aria-label="Move north"
          >
            ▲
          </button>
          <div className="flex gap-2">
            <button
              onPointerDown={() => onAction("west")}
              className="rounded border border-arena-edge px-4 py-1 text-xs text-arena-text hover:opacity-80 active:scale-95"
              aria-label="Move west"
            >
              ◀
            </button>
            <button
              onPointerDown={() => onAction("bomb")}
              className="rounded border border-amber-500 bg-arena-accent px-4 py-1 text-xs font-bold text-arena-bg hover:opacity-90 active:scale-95"
              aria-label="Drop bomb"
            >
              💣
            </button>
            <button
              onPointerDown={() => onAction("east")}
              className="rounded border border-arena-edge px-4 py-1 text-xs text-arena-text hover:opacity-80 active:scale-95"
              aria-label="Move east"
            >
              ▶
            </button>
          </div>
          <button
            onPointerDown={() => onAction("south")}
            className="rounded border border-arena-edge px-4 py-1 text-xs text-arena-text hover:opacity-80 active:scale-95"
            aria-label="Move south"
          >
            ▼
          </button>
        </div>
      )}

      {settled && (
        <div className="flex flex-col items-center gap-2 py-1">
          <p className="text-gold text-sm font-bold uppercase tracking-widest">
            {winner === "draw"
              ? "Draw — stakes returned"
              : spectate
                ? `Bomber ${winner} wins the pot`
                : winner === role
                  ? "You win the pot!"
                  : "Opponent wins"}
          </p>
          {!spectate && (
            <button
              onClick={onPlayAgain}
              className="rounded border border-arena-edge px-3 py-1.5 text-sm text-arena-text hover:opacity-90"
            >
              Play Again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
