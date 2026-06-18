import { useEffect, useState } from "react";
import { useBotGame, type Difficulty } from "@/hooks/useBotGame";
import { useCaroBotGame } from "@/hooks/useCaroBotGame";
import { useCustomWallet } from "@/contexts/CustomWallet";
import { LoginScene } from "@/scenes/LoginScene";
import { SetupScene, type PlayMode, type GameType } from "@/scenes/SetupScene";
import { GameScene } from "@/scenes/GameScene";
import { PvpScene } from "@/scenes/PvpScene";
import { GameCardScale } from "@/components/GameCardScale";

type Scene = "login" | "setup" | "game" | "pvp";

export default function App() {
  const [scene, setScene] = useState<Scene>("login");
  const [mode, setMode] = useState<PlayMode>("auto");
  const [difficulty, setDifficulty] = useState<Difficulty>("even");
  const [gameType, setGameType] = useState<GameType>("ttt");
  const [boardSize, setBoardSize] = useState<number>(15);
  const [windowWidth, setWindowWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);
  const [windowHeight, setWindowHeight] = useState(typeof window !== "undefined" ? window.innerHeight : 768);

  const { isConnected } = useCustomWallet();
  // Both hooks are always called (rules of hooks); only the active one is driven. They share
  // the same bot identities and SuiClient, so the idle hook costs only one extra balance read.
  const tttGame = useBotGame(difficulty);
  const caroGame = useCaroBotGame(difficulty, boardSize);
  const g = gameType === "caro" ? caroGame : tttGame;

  const funded = g.balances.x > 0n && g.balances.o > 0n;

  // Track window resizing to dynamically toggle scene target sizing
  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
      setWindowHeight(window.innerHeight);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // If the wallet disconnects, fall back to the login scene (and stop any loop).
  useEffect(() => {
    if (!isConnected && scene !== "login") {
      tttGame.stopAuto();
      caroGame.stopAuto();
      setScene("login");
    }
  }, [isConnected, scene, tttGame, caroGame]);

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

  const isPortrait = windowWidth < windowHeight;
  let targetWidth = 500;
  let targetHeight = 750;

  if (scene === "login") {
    targetWidth = 576;
    targetHeight = 650;
  } else if (scene === "setup") {
    targetWidth = 576;
    targetHeight = 580;
  } else if (scene === "game") {
    targetWidth = isPortrait ? 500 : 1060;
    targetHeight = isPortrait ? 1200 : 860;
    if (gameType === "caro") targetHeight = isPortrait ? 1300 : 960;
  } else if (scene === "pvp") {
    targetWidth = isPortrait ? 500 : 1060;
    targetHeight = isPortrait ? 1200 : 860;
  }

  return (
    <div className="h-screen w-screen relative notebook-grid-bg text-on-surface selection:bg-tertiary selection:text-on-tertiary flex items-center justify-center p-4 overflow-hidden select-none">
      {/* Vertical Margin Line (Notebook binding line) */}
      <div className="fixed top-0 bottom-0 left-[40px] md:left-[80px] w-0 border-l-double border-l-[3px] border-secondary z-0 pointer-events-none opacity-80" />

      <div className="w-full h-full flex items-center justify-center z-10 pl-[40px] md:pl-[80px]">
        <GameCardScale targetWidth={targetWidth} targetHeight={targetHeight}>
          {scene === "login" && <LoginScene onContinue={() => setScene("setup")} onPlayOnline={() => setScene("pvp")} />}

          {scene === "setup" && (
            <SetupScene
              balances={{ x: g.balances.x, o: g.balances.o }}
              onFund={g.fund}
              funding={g.phase === "funding"}
              onRefresh={g.refresh}
              onRebalance={g.rebalance}
              rebalancing={g.rebalancing}
              funded={funded}
              mode={mode}
              setMode={setMode}
              difficulty={difficulty}
              setDifficulty={setDifficulty}
              gameType={gameType}
              setGameType={setGameType}
              boardSize={boardSize}
              setBoardSize={setBoardSize}
              onStart={start}
              onBack={() => setScene("login")}
            />
          )}

          {scene === "game" && <GameScene g={g} mode={mode} gameType={gameType} onBack={backToSetup} isPortrait={isPortrait} />}
          {scene === "pvp" && <PvpScene onBack={() => setScene("login")} isPortrait={isPortrait} />}
        </GameCardScale>
      </div>
    </div>
  );
}
