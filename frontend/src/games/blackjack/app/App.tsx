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

function AppContent({ windowId }: { windowId: string }) {
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

  // Per-window auto-start latch (see PlayerBot): App-scoped so each blackjack window auto-starts
  // its watch independently, and survives the back-to-menu → re-enter remount of PlayerBot.
  const autoStartedRef = useRef(false);

  switch (currentRoute) {
    case "/":
      return <Home />;
    case "/bot":
      return <PlayerBot autoStarted={autoStartedRef} windowId={windowId} />;
    case "/pvp":
      return <PvpBlackjack />;
    default:
      return <Home />;
  }
}

export function SketchDefs() {
  return (
    <svg aria-hidden width="0" height="0" className="qp-defs">
      <filter id="qpRough" x="-6%" y="-6%" width="112%" height="112%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.018"
          numOctaves={2}
          seed={7}
          result="noise"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="noise"
          scale="2.6"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}

export default function App({ windowId }: { windowId: string }) {
  return (
    <GameRouterProvider>
      <div className="bj-root qp-sketch w-full h-full relative overflow-hidden">
        <SketchDefs />
        <ScaledWrapper>
          <AppContent windowId={windowId} />
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
