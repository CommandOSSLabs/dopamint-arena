import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { GameCardScale } from "@/components/general/GameCardScale";

export default function Home() {
  const navigate = useNavigate();

  useEffect(() => {
    document.title = "Blackjack";
  }, []);

  return (
    <div className="w-screen h-screen flex flex-col items-center justify-center menu-background relative text-white overflow-hidden select-none">
      <GameCardScale>
        <div className="bg-zinc-950/90 border border-zinc-800 rounded-2xl p-6 md:p-8 w-full max-w-md shadow-2xl z-10 flex flex-col items-center fade-in-up">
          <img
            src="/blackjack-logo-gold.svg"
            alt="Blackjack Logo"
            className="w-24 h-24 mb-3 filter drop-shadow-lg"
          />
          <h1 className="text-4xl font-extrabold text-gold font-serif mb-6 tracking-widest uppercase text-center">
            BLACKJACK
          </h1>

          {/* On-chain tunnel demos, no login required: play the dealer yourself, or watch
              two bots self-play. */}
          <div className="w-full space-y-3">
            <div className="flex items-center gap-3 text-[10px] text-zinc-500 font-bold uppercase tracking-wider">
              <span className="h-px flex-1 bg-zinc-800" />
              On-chain · no login
              <span className="h-px flex-1 bg-zinc-800" />
            </div>
            <button
              onClick={() => navigate("/play")}
              className="w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-zinc-950 font-black py-4 rounded-xl text-base uppercase tracking-widest shadow-lg transition-all gold-glow-hover active:scale-95"
            >
              🃏 Play vs Dealer
            </button>
            <button
              onClick={() => navigate("/bot")}
              className="w-full bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 font-bold py-3 rounded-xl text-sm uppercase tracking-wider transition-all active:scale-95"
            >
              👀 Watch Bot Arena
            </button>
          </div>
        </div>
      </GameCardScale>
    </div>
  );
}
