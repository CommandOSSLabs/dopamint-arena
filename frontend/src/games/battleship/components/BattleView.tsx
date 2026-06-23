import { cn } from "@/lib/utils";
import { FLEET_CELLS } from "../engine/fleet";
import type { BattleshipView } from "../view";
import { BoardGrid } from "./BoardGrid";
import { FleetRoster } from "./FleetRoster";

/**
 * The in-battle screen shared by both modes: enemy waters (where you fire) and
 * your own fleet under fire, your fleet's ship roster, a turn banner, and — when
 * the game ends — a result overlay with damage stats. Outcome is from this seat's
 * perspective, so it reads right for either PvP role.
 */
export function BattleView({
  view,
  statusLabel,
  onFire,
  onPlayAgain,
  auto = false,
  score,
  gameNumber,
  onSettle,
  playAgainLabel,
  playAgainDisabled,
}: {
  view: BattleshipView;
  /** Extra status line shown on the result card (e.g. "settling…", "settled ✓"). */
  statusLabel?: string;
  onFire: (cell: number) => void;
  onPlayAgain: () => void;
  /** Autopilot is firing your shots too — reflect it in the turn banner, and (since
   *  finished games rematch automatically) suppress the blocking result overlay. */
  auto?: boolean;
  /** Multi-game session tally (bot mode): your wins vs the bot's, across one tunnel. */
  score?: { you: number; foe: number };
  /** 1-based number of the game on screen (bot multi-game). */
  gameNumber?: number;
  /** Settle + close the tunnel now (bot multi-game). When set, the result card adds
   *  a Settle action alongside Play Again. */
  onSettle?: () => void;
  /** Label for the primary post-game action (e.g. "Find next match" in PvP). */
  playAgainLabel?: string;
  /** Disable the post-game action (e.g. while a PvP settle is still in flight). */
  playAgainDisabled?: boolean;
}) {
  const accuracy =
    view.yourShots > 0
      ? Math.round((view.hitsOnEnemy / view.yourShots) * 100)
      : 0;

  return (
    <div className="relative flex min-h-full flex-col gap-2 p-2 @[26rem]:p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] text-arena-muted">
        <span>
          Enemy sunk{" "}
          <span className="text-arena-text">
            {view.hitsOnEnemy}/{FLEET_CELLS}
          </span>{" "}
          · your hull{" "}
          <span className="text-arena-text">
            {view.hitsOnYou}/{FLEET_CELLS}
          </span>
        </span>
        <span>
          {score ? (
            <>
              <span className="wal-mono uppercase tracking-wider text-[#cab1ff]/70">
                Game {gameNumber}
              </span>{" "}
              · <span className="text-[#9cefcf]">{score.you}</span>–
              <span className="text-[#fb7185]">{score.foe}</span>
            </>
          ) : view.onChain ? (
            "on-chain"
          ) : (
            "demo · off-chain"
          )}
        </span>
      </div>

      <FleetRoster fleet={view.fleet} />

      <div className="grid grid-cols-1 gap-3 @[30rem]:grid-cols-2 @[30rem]:gap-4">
        <BoardGrid
          title="Enemy waters"
          cells={view.enemyCells}
          interactive={view.myTurn && !auto}
          onCell={onFire}
          lastShot={view.lastYourShot}
        />
        <BoardGrid
          title="Your fleet"
          cells={view.ownCells}
          lastShot={view.lastEnemyShot}
          placements={view.placements}
        />
      </div>

      {view.outcome === null && (
        <div className="mt-auto text-sm font-semibold text-arena-text">
          <span className={cn(view.myTurn && "animate-pulse text-[#cab1ff]")}>
            {auto
              ? "Autopilot engaged — bots are dueling…"
              : view.myTurn
                ? "Your turn — fire!"
                : "Opponent is aiming…"}
          </span>
        </div>
      )}

      {/* Result card. Suppressed while autopilot is looping (it rematches on its own);
          shown when a game ends in manual play, with Play Again + (multi-game) Settle. */}
      {view.outcome !== null && !auto && (
        <div className="absolute inset-0 grid place-items-center bg-black/45 p-2 backdrop-blur-sm @[20rem]:p-4">
          <div className="flex w-full max-w-xs animate-in flex-col items-center gap-3 rounded-xl border border-arena-edge bg-arena-panel p-4 text-center shadow-2xl zoom-in-95 @[20rem]:p-5">
            <div
              className={cn(
                "text-lg font-bold",
                view.outcome === "win" ? "text-[#9cefcf]" : "text-[#fb7185]",
              )}
            >
              {view.outcome === "win" ? "Victory" : "Defeat"}
            </div>
            {score ? (
              <p className="text-xs text-arena-muted">
                Session <span className="text-[#9cefcf]">{score.you}</span> –{" "}
                <span className="text-[#fb7185]">{score.foe}</span> · settle to
                cash out, or play on.
              </p>
            ) : (
              <p className="text-xs text-arena-muted">
                {view.outcome === "win"
                  ? "You sank the enemy fleet."
                  : "Your fleet was sunk."}
              </p>
            )}
            <dl className="grid w-full grid-cols-1 gap-y-1.5 text-[11px] @[16rem]:grid-cols-2">
              <Stat label="Shots fired" value={String(view.yourShots)} />
              <Stat label="Hits" value={String(view.hitsOnEnemy)} />
              <Stat label="Accuracy" value={`${accuracy}%`} />
              <Stat
                label="Hull lost"
                value={`${view.hitsOnYou}/${FLEET_CELLS}`}
              />
            </dl>
            <div className="text-[11px] text-arena-muted">
              {statusLabel ?? ""}
            </div>
            <div className="mt-1 flex w-full flex-col gap-2">
              <button
                onClick={onPlayAgain}
                disabled={playAgainDisabled}
                className={cn(
                  "inline-flex w-full items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold transition-all active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40",
                  onSettle
                    ? "border border-[#cab1ff]/40 bg-[#cab1ff]/8 text-[#cab1ff] hover:border-[#cab1ff]/70 hover:bg-[#cab1ff]/15"
                    : "bg-[#cab1ff] text-[#0c0f1d] shadow-[0_0_14px_rgba(202,177,255,0.3)] hover:bg-[#b79bff]",
                )}
              >
                {playAgainLabel ?? "Play Again"}
              </button>
              {onSettle && (
                <button
                  onClick={onSettle}
                  className="inline-flex w-full items-center justify-center rounded-full bg-[#cab1ff] px-5 py-2.5 text-sm font-semibold text-[#0c0f1d] shadow-[0_0_14px_rgba(202,177,255,0.3)] transition-all hover:bg-[#b79bff] active:scale-[0.97]"
                >
                  Settle &amp; cash out
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 px-2">
      <dt className="text-arena-muted">{label}</dt>
      <dd className="font-semibold text-arena-text">{value}</dd>
    </div>
  );
}
