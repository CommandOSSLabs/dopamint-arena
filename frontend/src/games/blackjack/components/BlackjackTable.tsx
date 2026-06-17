import { useEffect, useState, useRef } from "react";
import "../blackjack.css";
import dealerDesk from "../assets/dealer-desk-plain.png";
import type { BlackjackView, SessionResult } from "../session-core";
import { CardDisplay } from "./CardDisplay";

import chip25 from "../assets/chip-25.svg";
import chip100 from "../assets/chip-100.svg";
import chip500 from "../assets/chip-500.svg";
import chip1000 from "../assets/chip-1000.svg";

interface BlackjackTableProps {
  view: BlackjackView;
  result: SessionResult | null;
  settled: boolean; // true when the session is over
  onPlayAgain: () => void;
}

const RESULT_BANNER: Record<SessionResult, string> = {
  win: "Player Bot wins",
  lose: "Dealer Bot wins",
  push: "Push",
};

function getChipStack(balance: number): string[] {
  const stack: string[] = [];
  let remaining = balance;
  
  const chipTypes = [
    { value: 1000, asset: chip1000 },
    { value: 500, asset: chip500 },
    { value: 100, asset: chip100 },
    { value: 25, asset: chip25 },
  ];

  for (const chip of chipTypes) {
    while (remaining >= chip.value && stack.length < 6) {
      stack.push(chip.asset);
      remaining -= chip.value;
    }
  }
  
  if (stack.length === 0 && balance > 0) {
    stack.push(chip25);
  }
  
  return stack;
}

export function BlackjackTable({
  view,
  result,
  settled,
  onPlayAgain,
}: BlackjackTableProps) {
  const [animState, setAnimState] = useState<"idle" | "deal" | "win" | "lose" | "push">("idle");
  const prevRoundRef = useRef<number>(-1);
  const prevPhaseRef = useRef<string>("");
  const prevBalanceRef = useRef<number>(-1);

  useEffect(() => {
    if (prevRoundRef.current === -1) {
      prevRoundRef.current = view.round;
      prevPhaseRef.current = view.phase;
      prevBalanceRef.current = view.playerBalance;
      if (view.phase === "player") {
        setAnimState("deal");
      }
      return;
    }

    const roundChanged = view.round !== prevRoundRef.current;
    const phaseChanged = view.phase !== prevPhaseRef.current;

    if (roundChanged || (phaseChanged && view.phase === "player")) {
      setAnimState("deal");
    } else if (phaseChanged && view.phase === "round_over") {
      const balanceDiff = view.playerBalance - prevBalanceRef.current;
      if (balanceDiff > 0) {
        setAnimState("win");
      } else if (balanceDiff < 0) {
        setAnimState("lose");
      } else {
        setAnimState("push");
      }
    }

    prevRoundRef.current = view.round;
    prevPhaseRef.current = view.phase;
    prevBalanceRef.current = view.playerBalance;
  }, [view.round, view.phase, view.playerBalance]);

  // Reset animation state to idle after win/lose/push completes (which matches our 900ms step pacing)
  useEffect(() => {
    if (animState === "win" || animState === "lose" || animState === "push") {
      const timer = setTimeout(() => {
        setAnimState("idle");
      }, 850);
      return () => clearTimeout(timer);
    }
  }, [animState]);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-zinc-950 text-white select-none">
      {/* Play area: full-bleed dealer-desk art, dealer toward the top, player lower */}
      <div
        className="relative flex-1 bg-cover bg-center"
        style={{ backgroundImage: `url(${dealerDesk})` }}
      >
        {/* Dealer name badge */}
        <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border border-amber-950 bg-black/70 px-4 py-1 shadow-lg backdrop-blur-sm">
          <span className="text-gold text-[10px] font-extrabold uppercase tracking-widest">
            Dealer Bot (House)
          </span>
        </div>

        {/* Dealer Stack Display */}
        <div className="absolute top-3 left-4 z-10 flex flex-col items-center">
          <span className="text-[8px] text-emerald-200/50 uppercase tracking-widest mb-1 font-bold">Dealer Stacks</span>
          <div className="profile-chip-stack">
            {getChipStack(view.dealerBalance).map((chip, idx) => (
              <img
                key={idx}
                src={chip}
                className="stacked-chip"
                style={{ bottom: `${idx * 6}px`, transform: `rotate(${idx * 4 - 8}deg)` }}
                alt="chip"
              />
            ))}
          </div>
        </div>

        {/* Player Stack Display */}
        <div className="absolute bottom-[20%] left-4 z-10 flex flex-col items-center">
          <span className="text-[8px] text-emerald-200/50 uppercase tracking-widest mb-1 font-bold">Player Stacks</span>
          <div className="profile-chip-stack">
            {getChipStack(view.playerBalance).map((chip, idx) => (
              <img
                key={idx}
                src={chip}
                className="stacked-chip"
                style={{ bottom: `${idx * 6}px`, transform: `rotate(${idx * 4 - 8}deg)` }}
                alt="chip"
              />
            ))}
          </div>
        </div>

        {/* Betting Spot (Desk Layout) */}
        <div className={`betting-spot ${animState !== "idle" ? "active" : ""}`}>
          <div className="betting-label">PAYS 3 TO 2</div>
          <div className="text-[8px] text-[#d4af37]/60 font-mono tracking-wider font-extrabold uppercase mt-1">WAGER $100</div>
        </div>

        {/* Active Animated Chips Layer */}
        {animState !== "idle" && (
          <div className="table-chips-layer">
            {animState === "deal" && (
              <img src={chip100} className="animated-chip chip-deal" alt="bet chip" />
            )}
            {animState === "win" && (
              <>
                <img src={chip100} className="animated-chip chip-win-collect-1" alt="bet chip 1" />
                <img src={chip100} className="animated-chip chip-win-collect-2" alt="bet chip 2" />
              </>
            )}
            {animState === "lose" && (
              <img src={chip100} className="animated-chip chip-lose" alt="bet chip" />
            )}
            {animState === "push" && (
              <img src={chip100} className="animated-chip chip-push" alt="bet chip" />
            )}
          </div>
        )}

        {/* Dealer hand: dealer's side of the felt */}
        <div className="absolute left-1/2 top-[18%] z-20 flex w-full max-w-xs -translate-x-1/2 flex-col items-center">
          <CardDisplay
            title="Dealer Bot"
            cards={view.dealerCards}
            sum={view.dealerSum}
            isWinning={settled && result === "lose"}
          />
        </div>

        {/* Player hand: player's side of the felt */}
        <div className="absolute left-1/2 bottom-[6%] z-20 flex w-full max-w-xs -translate-x-1/2 flex-col items-center">
          <CardDisplay
            title="Player Bot"
            cards={view.playerCards}
            sum={view.playerSum}
            isPlayer
            isWinning={settled && result === "win"}
          />
        </div>

        {/* Session-over overlay: dimmed result banner + play again */}
        {settled && result && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-black/60 pl-32">
            <div className="fade-in-up flex flex-col items-center gap-4">
              <div className="text-gold gold-glow rounded-full border-2 border-amber-500 bg-black/70 px-8 py-3 text-lg font-black uppercase tracking-widest">
                {RESULT_BANNER[result]}
              </div>
              <button
                onClick={onPlayAgain}
                className="gold-glow-hover rounded border border-amber-500 bg-arena-accent px-6 py-2 font-bold uppercase tracking-widest text-arena-bg transition-all hover:opacity-90"
              >
                Play Again
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bottom HUD: round + balances, gold casino theme */}
      <div className="z-30 flex w-full items-center justify-between gap-4 border-t border-zinc-800 bg-zinc-950/95 px-5 py-3 shadow-[0_-10px_30px_rgba(0,0,0,0.95)] backdrop-blur-md">
        <div className="flex flex-col items-start">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            Round
          </span>
          <span className="text-gold font-mono text-lg font-black">
            {view.round}
          </span>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex flex-col items-end">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              Player Bot
            </span>
            <span className="font-mono text-sm font-black text-white">
              ${view.playerBalance.toLocaleString()}
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              Dealer Bot
            </span>
            <span className="font-mono text-sm font-black text-white">
              ${view.dealerBalance.toLocaleString()}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
