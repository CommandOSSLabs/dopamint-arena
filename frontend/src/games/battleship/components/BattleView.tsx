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
}: {
  view: BattleshipView;
  /** Extra status line shown on the result card (e.g. "settling…", "settled ✓"). */
  statusLabel?: string;
  onFire: (cell: number) => void;
  onPlayAgain: () => void;
}) {
  const accuracy =
    view.yourShots > 0
      ? Math.round((view.hitsOnEnemy / view.yourShots) * 100)
      : 0;

  return (
    <div className="relative flex h-full flex-col gap-2 p-2 @[26rem]:p-3">
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
        <span>{view.onChain ? "on-chain" : "demo · off-chain"}</span>
      </div>

      <FleetRoster fleet={view.fleet} />

      <div className="grid grid-cols-1 gap-3 @[30rem]:grid-cols-2 @[30rem]:gap-4">
        <BoardGrid
          title="Enemy waters"
          cells={view.enemyCells}
          interactive={view.myTurn}
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
          <span
            className={cn(view.myTurn && "animate-pulse text-arena-accent")}
          >
            {view.myTurn ? "Your turn — fire!" : "Opponent is aiming…"}
          </span>
        </div>
      )}

      {view.outcome !== null && (
        <div className="absolute inset-0 grid place-items-center bg-black/45 p-2 backdrop-blur-sm @[20rem]:p-4">
          <div className="flex w-full max-w-xs animate-in flex-col items-center gap-3 rounded-xl border border-arena-edge bg-arena-panel p-4 text-center shadow-2xl zoom-in-95 @[20rem]:p-5">
            <div
              className={cn(
                "text-lg font-bold",
                view.outcome === "win" ? "text-arena-accent" : "text-red-400",
              )}
            >
              {view.outcome === "win" ? "Victory" : "Defeat"}
            </div>
            <p className="text-xs text-arena-muted">
              {view.outcome === "win"
                ? "You sank the enemy fleet."
                : "Your fleet was sunk."}
            </p>
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
            <button
              onClick={onPlayAgain}
              className="mt-1 rounded bg-arena-accent px-4 py-1.5 text-sm font-semibold text-black"
            >
              Play Again
            </button>
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
