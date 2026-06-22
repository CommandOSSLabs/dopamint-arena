import { useEffect, useState, useRef } from "react";
import {
  useBotGame,
  type Difficulty,
} from "@/games/ticTacToe/app/hooks/useBotGame";
import { useCaroBotGame } from "@/games/ticTacToe/app/hooks/useCaroBotGame";
import {
  useCustomWallet,
  CustomWalletProvider,
} from "@/games/ticTacToe/app/contexts/CustomWallet";
import { parseAgentConfig } from "@/agent/agentConfig";
import { LoginScene } from "@/games/ticTacToe/app/scenes/LoginScene";
import {
  SetupScene,
  type PlayMode,
  type GameType,
} from "@/games/ticTacToe/app/scenes/SetupScene";
import { GameScene } from "@/games/ticTacToe/app/scenes/GameScene";
import { PvpScene } from "@/games/ticTacToe/app/scenes/PvpScene";
import { GameCardScale } from "@/games/ticTacToe/app/components/GameCardScale";
import "./index.css";

type Scene = "login" | "setup" | "game" | "pvp";

function AppContent() {
  const { isConnected } = useCustomWallet();
  const [scene, setScene] = useState<Scene>("login");
  const [mode, setMode] = useState<PlayMode>("auto");
  const [difficulty, setDifficulty] = useState<Difficulty>("fast");
  const [gameType, setGameType] = useState<GameType>("ttt");
  const [boardSize, setBoardSize] = useState<number>(15);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 1024, height: 768 });

  // Both hooks are always called (rules of hooks); only the active one is driven. They share
  // the same bot identities and SuiClient, so the idle hook costs only one extra balance read.
  const tttGame = useBotGame(difficulty);
  const caroGame = useCaroBotGame(difficulty, boardSize);
  const g = gameType === "caro" ? caroGame : tttGame;

  const funded = g.balances.x > 0n && g.balances.o > 0n;

  // Track the actual container element's parent bounds to determine orientation
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const parent = el.parentElement;
    if (!parent) return;

    const handleResize = () => {
      const w = parent.clientWidth || window.innerWidth;
      const h = parent.clientHeight || window.innerHeight;
      setDimensions({ width: w, height: h });
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(parent);
    handleResize();

    return () => observer.disconnect();
  }, []);

  // If the wallet disconnects, fall back to the login scene (and stop any loop).
  useEffect(() => {
    if (!isConnected && scene !== "login") {
      tttGame.stopAuto();
      caroGame.stopAuto();
      setScene("login");
    }
  }, [isConnected, scene, tttGame, caroGame]);

  // Auto-Pilot flow to skip login and setup, randomize settings, fund bots, and start playing
  useEffect(() => {
    if (!isConnected) return;

    const arena = parseAgentConfig(window.location.href).arena;

    const hasNavigated = sessionStorage.getItem("tictactoe_auto_navigated");
    if (scene === "login" && !hasNavigated) {
      sessionStorage.setItem("tictactoe_auto_navigated", "true");

      // Under ?arena the injected wallet is already connected; land on setup so the
      // script can click ttt-tab-bots / ttt-fund-wallet / ttt-start directly.
      if (arena) {
        setScene("setup");
        return;
      }

      const randomGameType = Math.random() > 0.5 ? "caro" : "ttt";
      const randomDifficulty = "fast";
      const randomBoardSize = ([15, 19, 25] as const)[
        Math.floor(Math.random() * 3)
      ];

      setGameType(randomGameType);
      setDifficulty(randomDifficulty);
      setBoardSize(randomBoardSize);
      setMode("auto");

      setScene("setup");
      return;
    }

    // Under ?arena the script drives funding and game start — stop here on setup.
    if (arena) return;

    if (scene === "setup") {
      if (g.phase === "funding") return;

      if (!funded) {
        console.log("[tictactoe] Auto-funding bots...");
        g.fund();
      } else {
        console.log("[tictactoe] Bots funded. Starting game automatically...");
        const timer = setTimeout(() => {
          setScene("game");
          g.startAuto();
        }, 1000);
        return () => clearTimeout(timer);
      }
    }
  }, [isConnected, scene, funded, g]);

  const start = () => {
    setScene("game");
    if (mode === "auto") g.startAuto();
    else g.newGame();
  };

  const backToSetup = () => {
    tttGame.stopAuto();
    caroGame.stopAuto();
    setScene("setup");
  };

  const isPortrait = dimensions.width < dimensions.height;
  let targetWidth = 500;
  let targetHeight = 750;

  if (scene === "login") {
    targetWidth = isPortrait ? 500 : 800;
    targetHeight = isPortrait ? 800 : 500;
  } else if (scene === "setup") {
    targetWidth = isPortrait ? 500 : 1000;
    targetHeight = isPortrait ? 800 : 900;
  } else if (scene === "game") {
    targetWidth = isPortrait ? 500 : 980;
    targetHeight = isPortrait ? 800 : 850;
    if (gameType === "caro") targetHeight = isPortrait ? 850 : 900;
  } else if (scene === "pvp") {
    targetWidth = isPortrait ? 500 : 1060;
    targetHeight = isPortrait ? 800 : 900;
    if (gameType === "caro") targetHeight = isPortrait ? 850 : 950;
  }

  return (
    <div
      className={`h-full w-full relative notebook-grid-bg text-on-surface selection:bg-tertiary selection:text-on-tertiary flex items-center justify-center overflow-hidden select-none ${isPortrait ? "p-0" : "p-4"}`}
    >
      {/* Vertical Margin Line (Notebook binding line) */}
      {!isPortrait && (
        <div className="absolute top-0 bottom-0 left-[20px] md:left-[32px] w-0 border-l-double border-l-[3px] border-secondary z-0 pointer-events-none opacity-80" />
      )}

      <div
        ref={containerRef}
        className={`w-full h-full flex items-center justify-center z-10 ${isPortrait ? "pl-0" : "pl-[20px] md:pl-[32px]"}`}
      >
        <GameCardScale
          targetWidth={targetWidth}
          targetHeight={targetHeight}
          isPortrait={isPortrait}
        >
          {scene === "login" && (
            <LoginScene
              onContinue={() => setScene("setup")}
              onPlayOnline={() => setScene("pvp")}
            />
          )}

          {scene === "setup" && (
            <SetupScene
              balances={{ x: g.balances.x, o: g.balances.o }}
              onFund={g.fund}
              funding={g.phase === "funding"}
              onRefresh={g.refresh}
              onRebalance={g.rebalance}
              rebalancing={g.rebalancing}
              funded={funded}
              maxGames={g.maxGames}
              setMaxGames={g.setMaxGames}
              difficulty={difficulty}
              setDifficulty={setDifficulty}
              gameType={gameType}
              setGameType={setGameType}
              boardSize={boardSize}
              setBoardSize={setBoardSize}
              onStart={start}
              onBack={() => setScene("login")}
              isPortrait={isPortrait}
            />
          )}

          {scene === "game" && (
            <GameScene
              g={g}
              mode={mode}
              gameType={gameType}
              onBack={backToSetup}
              isPortrait={isPortrait}
            />
          )}
          {scene === "pvp" && (
            <PvpScene
              onBack={() => setScene("login")}
              isPortrait={isPortrait}
            />
          )}
        </GameCardScale>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <CustomWalletProvider>
      <AppContent />
    </CustomWalletProvider>
  );
}
