import "../blackjack.css";
import dealerDesk from "../assets/dealer-desk.png";
import type { BlackjackView, SessionResult } from "../session-core";
import { CardDisplay } from "./CardDisplay";

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

export function BlackjackTable({
  view,
  result,
  settled,
  onPlayAgain,
}: BlackjackTableProps) {
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
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-black/60">
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
