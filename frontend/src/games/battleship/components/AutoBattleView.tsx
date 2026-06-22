import { cn } from "@/lib/utils";
import { FLEET_CELLS } from "../engine/fleet";
import type { AutoSeatView, BattleshipAutoView } from "../view";
import { BoardGrid } from "./BoardGrid";
import { FleetRoster } from "./FleetRoster";

/** MIST → a short SUI string. */
const sui = (mist: number) => `${(mist / 1e9).toFixed(3)} SUI`;

/**
 * Spectator screen for the on-chain auto (bot-vs-bot) run. Both fleets are
 * revealed side by side, a scoreboard tallies matches, each bot shows its live
 * gas balance, and — like the caro / poker auto modes — the run loops until a bot
 * is low on gas or the user stops it.
 */
export function AutoBattleView({
  view,
  onStop,
  onReset,
}: {
  view: BattleshipAutoView;
  onStop: () => void;
  onReset: () => void;
}) {
  const ended = view.endReason !== null;
  const stopping = !view.auto && !ended; // user hit Stop; the current match is finishing
  const playing = !ended && view.stage === "playing";
  const inMatch = playing && view.winner === 0;
  const winnerName = view.winner === 1 ? "Bot A" : "Bot B";

  const banner = stopping
    ? "Finishing match…"
    : view.stage === "opening"
      ? "Opening tunnel…"
      : view.stage === "settling"
        ? "Settling on-chain…"
        : view.winner !== 0
          ? `${winnerName} won — next match…`
          : view.phase === "awaitingCommits"
            ? "Deploying fleets…"
            : `${view.turn === "A" ? "Bot A" : "Bot B"} is aiming…`;

  return (
    <div className="relative flex h-full flex-col gap-2 p-2 @[26rem]:p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] text-arena-muted">
        <span>
          Auto · <span className="text-arena-text">Bot vs Bot</span> · match{" "}
          <span className="text-arena-text">{view.match}</span>
        </span>
        <span className="font-semibold text-arena-text">
          <span className="text-cyan-400">A {view.score.a}</span>
          {" – "}
          <span className="text-cyan-400">{view.score.b} B</span>
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 @[30rem]:grid-cols-2 @[30rem]:gap-4">
        <BotColumn
          name="Bot A"
          seat={view.a}
          balance={view.balance.a}
          aiming={inMatch && view.turn === "A"}
        />
        <BotColumn
          name="Bot B"
          seat={view.b}
          balance={view.balance.b}
          aiming={inMatch && view.turn === "B"}
        />
      </div>

      {!ended && (
        <div className="mt-auto flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-arena-accent">
            <span className="animate-pulse">{banner}</span>
          </span>
          {view.auto && (
            <button
              onClick={onStop}
              className="rounded-full border border-cyan-500/40 bg-cyan-950/40 px-3 py-1 text-xs font-semibold text-cyan-300 transition-colors hover:border-cyan-400 hover:bg-cyan-500/10"
            >
              Stop
            </button>
          )}
        </div>
      )}

      {ended && (
        <div className="absolute inset-0 grid place-items-center bg-black/45 p-2 backdrop-blur-sm @[20rem]:p-4">
          <div className="flex w-full max-w-xs animate-in flex-col items-center gap-3 rounded-xl border border-arena-edge bg-arena-panel p-4 text-center shadow-2xl zoom-in-95 @[20rem]:p-5">
            <div className="text-lg font-bold text-arena-accent">
              {runHeadline(view)}
            </div>
            <p className="text-xs text-arena-muted">
              {view.endReason === "funds"
                ? "A bot ran out of gas."
                : "Run stopped."}
            </p>
            <dl className="grid w-full grid-cols-2 gap-y-1.5 text-[11px]">
              <Stat label="Bot A wins" value={String(view.score.a)} />
              <Stat label="Bot B wins" value={String(view.score.b)} />
              <Stat label="A gas" value={sui(view.balance.a)} />
              <Stat label="B gas" value={sui(view.balance.b)} />
            </dl>
            <button
              onClick={onReset}
              className="mt-1 rounded bg-arena-accent px-4 py-1.5 text-sm font-semibold text-black"
            >
              New Run
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function runHeadline(view: BattleshipAutoView): string {
  if (view.score.a === view.score.b) return "Run complete · tied";
  return `${view.score.a > view.score.b ? "Bot A" : "Bot B"} wins the run`;
}

function BotColumn({
  name,
  seat,
  balance,
  aiming,
}: {
  name: string;
  seat: AutoSeatView;
  balance: number;
  aiming: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "text-[11px] font-semibold uppercase tracking-wider",
            aiming ? "text-arena-accent" : "text-cyan-400/80",
          )}
        >
          {name}
          {aiming && " ◂ aiming"}
        </span>
        <span className="text-[10.5px] text-arena-muted">
          {sui(balance)} · hull {seat.hitsTaken}/{FLEET_CELLS}
        </span>
      </div>
      <FleetRoster fleet={seat.fleet} />
      <BoardGrid
        title=""
        cells={seat.cells}
        placements={seat.placements}
        lastShot={seat.lastIncoming}
      />
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
