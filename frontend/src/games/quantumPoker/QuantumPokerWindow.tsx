import { useEffect, useRef } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import type { GameWindowProps } from "../types";
import { useQuantumPokerBot } from "./useQuantumPokerBot";
import { QuantumPokerTable, SketchDefs } from "./QuantumPokerTable";
import { PokerActionBar } from "./PokerActionBar";

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
      <div className="qp-sketch grid h-full min-h-[14rem] place-items-center overflow-hidden p-[clamp(12px,4cqmin,28px)] text-center">
        <SketchDefs />
        <div className="qp-panel qp-stroke max-w-[min(22rem,92%)] p-[clamp(14px,4cqmin,26px)]">
          <span className="qp-eyebrow">You vs Bot</span>
          <div className="qp-title mb-1 mt-1">Quantum Poker</div>
          <p className="qp-note mb-3">
            Open a real self-play tunnel: your wallet funds both seats once, you
            play party A, a random-persona bot plays party B, then it settles
            gas-free.
          </p>
          <div className="flex flex-wrap justify-center gap-[clamp(6px,2cqmin,12px)]">
            <button
              type="button"
              className="qp-btn qp-btn--go"
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
              <button type="button" className="qp-btn" onClick={onExit}>
                Back
              </button>
            )}
          </div>
          {game.error && (
            <div className="mt-3 text-[clamp(10px,2.6cqmin,15px)] text-[var(--qp-red)]">
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
    <div className="qp-sketch grid h-full min-h-[14rem] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
      <SketchDefs />

      <header className="qp-head">
        <div className="flex min-w-0 items-center gap-[clamp(6px,2.2cqmin,14px)]">
          {onExit && (
            <button
              type="button"
              className="qp-btn"
              onClick={() => {
                game.handOffToBot(); // leave without settling → a bot finishes the match in the background
                onExit();
              }}
            >
              Back
            </button>
          )}
          <div className="flex min-w-0 flex-col leading-none">
            <span className="qp-eyebrow">You vs Bot</span>
            <span className="qp-title truncate">Quantum Poker</span>
          </div>
        </div>
        {inPlay && (
          <div className="flex items-center gap-[clamp(5px,1.8cqmin,12px)]">
            <button
              type="button"
              className={`qp-btn${game.auto ? " qp-btn--go" : ""}`}
              onClick={() => game.setAuto(!game.auto)}
              title={
                game.auto
                  ? "Auto on — a bot is playing your seat"
                  : "Let a bot play your seat"
              }
            >
              🤖 Auto{game.auto ? " ON" : ""}
            </button>
            <button
              type="button"
              className="qp-btn qp-btn--go"
              onClick={() => {
                exitAfterSettleRef.current = true; // settle, then auto-return to the menu
                game.settleNow();
              }}
            >
              Settle
            </button>
          </div>
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
          <PokerActionBar
            legal={game.legal}
            pot={s.totalBetA + s.totalBetB}
            onAct={game.act}
            secondsLeft={game.secondsLeft}
          />
        )}
        <div className="flex items-center gap-[clamp(5px,1.8cqmin,12px)]">
          <span className="qp-stat__l">
            {game.status === "settled"
              ? "Settled."
              : game.status === "settling"
                ? "Settling…"
                : game.status === "awaitHuman"
                  ? "Your move"
                  : game.auto
                    ? "🤖 Bot playing your seat"
                    : "Playing…"}
          </span>
          {game.status === "settled" && (
            <button type="button" className="qp-btn qp-btn--go" onClick={game.open}>
              New tunnel
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
