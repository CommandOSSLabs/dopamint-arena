import { memo, useEffect, useRef, useState } from "react";
import {
  GRID_W,
  GRID_H,
  CELL_WALL,
  CELL_CRATE,
  blastCellsFor,
} from "sui-tunnel-ts/protocol/bombIt";
import type { BombItAction } from "sui-tunnel-ts/protocol/bombIt";
import "../bomb-it.css";
import type { BombItView } from "../session-core";

/** A short-lived explosion drawn over the cells a detonating bomb covered. */
interface Blast {
  id: number;
  cells: number[];
}

/**
 * Static terrain layer (29×29 = 841 cells). Memoized on grid CONTENT so it doesn't re-render
 * on every animation frame — the grid only changes when a crate is destroyed, while pieces and
 * blasts (a handful of nodes) repaint each frame on the overlay above it.
 */
const BombTerrain = memo(
  function BombTerrain({ grid }: { grid: number[] }) {
    return (
      <div
        className="bomb-grid"
        style={{
          gridTemplateColumns: `repeat(${GRID_W}, 1fr)`,
          gridTemplateRows: `repeat(${GRID_H}, 1fr)`,
        }}
      >
        {grid.map((cell, i) => {
          const kind = cell === CELL_WALL ? "wall" : cell === CELL_CRATE ? "crate" : "floor";
          return (
            <div key={i} className={`bomb-cell bomb-cell--${kind}`}>
              {cell === CELL_CRATE ? "📦" : ""}
            </div>
          );
        })}
      </div>
    );
  },
  (a, b) => a.grid.length === b.grid.length && a.grid.every((v, i) => v === b.grid[i]),
);

export function BombBoard({
  view,
  winner,
  role,
  onAction,
  onPlayAgain,
  stake,
  auto = false,
  onToggleAuto,
}: {
  view: BombItView;
  winner: "A" | "B" | "draw" | null;
  /** Seat the human controls, or null when spectating a bot-vs-bot self-play match. */
  role: "A" | "B" | null;
  onAction: (a: BombItAction) => void;
  onPlayAgain: () => void;
  /** Per-seat stake (won/lost on settle); surfaced in the outcome banner. */
  stake: number;
  /** Auto/autopilot: when true a bot drives this seat; hides controls + ignores keyboard. */
  auto?: boolean;
  /** When provided, renders the Auto/Manual toggle pill. */
  onToggleAuto?: () => void;
}) {
  const settled = winner !== null;
  const spectating = role === null;
  const canPlay = !spectating && !auto;
  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (canPlay) boardRef.current?.focus();
  }, [canPlay]);

  // Detect bomb detonations by diffing the previous tick's bombs/grid, then flash the exact
  // blast cells the protocol cleared (replayed via blastCellsFor on the pre-blast grid).
  const prevBombsRef = useRef<BombItView["bombs"]>([]);
  const prevGridRef = useRef<number[]>(view.grid);
  const blastSeq = useRef(0);
  const blastTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const [blasts, setBlasts] = useState<Blast[]>([]);

  useEffect(() => {
    const detonated = prevBombsRef.current.filter(
      (pb) => !view.bombs.some((b) => b.row === pb.row && b.col === pb.col),
    );
    if (detonated.length > 0) {
      const grid = Uint8Array.from(prevGridRef.current);
      const cells = new Set<number>();
      for (const b of detonated) for (const ci of blastCellsFor(grid, { ...b, fuse: 0 })) cells.add(ci);
      const id = blastSeq.current++;
      setBlasts((prev) => [...prev, { id, cells: [...cells] }]);
      const t = setTimeout(() => {
        blastTimers.current.delete(t);
        setBlasts((prev) => prev.filter((x) => x.id !== id));
      }, 440);
      blastTimers.current.add(t);
    }
    prevBombsRef.current = view.bombs;
    prevGridRef.current = view.grid;
  }, [view]);

  useEffect(() => {
    const timers = blastTimers.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (settled || !canPlay) return;
    switch (e.key) {
      case "ArrowUp": case "w": case "W": e.preventDefault(); onAction("north"); break;
      case "ArrowDown": case "s": case "S": e.preventDefault(); onAction("south"); break;
      case "ArrowRight": case "d": case "D": e.preventDefault(); onAction("east"); break;
      case "ArrowLeft": case "a": case "A": e.preventDefault(); onAction("west"); break;
      case " ": case "Spacebar": e.preventDefault(); onAction("bomb"); break;
    }
  };

  const aDead = !view.players[0]?.alive;
  const bDead = !view.players[1]?.alive;
  const won = !spectating && winner === role;
  const celebratory = winner !== "draw" && winner !== null && (spectating || won);

  const title = () => {
    if (winner === "draw") return "Draw";
    if (spectating) return winner === "A" ? "🤖 Bot A wins" : "👾 Bot B wins";
    return won ? "You win!" : "Opponent wins";
  };
  const sub = () => {
    if (winner === "draw") return "Stakes returned";
    return won || spectating ? `+$${stake} on-chain` : `−$${stake} on-chain`;
  };

  return (
    <div
      ref={boardRef}
      tabIndex={canPlay ? 0 : -1}
      onKeyDown={handleKeyDown}
      className="bomb-root outline-none"
    >
      <div className="bomb-hud">
        <div className="bomb-seat">
          <span className={`bomb-seat__badge bomb-seat__badge--a${aDead ? " bomb-seat__badge--dead" : ""}`}>🤖</span>
          <span className="bomb-seat__meta">
            <span className="bomb-seat__name">{spectating ? "Bot A" : role === "A" ? "A · you" : "A"}{aDead ? " 💀" : ""}</span>
            <span className="bomb-seat__bal wal-doto text-gold">${view.balanceA}</span>
          </span>
        </div>

        <div className="bomb-hud__center">
          <span className="bomb-hud__tick wal-doto">{view.tick}</span>
          <span className="bomb-hud__live">ticks</span>
        </div>

        <div className="bomb-seat bomb-seat--right">
          <span className={`bomb-seat__badge bomb-seat__badge--b${bDead ? " bomb-seat__badge--dead" : ""}`}>👾</span>
          <span className="bomb-seat__meta">
            <span className="bomb-seat__name">{spectating ? "Bot B" : role === "B" ? "B · you" : "B"}{bDead ? " 💀" : ""}</span>
            <span className="bomb-seat__bal wal-doto text-gold">${view.balanceB}</span>
          </span>
        </div>
      </div>

      <div
        className="bomb-stage"
        style={{ ["--gw" as string]: GRID_W, ["--gh" as string]: GRID_H } as React.CSSProperties}
      >
        <BombTerrain grid={view.grid} />

        <div className="bomb-overlay">
          {view.players[0]?.alive && (
            <div
              key="pA"
              className="bomb-piece"
              style={{ ["--r" as string]: view.players[0].row, ["--c" as string]: view.players[0].col } as React.CSSProperties}
            >
              <span className={`bomb-piece__glyph bomb-piece__glyph--a${role === "A" ? " bomb-piece__glyph--mine" : ""}`}>🤖</span>
            </div>
          )}
          {view.players[1]?.alive && (
            <div
              key="pB"
              className="bomb-piece"
              style={{ ["--r" as string]: view.players[1].row, ["--c" as string]: view.players[1].col } as React.CSSProperties}
            >
              <span className={`bomb-piece__glyph bomb-piece__glyph--b${role === "B" ? " bomb-piece__glyph--mine" : ""}`}>👾</span>
            </div>
          )}
          {view.bombs.map((b) => (
            <div
              key={`bomb-${b.owner}`}
              className="bomb-piece"
              style={{ ["--r" as string]: b.row, ["--c" as string]: b.col } as React.CSSProperties}
            >
              <span className="bomb-piece__glyph bomb-piece__glyph--bomb">💣</span>
            </div>
          ))}
          {blasts.map((bl) =>
            bl.cells.map((ci) => (
              <div
                key={`${bl.id}-${ci}`}
                className="bomb-blast"
                style={{ ["--r" as string]: Math.floor(ci / GRID_W), ["--c" as string]: ci % GRID_W } as React.CSSProperties}
              >
                <span className="bomb-blast__ring" />
                <span className="bomb-blast__core" />
              </div>
            )),
          )}
        </div>
      </div>

      {!settled && canPlay && (
        <div className="bomb-controls">
          <button className="bomb-btn" onPointerDown={() => onAction("north")} aria-label="Move north">▲</button>
          <div className="flex gap-1">
            <button className="bomb-btn" onPointerDown={() => onAction("west")} aria-label="Move west">◀</button>
            <button className="bomb-btn bomb-btn--bomb" onPointerDown={() => onAction("bomb")} aria-label="Drop bomb">💣</button>
            <button className="bomb-btn" onPointerDown={() => onAction("east")} aria-label="Move east">▶</button>
          </div>
          <button className="bomb-btn" onPointerDown={() => onAction("south")} aria-label="Move south">▼</button>
        </div>
      )}

      {onToggleAuto && !settled && (
        <button
          className={`arena-auto${auto ? " arena-auto--on" : ""}`}
          onClick={onToggleAuto}
          title={auto ? "Bot is playing for you — click to take over" : "You're playing — click to autopilot"}
        >
          {auto ? "🤖 Auto" : "✋ Manual"}
        </button>
      )}

      {!settled && spectating && <p className="bomb-spectate">Bot vs bot · co-signing every tick on-chain</p>}

      {settled && (
        <div className="bomb-result">
          {celebratory && <div className="bomb-result__trophy">🏆</div>}
          <div className={`bomb-result__line wal-doto ${celebratory ? "text-gold" : "text-arena-text"}`}>{title()}</div>
          <div className="bomb-result__sub">{sub()}</div>
          <button className="bomb-play-again" onClick={onPlayAgain}>Play Again</button>
        </div>
      )}
    </div>
  );
}
