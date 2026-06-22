import { Toaster } from "sonner";
import Home from "@/games/blackjack/app/pages/Home";
import PlayerBot from "@/games/blackjack/app/pages/PlayerBot";
import PlayerVsDealer from "@/games/blackjack/app/pages/PlayerVsDealer";
import PvpBlackjack from "@/games/blackjack/app/pages/PvpBlackjack";
import { GameRouterProvider, useCurrentRoute } from "./useGameRouter";
import { ScaledWrapper } from "./components/app/ScaledWrapper";
import "../blackjack.css";

function AppContent() {
  const currentRoute = useCurrentRoute();

  switch (currentRoute) {
    case "/":
      return <Home />;
    case "/play":
      return <PlayerVsDealer />;
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
