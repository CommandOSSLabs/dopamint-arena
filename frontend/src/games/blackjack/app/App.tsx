import { useEffect, useRef } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { Toaster } from "sonner";
import Home from "@/games/blackjack/app/pages/Home";
import PlayerBot from "@/games/blackjack/app/pages/PlayerBot";
import PvpBlackjack from "@/games/blackjack/app/pages/PvpBlackjack";
import {
  GameRouterProvider,
  useCurrentRoute,
  useGameNavigate,
} from "./useGameRouter";
import { ScaledWrapper } from "./components/app/ScaledWrapper";
import "../blackjack.css";

function AppContent() {
  const currentRoute = useCurrentRoute();
  const navigate = useGameNavigate();
  const account = useCurrentAccount();

  // One-shot auto-pilot: jump into the bot-vs-bot arena when the wallet first
  // connects. Lives in the persistent shell (not Home) and is guarded by a ref
  // that survives route changes, so navigating BACK to the menu does NOT pull
  // the user into bot mode again.
  const autoNavRef = useRef(false);
  useEffect(() => {
    if (account && !autoNavRef.current) {
      autoNavRef.current = true;
      navigate("/bot");
    }
  }, [account, navigate]);

  switch (currentRoute) {
    case "/":
      return <Home />;
    case "/bot":
      return <PlayerBot />;
    case "/pvp":
      return <PvpBlackjack />;
    default:
      return <Home />;
  }
}

export default function App() {
  return (
    <GameRouterProvider>
      <div className="w-full h-full relative overflow-hidden bg-zinc-950">
        <ScaledWrapper>
          <AppContent />
        </ScaledWrapper>
        <Toaster
          position="top-right"
          theme="dark"
          toastOptions={{
            style: {
              background: "#09090b",
              color: "#f4f4f5",
              border: "1px solid #27272a",
              borderRadius: "12px",
            },
          }}
        />
      </div>
    </GameRouterProvider>
  );
}
