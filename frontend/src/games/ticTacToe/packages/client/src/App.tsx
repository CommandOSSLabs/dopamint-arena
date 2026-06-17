import { useEffect, useState } from "react";
import { useBotGame, type Difficulty } from "@/hooks/useBotGame";
import { useCustomWallet } from "@/contexts/CustomWallet";
import { LoginScene } from "@/scenes/LoginScene";
import { SetupScene, type PlayMode } from "@/scenes/SetupScene";
import { GameScene } from "@/scenes/GameScene";
import { GameCardScale } from "@/components/GameCardScale";

type Scene = "login" | "setup" | "game";

export default function App() {
  const [scene, setScene] = useState<Scene>("login");
  const [mode, setMode] = useState<PlayMode>("auto");
  const [difficulty, setDifficulty] = useState<Difficulty>("even");
  const [windowWidth, setWindowWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);
  const [windowHeight, setWindowHeight] = useState(typeof window !== "undefined" ? window.innerHeight : 768);

  const { isConnected } = useCustomWallet();
  const g = useBotGame(difficulty);

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
      g.stopAuto();
      setScene("login");
    }
  }, [isConnected, scene, g]);

  const start = () => {
    setScene("game");
    if (mode === "auto") g.startAuto();
    else g.newGame();
  };

  const backToSetup = () => {
    g.stopAuto();
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
    targetWidth = isPortrait ? 450 : 880;
    targetHeight = isPortrait ? 780 : 620;
  }

  return (
    <div className="h-screen w-screen relative notebook-grid-bg text-on-surface selection:bg-tertiary selection:text-on-tertiary flex items-center justify-center p-4 overflow-hidden select-none">
      {/* Vertical Margin Line (Notebook binding line) */}
      <div className="fixed top-0 bottom-0 left-[40px] md:left-[80px] w-0 border-l-double border-l-[3px] border-secondary z-0 pointer-events-none opacity-80" />

      <div className="w-full h-full flex items-center justify-center z-10 pl-[40px] md:pl-[80px]">
        <GameCardScale targetWidth={targetWidth} targetHeight={targetHeight}>
          {scene === "login" && <LoginScene onContinue={() => setScene("setup")} />}

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
              onStart={start}
              onBack={() => setScene("login")}
            />
          )}

          {scene === "game" && <GameScene g={g} mode={mode} onBack={backToSetup} isPortrait={isPortrait} />}
        </GameCardScale>
      </div>
    </div>
  );
}
