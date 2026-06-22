import { useEffect } from "react";
import { ConnectButton, useCurrentAccount } from "@mysten/dapp-kit";
import { useGameNavigate } from "@/games/blackjack/app/useGameRouter";
import { parseAgentConfig } from "@/agent/agentConfig";

export default function Home() {
  const navigate = useGameNavigate();
  const account = useCurrentAccount();

  useEffect(() => {
    document.title = "Blackjack";
  }, []);

  useEffect(() => {
    const hasNavigated = sessionStorage.getItem("blackjack_auto_navigated");
    if (account && !hasNavigated) {
      sessionStorage.setItem("blackjack_auto_navigated", "true");
      // Under ?arena the script clicks bj-watch-bots to navigate to /bot — skip the auto-redirect.
      if (!parseAgentConfig(window.location.href).arena) navigate("/play");
    }
  }, [account, navigate]);

  return (
    <div className="w-full h-full flex flex-col items-center justify-center menu-background relative text-white overflow-hidden select-none">
      <div className="bg-zinc-950/90 border border-zinc-800 rounded-3xl p-8 md:p-12 w-[85%] max-w-4xl shadow-2xl z-10 flex flex-col items-center fade-in-up">
        <img
          src="/blackjack-logo-gold.svg"
          alt="Blackjack Logo"
          className="w-24 h-24 md:w-32 md:h-32 mb-4 filter drop-shadow-lg transition-transform hover:scale-105"
        />
        <h1 className="text-4xl md:text-5xl font-extrabold text-gold font-serif mb-8 tracking-widest uppercase text-center">
          BLACKJACK
        </h1>

        {/* Connect a Sui wallet first; the game options unlock once connected (the wallet
              funds PvP stakes + receives winnings). */}
        <div className="w-full space-y-4">
          <div className="flex items-center gap-3 text-[10px] md:text-xs text-zinc-500 font-bold uppercase tracking-wider mb-2">
            <span className="h-px flex-1 bg-zinc-800" />
            {account ? "On-chain · connected" : "Connect wallet to play"}
            <span className="h-px flex-1 bg-zinc-800" />
          </div>

          <div className="flex justify-center pb-2">
            <div className="scale-110 origin-center">
              <ConnectButton />
            </div>
          </div>

          {account ? (
            <>
              <button
                onClick={() => navigate("/play")}
                className="w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-zinc-950 font-black py-4 md:py-5 rounded-xl text-lg md:text-xl uppercase tracking-widest shadow-lg transition-all gold-glow-hover active:scale-95"
              >
                🃏 Play vs Dealer
              </button>
              <button
                onClick={() => navigate("/bot")}
                data-testid="bj-watch-bots"
                className="w-full bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 font-bold py-4 rounded-xl text-sm md:text-base uppercase tracking-wider transition-all active:scale-95"
              >
                👀 Watch Bot Arena
              </button>
              <button
                onClick={() => navigate("/pvp")}
                className="w-full bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 font-bold py-4 rounded-xl text-sm md:text-base uppercase tracking-wider transition-all active:scale-95 mt-4"
              >
                🌐 Play vs Player (online)
              </button>
            </>
          ) : (
            <p className="text-center text-sm text-zinc-500 pt-2">
              Connect a Sui wallet to enter.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
