import { useCurrentAccount } from "@mysten/dapp-kit";
import { useEffect, useRef } from "react";
import type { PokerMove } from "sui-tunnel-ts/protocol/quantumPoker";
import { SketchDefs } from "../sketch";
import type { GameWindowProps } from "../types";
import { pokerRaiseSizes } from "./pokerBetting";
import { QuantumPokerTable } from "./QuantumPokerTable";
import { useQuantumPokerBot } from "./useQuantumPokerBot";

// ---------------------------------------------------------------------------
// Presentational helpers (local only — moveLabel drives the action transcript)
// ---------------------------------------------------------------------------

function moveLabel(move: PokerMove): string {
  switch (move.kind) {
    case "commit_slots":
      return "committed 9 slots";
    case "reveal_slots":
      return `revealed ${move.slots.join("/")}`;
    case "bet":
      return `bet ${move.amount}`;
    case "check":
      return "check";
    case "call":
      return "call";
    case "fold":
      return "fold";
    case "next_hand":
      return "next hand";
  }
}

// Keep moveLabel referenced so TypeScript doesn't warn on an unused export.
void moveLabel;

// ---------------------------------------------------------------------------
// ActionBar — human betting controls (hand-drawn buttons)
// ---------------------------------------------------------------------------

function ActionBar({
  legal,
  pot,
  onAct,
  secondsLeft,
}: {
  legal: NonNullable<ReturnType<typeof useQuantumPokerBot>["legal"]>;
  pot: bigint;
  onAct: (m: PokerMove) => void;
  secondsLeft: number | null;
}) {
  const raise = (amt: bigint) => onAct({ kind: "bet", amount: amt });
  // Same three pot-relative sizes as PvP: ½ pot, pot, all-in.
  const sizes = pokerRaiseSizes({
    pot,
    callAmount: legal.callAmount,
    minBet: legal.minBet,
    maxBet: legal.maxBet,
    canBet: legal.minBet > 0n,
  });
  return (
    <div className="flex flex-wrap items-center gap-[clamp(5px,1.8cqmin,12px)]">
      {secondsLeft != null && (
        <span
          className={`sketch-timer tabular-nums${secondsLeft <= 3 ? " sketch-timer--low motion-safe:animate-pulse" : ""}`}
        >
          {secondsLeft}s
        </span>
      )}
      <button
        type="button"
        className="sketch-btn sketch-btn--stop"
        onClick={() => onAct({ kind: "fold" })}
      >
        Fold
      </button>
      {legal.canCheck && (
        <button
          type="button"
          className="sketch-btn"
          onClick={() => onAct({ kind: "check" })}
        >
          Check
        </button>
      )}
      {legal.canCall && (
        <button
          type="button"
          className="sketch-btn sketch-btn--call"
          onClick={() => onAct({ kind: "call" })}
        >
          Call {legal.callAmount.toString()}
        </button>
      )}
      {sizes.showHalf && (
        <button
          type="button"
          className="sketch-btn"
          onClick={() => raise(sizes.half)}
        >
          ½ Pot · {sizes.half.toString()}
        </button>
      )}
      {sizes.showFull && (
        <button
          type="button"
          className="sketch-btn"
          onClick={() => raise(sizes.full)}
        >
          Pot · {sizes.full.toString()}
        </button>
      )}
      {sizes.showAllIn && (
        <button
          type="button"
          className="sketch-btn sketch-btn--go"
          onClick={() => raise(sizes.allIn)}
        >
          All-in · {sizes.allIn.toString()}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

export function QuantumPokerWindow({
  windowId,
  onExit,
}: GameWindowProps & { lane?: "bot" | "auto"; onExit?: () => void }) {
  const account = useCurrentAccount();
  const game = useQuantumPokerBot(windowId);
  const s = game.state;

  // After a player-triggered Settle (cash out) completes, navigate back to the menu. A natural
  // match-end settle leaves this flag false, so its "Settled · New tunnel" screen still shows.
  const exitAfterSettleRef = useRef(false);
  useEffect(() => {
    if (game.status === "settled" && exitAfterSettleRef.current) {
      exitAfterSettleRef.current = false;
      onExit?.();
    }
  }, [game.status, onExit]);

  if (!s) {
    return (
      <div className="sketch grid h-full min-h-[14rem] place-items-center overflow-hidden p-[clamp(12px,4cqmin,28px)] text-center">
        <SketchDefs />
        <div className="sketch-panel sketch-stroke max-w-[min(22rem,92%)] p-[clamp(14px,4cqmin,26px)]">
          <span className="sketch-eyebrow">You vs Bot</span>
          <div className="qp-title mb-1 mt-1">Quantum Poker</div>
          <p className="sketch-note mb-3">
            Open a real self-play tunnel: your wallet funds both seats once, you
            play party A, a random-persona bot plays party B, then it settles
            gas-free.
          </p>
          <div className="flex flex-wrap justify-center gap-[clamp(6px,2cqmin,12px)]">
            <button
              type="button"
              className="sketch-btn sketch-btn--go"
              onClick={game.open}
              disabled={game.status === "funding" || !account}
            >
              {game.status === "funding"
                ? "Opening…"
                : account
                  ? "Open tunnel"
                  : "Connect wallet"}
            </button>
            {onExit && (
              <button type="button" className="sketch-btn" onClick={onExit}>
                Back
              </button>
            )}
          </div>
          {game.error && (
            <div className="mt-3 text-[clamp(10px,2.6cqmin,15px)] text-[var(--sketch-red)]">
              {game.error}
            </div>
          )}
        </div>
      </div>
    );
  }

  const holesB = s.shownHoleB ?? [];
  const inPlay = game.status === "playing" || game.status === "awaitHuman";

  return (
    <div className="sketch grid h-full min-h-[14rem] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
      <SketchDefs />

      <header className="qp-head">
        <div className="flex min-w-0 items-center gap-[clamp(6px,2.2cqmin,14px)]">
          {onExit && (
            <button
              type="button"
              className="sketch-btn"
              onClick={() => {
                game.handOffToBot(); // leave without settling → a bot finishes the match in the background
                onExit();
              }}
            >
              Back
            </button>
          )}
          <div className="flex min-w-0 flex-col leading-none">
            <span className="sketch-eyebrow">You vs Bot</span>
            <span className="qp-title truncate">Quantum Poker</span>
          </div>
        </div>
        {inPlay && (
          <button
            type="button"
            className="sketch-btn sketch-btn--go"
            onClick={() => {
              exitAfterSettleRef.current = true; // settle, then auto-return to the menu
              game.settleNow();
            }}
          >
            Settle
          </button>
        )}
      </header>

      <main className="grid min-h-0 overflow-hidden p-[clamp(10px,3.6cqmin,36px)]">
        <QuantumPokerTable
          state={s}
          holesA={game.humanHoles}
          holesB={holesB}
          nameA="You"
          nameB="Bot"
        />
      </main>

      <footer className="grid gap-[clamp(5px,1.6cqmin,12px)] p-[clamp(6px,2.4cqmin,16px)] pt-0">
        {game.status === "awaitHuman" && game.legal && (
          <ActionBar
            legal={game.legal}
            pot={s.totalBetA + s.totalBetB}
            onAct={game.act}
            secondsLeft={game.secondsLeft}
          />
        )}
        <div className="flex items-center gap-[clamp(5px,1.8cqmin,12px)]">
          <span className="sketch-note">
            {game.status === "settled"
              ? "Settled."
              : game.status === "settling"
                ? "Settling…"
                : game.status === "awaitHuman"
                  ? "Your move"
                  : "Playing…"}
          </span>
          {game.status === "settled" && (
            <button
              type="button"
              className="sketch-btn sketch-btn--go"
              onClick={game.open}
            >
              New tunnel
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
