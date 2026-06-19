import { useEffect, useRef } from "react";
import type { CrossDir } from "sui-tunnel-ts/protocol/cross";
import "../cross.css";
import type { CrossView } from "../session-core";
import { CrossCanvas } from "./CrossCanvas.tsx";

export function CrossBoard({
  view,
  winner,
  role,
  onDir,
  onPlayAgain,
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

      <CrossCanvas view={view} role={role} winner={winner} onDir={onDir} />

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
