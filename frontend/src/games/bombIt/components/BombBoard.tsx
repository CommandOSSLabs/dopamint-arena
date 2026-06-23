import { memo, useEffect, useRef, useState } from "react";
import {
  GRID_W,
  GRID_H,
  CELL_WALL,
  CELL_CRATE,
  blastCellsFor,
} from "sui-tunnel-ts/protocol/bombIt";
import type { BombItAction } from "sui-tunnel-ts/protocol/bombIt";
import { BOMB_BTN, BOMB_IT_STYLE } from "../bombItTheme";
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
              {cell === CELL_CRATE ? <span className="bomb-crate-glyph" aria-hidden /> : null}
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
  role: "A" | "B" | null;
  onAction: (a: BombItAction) => void;
  onPlayAgain: () => void;
  stake: number;
  auto?: boolean;
  onToggleAuto?: () => void;
}) {
  const settled = winner !== null;
  const spectating = role === null;
  const canPlay = !spectating && !auto;
  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (canPlay) boardRef.current?.focus();
  }, [canPlay]);

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

  const myParty: "A" | "B" = role ?? "A";
  const oppParty: "A" | "B" = myParty === "A" ? "B" : "A";
  const myIdx = myParty === "A" ? 0 : 1;
  const oppIdx = oppParty === "A" ? 0 : 1;
  const myBalance = myParty === "A" ? view.balanceA : view.balanceB;
  const oppBalance = oppParty === "A" ? view.balanceA : view.balanceB;
  const myDead = !view.players[myIdx]?.alive;
  const oppDead = !view.players[oppIdx]?.alive;
  const pot = view.balanceA + view.balanceB;
  const won = !spectating && winner === role;
  const celebratory = winner !== "draw" && winner !== null && (spectating || won);

  const title = () => {
    if (winner === "draw") return "Draw";
    if (spectating) return winner === "A" ? "Bot A wins" : "Bot B wins";
    return won ? "You win" : "Opponent wins";
  };
  const sub = () => {
    if (winner === "draw") return "Stakes returned";
    return won || spectating ? `+${stake} MIST` : `−${stake} MIST`;
  };

  return (
    <div
      ref={boardRef}
      tabIndex={canPlay ? 0 : -1}
      onKeyDown={handleKeyDown}
      style={BOMB_IT_STYLE}
      className="bomb-shell outline-none"
    >
      <aside
        className={["bomb-pane bomb-pane--you", canPlay ? "bomb-pane--live" : ""].filter(Boolean).join(" ")}
        aria-label="Your seat"
      >
        <div className="bomb-pane__inner">
          <div className="bomb-pane__block">
            <span className="bomb-pane__eyebrow">{spectating ? "bot a" : "you"}</span>
            <div
              className={[
                "bomb-player",
                myParty === "A" ? "bomb-player--a" : "bomb-player--b",
                !spectating ? "bomb-player--mine" : "",
                myDead ? "bomb-player--dead" : "",
                canPlay ? "bomb-player--live" : "",
              ].join(" ")}
            >
              <span className="bomb-player__badge">{myParty}</span>
              <span className="bomb-player__bal wal-mono tabular-nums">{myBalance}</span>
              {myDead && <span className="bomb-player__flag">out</span>}
            </div>
          </div>

          <div className="bomb-pane__grow">
            {onToggleAuto && !settled && (
              <button
                type="button"
                className={`${BOMB_BTN} bomb-auto${auto ? " bomb-auto--on" : ""}`}
                onClick={onToggleAuto}
                title={auto ? "Bot is playing — click to take over" : "Manual — click for autopilot"}
              >
                {auto ? "auto" : "manual"}
              </button>
            )}

            {!settled && canPlay && (
              <div className="bomb-controls">
                <div className="bomb-actionbar" role="group" aria-label="Movement controls">
                  <button type="button" className="bomb-pad bomb-pad--n" onPointerDown={() => onAction("north")} aria-label="North">W</button>
                  <button type="button" className="bomb-pad bomb-pad--w" onPointerDown={() => onAction("west")} aria-label="West">A</button>
                  <button type="button" className="bomb-pad bomb-pad--bomb" onPointerDown={() => onAction("bomb")} aria-label="Bomb">■</button>
                  <button type="button" className="bomb-pad bomb-pad--e" onPointerDown={() => onAction("east")} aria-label="East">D</button>
                  <button type="button" className="bomb-pad bomb-pad--s" onPointerDown={() => onAction("south")} aria-label="South">S</button>
                </div>
              </div>
            )}

            {spectating && !settled && <span className="bomb-spectate">bot vs bot</span>}
          </div>
        </div>
      </aside>

      <main className="bomb-main">
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
                <span className={`bomb-piece__glyph bomb-piece__glyph--a${role === "A" ? " bomb-piece__glyph--mine" : ""}`}>
                  <span className="bomb-piece__inner" aria-hidden />
                </span>
              </div>
            )}
            {view.players[1]?.alive && (
              <div
                key="pB"
                className="bomb-piece"
                style={{ ["--r" as string]: view.players[1].row, ["--c" as string]: view.players[1].col } as React.CSSProperties}
              >
                <span className={`bomb-piece__glyph bomb-piece__glyph--b${role === "B" ? " bomb-piece__glyph--mine" : ""}`}>
                  <span className="bomb-piece__inner" aria-hidden />
                </span>
              </div>
            )}
            {view.bombs.map((b) => (
              <div
                key={`bomb-${b.owner}`}
                className="bomb-piece"
                style={{ ["--r" as string]: b.row, ["--c" as string]: b.col } as React.CSSProperties}
              >
                <span className="bomb-piece__glyph bomb-piece__glyph--bomb" aria-label="Bomb">
                  <span className="bomb-piece__bomb-core" aria-hidden />
                  <span className="bomb-piece__fuse" aria-hidden />
                </span>
              </div>
            ))}
            {blasts.map((bl) =>
              bl.cells.map((ci) => (
                <div
                  key={`${bl.id}-${ci}`}
                  className="bomb-blast"
                  style={{ ["--r" as string]: Math.floor(ci / GRID_W), ["--c" as string]: ci % GRID_W } as React.CSSProperties}
                >
                  <span className="bomb-blast__fill" />
                  <span className="bomb-blast__frame" />
                  <span className="bomb-blast__cross" aria-hidden />
                </div>
              )),
            )}
          </div>
        </div>
      </main>

      <aside
        className={["bomb-pane bomb-pane--opp", !settled ? "bomb-pane--live" : ""].filter(Boolean).join(" ")}
        aria-label="Opponent and match stats"
      >
        <div className="bomb-pane__inner">
          <div className="bomb-pane__block">
            <span className="bomb-pane__eyebrow">{spectating ? "bot b" : "opp"}</span>
            <div
              className={[
                "bomb-player",
                oppParty === "A" ? "bomb-player--a" : "bomb-player--b",
                oppDead ? "bomb-player--dead" : "",
                !settled && !oppDead ? "bomb-player--rival" : "",
              ].join(" ")}
            >
              <span className="bomb-player__badge">{oppParty}</span>
              <span className="bomb-player__bal wal-mono tabular-nums">{oppBalance}</span>
              {oppDead && <span className="bomb-player__flag">out</span>}
            </div>
          </div>

          <div className={`bomb-stats${!settled ? " bomb-stats--live" : ""}`}>
            <div className="bomb-tx">
              <span className="bomb-tx__label">tx</span>
              <span key={view.tick} className="bomb-tx__value wal-doto tabular-nums">
                {view.tick}
              </span>
              {!settled && <span className="bomb-tx__live" aria-label="live">●</span>}
            </div>
            <dl className="bomb-metrics">
              <div className={`bomb-metric${view.bombs.length > 0 ? " bomb-metric--hot" : ""}`}>
                <dt>bombs</dt>
                <dd key={view.bombs.length} className="wal-mono tabular-nums">
                  {view.bombs.length}
                </dd>
              </div>
              <div className="bomb-metric">
                <dt>pot</dt>
                <dd className="wal-mono tabular-nums">{pot}</dd>
              </div>
              <div className="bomb-metric">
                <dt>stake</dt>
                <dd className="wal-mono tabular-nums">{stake}</dd>
              </div>
            </dl>
          </div>
        </div>
      </aside>

      {settled && (
        <div className="bomb-result" role="dialog" aria-modal="true" aria-labelledby="bomb-result-title">
          <div className="bomb-result__card">
            <div
              id="bomb-result-title"
              className={`bomb-result__title wal-doto ${celebratory ? "text-[var(--bi-gold)]" : "text-slate-200"}`}
            >
              {title()}
            </div>
            <div className="bomb-result__sub">{sub()}</div>
            <button type="button" className={`${BOMB_BTN} bomb-cta`} onClick={onPlayAgain}>
              again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
