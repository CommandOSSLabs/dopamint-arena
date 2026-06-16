import { useEffect, useState } from "react";
import { useAuthentication } from "@/contexts/Authentication";
import { useCustomWallet } from "@/contexts/CustomWallet";
import { useBalance } from "@/contexts/BalanceContext";
import { useRequestBuck } from "@/hooks/useRequestBuck";
import { toFixedWithoutRounding } from "@/lib/utils/toFixedWithoutRounding";
import { LoginForm } from "@/components/forms/LoginForm";
import { useNavigate } from "react-router-dom";
import { SuitSpinner } from "@/components/general/SuitSpinner";
import useBlackJack from "@/hooks/useBlackJack";
import { LoadingModal } from "@/components/general/LoadingModal";
import { GameCardScale } from "@/components/general/GameCardScale";
import { Copy, Check } from "lucide-react";
import toast from "react-hot-toast";

export default function Home() {
  const navigate = useNavigate();
  const { user, handleLogout } = useAuthentication();
  const { isConnected, address, logout: walletLogout } = useCustomWallet();
  const { balance } = useBalance();
  const { handleRequestBuck, loading: requestingBuck } = useRequestBuck();
  const { gameId, isFetchingGame } = useBlackJack();

  const [copied, setCopied] = useState(false);

  const handleCopyAddress = () => {
    if (!address) return;
    navigator.clipboard.writeText(address);
    toast.success("Address copied to clipboard");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    document.title = "Blackjack";
  }, []);

  // If already in an active game, redirect player to game screen
  useEffect(() => {
    if (user.role === "player" && gameId) {
      navigate("/player/game");
    }
  }, [user.role, gameId, navigate]);

  const onLogout = () => {
    walletLogout();
    handleLogout();
  };

  const isPlayerLoggedIn = user.role === "player" && isConnected;

  return (
    <div className="w-screen h-screen flex flex-col items-center justify-center menu-background relative text-white overflow-hidden select-none">
      <GameCardScale>
        <div className="bg-zinc-950/90 border border-zinc-800 rounded-2xl p-6 md:p-8 w-full max-w-md shadow-2xl z-10 flex flex-col items-center fade-in-up">
          <img src="/blackjack-logo-gold.svg" alt="Blackjack Logo" className="w-24 h-24 mb-3 filter drop-shadow-lg" />
          <h1 className="text-4xl font-extrabold text-gold font-serif mb-6 tracking-widest uppercase text-center">BLACKJACK</h1>
          
          {isFetchingGame ? (
            <div className="py-4">
              <SuitSpinner />
            </div>
          ) : isPlayerLoggedIn ? (
            /* Logged In Main Menu */
            <div className="w-full space-y-6 flex flex-col items-center">
              {/* User Info Badge */}
              <div className="w-full p-4 bg-zinc-900/60 border border-zinc-800/80 rounded-xl flex flex-col items-center gap-1.5 shadow-inner">
                <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Account</div>
                <div className="flex items-center gap-2 bg-zinc-950/60 px-3 py-1.5 rounded-lg border border-zinc-800/60 shadow-inner max-w-full">
                  <span className="text-xs font-mono text-zinc-300 select-all truncate">
                    {address ? `${address.slice(0, 6)}...${address.slice(-6)}` : "No wallet connected"}
                  </span>
                  {address && (
                    <button
                      onClick={handleCopyAddress}
                      className="p-1 text-zinc-500 hover:text-[#d4af37] transition-colors rounded hover:bg-zinc-900/80 active:scale-90 flex items-center justify-center cursor-pointer"
                      title="Copy Address"
                    >
                      {copied ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </div>
                <div className="w-full border-t border-zinc-800/60 my-1"></div>
                <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Balance</div>
                <div className="text-2xl font-black text-gold font-mono tracking-wide">
                  ${toFixedWithoutRounding(balance, 2)} <span className="text-xs font-sans font-medium text-zinc-400">{import.meta.env.VITE_COIN_SYMBOL}</span>
                </div>
              </div>

              {/* Main Menu Options */}
              <div className="w-full space-y-3">
                <button
                  onClick={() => navigate("/player")}
                  className="w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-zinc-950 font-black py-4 rounded-xl text-base uppercase tracking-widest shadow-lg transition-all gold-glow-hover active:scale-95"
                >
                  Start Game
                </button>

                <button
                  onClick={handleRequestBuck}
                  className="w-full bg-zinc-900 hover:bg-zinc-850 text-zinc-300 hover:text-white border border-zinc-800 font-bold py-3 rounded-xl text-sm uppercase tracking-wider transition-all active:scale-95"
                >
                  Request BUCK
                </button>
              </div>

              {/* Footer Navigation */}
              <div className="w-full flex justify-between items-center pt-4 border-t border-zinc-850">
                <button
                  className="text-xs text-zinc-500 hover:text-gold transition-colors font-semibold"
                  onClick={() => navigate("/dealer")}
                >
                  Dealer Panel
                </button>
                <button
                  className="text-xs text-zinc-500 hover:text-rose-400 transition-colors font-semibold"
                  onClick={onLogout}
                >
                  Logout
                </button>
              </div>
            </div>
          ) : (
            /* Login Screen */
            <div className="w-full">
              <LoginForm />
            </div>
          )}

          {/* On-chain tunnel demos, no login required: play the dealer yourself, or watch
              two bots self-play. */}
          <div className="mt-4 flex flex-col items-center gap-2">
            <button
              onClick={() => navigate("/play")}
              className="text-sm text-gold hover:text-amber-300 transition-colors font-bold uppercase tracking-wider"
            >
              Play vs Dealer →
            </button>
            <button
              onClick={() => navigate("/bot")}
              className="text-xs text-zinc-500 hover:text-gold transition-colors font-semibold uppercase tracking-wider"
            >
              Watch Bot Arena →
            </button>
          </div>
        </div>
      </GameCardScale>

      <LoadingModal isOpen={requestingBuck} message="Requesting BUCK tokens..." />
    </div>
  );
}
