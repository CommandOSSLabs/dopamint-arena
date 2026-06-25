import { formatCompactCount } from "@/lib/formatCompactCount";
import { useEffect, useRef } from "react";
import type { CrossDir, HazardSpan } from "sui-tunnel-ts/protocol/cross";
import {
  COLUMN_COUNT,
  hazardsAt,
  laneKind,
  spanCoversCol,
  WIN_LANE,
} from "sui-tunnel-ts/protocol/cross";
import { SketchDefs } from "../../sketch";
import "../cross.css";
import { CROSS_STYLE, grassHasTree } from "../crossTheme";
import { visibleLanes, type CrossView } from "../session-core";
import {
  CrossCar,
  CrossChicken,
  CrossLog,
  CrossTrain,
  CrossTree,
} from "./crossSprites";

function trainSegment(span: HazardSpan, col: number): "head" | "mid" | "tail" {
  const left = Math.ceil(span.center - span.half);
  const right = Math.floor(span.center + span.half) - 1;
  if (col <= left) return "head";
  if (col >= right) return "tail";
  return "mid";
}

function hazardOrdinal(hazards: HazardSpan[], col: number): number {
  return hazards.findIndex((s) => spanCoversCol(s, col));
}

function SeatRail({
  party,
  lane,
  mine,
  tag,
}: {
  party: "A" | "B";
  lane: number;
  mine: boolean;
  tag: string;
}) {
  const chickParty = party === "A" ? "a" : "b";
  const showFloatYou = mine && tag === "you";
  return (
    <div
      className={[
        "cross-seat-rail sketch-stroke",
        party === "A" ? "cross-seat-rail--a" : "cross-seat-rail--b",
        mine ? "cross-seat-rail--mine" : "",
      ].join(" ")}
    >
      {showFloatYou ? (
        <span className="cross-seat-rail__float">you</span>
      ) : null}
      <span className="cross-seat-rail__icon" aria-hidden>
        <CrossChicken party={chickParty} mini mine={mine} />
      </span>
      <div className="cross-seat-rail__meta">
        <span className="cross-seat-rail__lane tabular-nums">L{lane}</span>
        {tag && !showFloatYou ? (
          <span className="cross-seat-rail__tag">{tag}</span>
        ) : null}
      </div>
    </div>
  );
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
  score,
  gamesPlayed,
  onSettle,
}: {
  view: CrossView;
  winner: "A" | "B" | null;
  role: "A" | "B" | null;
  onDir: (d: CrossDir) => void;
  onPlayAgain: () => void;
  seed: number;
  stake: number;
  done?: boolean;
  auto?: boolean;
  onToggleAuto?: () => void;
  /** Running multi-game score for solo sessions. */
  score?: { you: number; foe: number };
  /** Number of completed races (the current race is gamesPlayed + 1). */
  gamesPlayed?: number;
  /** Cash out the tunnel at the current state — solo only, shown while live. */
  onSettle?: () => void;
}) {
  const settled = winner !== null || done;
  const spectating = role === null;
  const manual = !spectating && !auto;
  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (manual) boardRef.current?.focus();
  }, [manual]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (settled || !manual) return;
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

  const myIndex = role === "A" ? 0 : role === "B" ? 1 : null;
  const lanes = visibleLanes(view, myIndex, WIN_LANE);
  const won = !spectating && winner === role;
  const celebratory = winner !== null && (spectating || won);

  const title = () => {
    if (winner === null) return "Draw";
    if (spectating) return winner === "A" ? "Bot A wins" : "Bot B wins";
    return won ? "You win!" : "Opponent wins";
  };
  const sub = () => {
    if (winner === null) return "Stakes returned";
    const amt = formatCompactCount(stake);
    return won || spectating ? `+$${amt} on-chain` : `−$${amt} on-chain`;
  };

  return (
    <div
      ref={boardRef}
      tabIndex={manual ? 0 : -1}
      onKeyDown={handleKeyDown}
      className="cross-shell sketch outline-none"
      style={CROSS_STYLE}
    >
      <SketchDefs />
      <aside
        className="cross-pane sketch-stroke sketch-panel"
        aria-label="Match info and controls"
      >
        <div className="cross-pane__top">
          <SeatRail
            party="A"
            lane={view.players[0]?.lane ?? 0}
            mine={role === "A"}
            tag={spectating ? "bot" : role === "A" ? "you" : ""}
          />

          <SeatRail
            party="B"
            lane={view.players[1]?.lane ?? 0}
            mine={role === "B"}
            tag={spectating ? "bot" : role === "B" ? "you" : ""}
          />

          {score !== undefined && (
            <div className="cross-score sketch-stroke">
              <span className="cross-score__tally tabular-nums">
                {score.you}–{score.foe}
              </span>
              <span className="cross-score__label">
                g{(gamesPlayed ?? 0) + 1}
              </span>
            </div>
          )}
        </div>

        <div className="cross-pane__bottom">
          {onToggleAuto && !settled && (
            <button
              type="button"
              className={`cross-auto sketch-btn${auto ? " cross-auto--on sketch-btn--go" : ""}`}
              onClick={onToggleAuto}
              title={
                auto
                  ? "Bot is racing — click to take over"
                  : "Manual — click for autopilot"
              }
            >
              {auto ? "auto" : "manual"}
            </button>
          )}

          {!settled && manual && (
            <div
              className="cross-actionbar sketch-stroke sketch-panel"
              role="group"
              aria-label="Movement controls"
            >
              <button
                type="button"
                className="cross-pad sketch-stroke"
                onPointerDown={() => onDir("north")}
                aria-label="North (W)"
              >
                <span className="cross-pad__arrow">▲</span>
                <span className="cross-pad__key">w</span>
              </button>
              <div className="cross-pad-row">
                <button
                  type="button"
                  className="cross-pad sketch-stroke"
                  onPointerDown={() => onDir("west")}
                  aria-label="West (A)"
                >
                  <span className="cross-pad__arrow">◀</span>
                  <span className="cross-pad__key">a</span>
                </button>
                <button
                  type="button"
                  className="cross-pad sketch-stroke"
                  onPointerDown={() => onDir("south")}
                  aria-label="South (S)"
                >
                  <span className="cross-pad__arrow">▼</span>
                  <span className="cross-pad__key">s</span>
                </button>
                <button
                  type="button"
                  className="cross-pad sketch-stroke"
                  onPointerDown={() => onDir("east")}
                  aria-label="East (D)"
                >
                  <span className="cross-pad__arrow">▶</span>
                  <span className="cross-pad__key">d</span>
                </button>
              </div>
            </div>
          )}

          {spectating && !settled && (
            <span className="cross-spectate">bvb</span>
          )}

          {onSettle && !settled && (
            <button
              type="button"
              className="cross-settle sketch-btn sketch-btn--go"
              onClick={onSettle}
              title="Cash out the tunnel now at the current balance"
            >
              settle
            </button>
          )}
        </div>
      </aside>

      <main className="cross-main">
        <div
          className="cross-stage sketch-arena sketch-stroke"
          style={
            {
              "--cx-cols": COLUMN_COUNT,
              "--cx-rows": lanes.length,
            } as React.CSSProperties
          }
        >
          <div className="cross-grid">
            {lanes.map((L) => {
              const kind = laneKind(L);
              const hazards = hazardsAt(BigInt(seed), L, BigInt(view.tick));
              const finish = L === WIN_LANE;
              return (
                <div key={L} className="cross-lane">
                  {Array.from({ length: COLUMN_COUNT }).map((_, col) => {
                    const onHaz = hazards.some((s) => spanCoversCol(s, col));
                    const aHere =
                      view.players[0]?.lane === L &&
                      view.players[0]?.col === col;
                    const bHere =
                      view.players[1]?.lane === L &&
                      view.players[1]?.col === col;
                    const here = aHere || bHere;
                    const hit = onHaz && here;
                    const showTree =
                      kind === "grass" &&
                      !here &&
                      !onHaz &&
                      grassHasTree(seed, L, col);
                    const hazSpan = onHaz
                      ? hazards.find((s) => spanCoversCol(s, col))
                      : undefined;
                    const ord = hazSpan ? hazardOrdinal(hazards, col) : 0;

                    const isMyLane =
                      myIndex !== null && view.players[myIndex]?.lane === L;

                    return (
                      <div
                        key={col}
                        className={[
                          `cross-cell cross-cell--${kind} sketch-cell`,
                          finish ? "cross-cell--finish" : "",
                          isMyLane ? "cross-cell--mine-lane" : "",
                        ].join(" ")}
                      >
                        {finish && col === 0 ? (
                          <span className="cross-finish-flag" aria-hidden />
                        ) : null}
                        {showTree ? (
                          <div className="cross-piece cross-piece--tree">
                            <CrossTree />
                          </div>
                        ) : null}
                        {aHere ? (
                          <div
                            key={`a-${L}-${col}-${hit ? "hit" : "ok"}`}
                            className={`cross-piece cross-piece--chicken${bHere ? " cross-piece--duo-a" : ""}`}
                          >
                            <CrossChicken
                              party="a"
                              mine={myIndex === 0}
                              hit={hit && aHere}
                            />
                          </div>
                        ) : null}
                        {bHere ? (
                          <div
                            key={`b-${L}-${col}`}
                            className={`cross-piece cross-piece--chicken${aHere ? " cross-piece--duo-b" : ""}`}
                          >
                            <CrossChicken
                              party="b"
                              mine={myIndex === 1}
                              hit={hit && bHere}
                            />
                          </div>
                        ) : null}
                        {!here && onHaz && hazSpan ? (
                          <div className="cross-piece cross-piece--hazard">
                            {kind === "road" ? (
                              <CrossCar lane={L} ordinal={ord} />
                            ) : kind === "water" ? (
                              <CrossLog />
                            ) : (
                              <CrossTrain
                                segment={trainSegment(hazSpan, col)}
                              />
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {settled && (
          <div className="cross-result" role="dialog" aria-modal="true">
            <div className="cross-result__card sketch-stroke sketch-panel">
              {celebratory && <div className="cross-result__trophy">🏆</div>}
              <div
                className={`cross-result__line ${celebratory ? "text-[var(--sketch-accent)]" : ""}`}
              >
                {title()}
              </div>
              <div className="cross-result__sub">{sub()}</div>
              <button
                type="button"
                className="cross-play-again sketch-btn sketch-btn--go"
                onClick={onPlayAgain}
              >
                Play Again
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
