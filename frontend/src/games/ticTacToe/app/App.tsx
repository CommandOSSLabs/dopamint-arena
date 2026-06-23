import { useEffect, useState, useRef, useCallback } from "react";
import {
  useBotGame,
  type Difficulty,
} from "@/games/ticTacToe/app/hooks/useBotGame";
import { useCaroBotGame } from "@/games/ticTacToe/app/hooks/useCaroBotGame";
import {
  useCustomWallet,
  CustomWalletProvider,
} from "@/games/ticTacToe/app/contexts/CustomWallet";
import {
  loadOrCreateBots,
  buildFundTx,
} from "@/games/ticTacToe/app/lib/bots";
import { LoginScene } from "@/games/ticTacToe/app/scenes/LoginScene";
import type { PlayMode, GameType } from "@/games/ticTacToe/app/scenes/SetupScene";
import { SetupScene } from "@/games/ticTacToe/app/scenes/SetupScene";
import { GameScene } from "@/games/ticTacToe/app/scenes/GameScene";
import { PvpScene } from "@/games/ticTacToe/app/scenes/PvpScene";
import { GameCardScale } from "@/games/ticTacToe/app/components/GameCardScale";
import "./index.css";

type Scene = "login" | "setup" | "game" | "pvp";

// A bot below this gets topped up — just above the hook's MIN_PLAY floor (0.02 SUI) so it keeps
// playing. Even the bots before spending wallet SUI; only fund when the pair is genuinely short.
const MIN_BOT_BALANCE_MIST = 30_000_000n; // 0.03 SUI

function AppContent() {
  const { isConnected, executeTransaction } = useCustomWallet();
  const [scene, setScene] = useState<Scene>("login");
  const [mode, setMode] = useState<PlayMode>("auto");
  const [difficulty, setDifficulty] = useState<Difficulty>("fast");
  const [gameType, setGameType] = useState<GameType>("caro");
  const [boardSize, setBoardSize] = useState<number>(19);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 1024, height: 768 });

  // Both hooks are always called (rules of hooks); only the active one is driven. They share
  // the same bot identities and SuiClient, so the idle hook costs only one extra balance read.
  const tttGame = useBotGame(difficulty);
  const caroGame = useCaroBotGame(difficulty, boardSize);
  const g = gameType === "caro" ? caroGame : tttGame;

  const funded =
    g.balances.x >= MIN_BOT_BALANCE_MIST && g.balances.o >= MIN_BOT_BALANCE_MIST;

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

  const autoNavRef = useRef(false);
  const autoEvenedRef = useRef(false);
  const autoFundRef = useRef(false);
  const autoStartedRef = useRef(false);
  // Bumped by the Start button to re-trigger auto-pilot after Back returns to config.
  const [startNonce, setStartNonce] = useState(0);
  // True while a wallet fund tx is in-flight — drives the "Setting up bots…" indicator.
  const [preparing, setPreparing] = useState(false);

  // Resets one-shot refs and bumps startNonce so the auto-pilot effect re-runs the
  // even/fund/start path. Back never calls this, so config stays after Back.
  const handleStart = useCallback(() => {
    autoEvenedRef.current = false;
    autoFundRef.current = false;
    autoStartedRef.current = false;
    setStartNonce((n) => n + 1);
  }, []);

  // Auto-pilot: skip login → setup → even bots / wallet-fund if low → start bot-vs-bot.
  // Bots are SHARED across all ttt windows (loadOrCreateBots reads shared localStorage),
  // so opening a 2nd ttt window double-funds and races the same keypair on tunnel-open —
  // one window wins, the others error. The desktop seeds one window per game; concurrent
  // same-game windows are not supported here.
  useEffect(() => {
    if (!isConnected) return;

    if (scene === "login") {
      if (!autoNavRef.current) {
        autoNavRef.current = true;
        setGameType("caro");
        setDifficulty("fast");
        setBoardSize(19);
        setMode("auto");
        setScene("setup");
      }
      return;
    }

    if (scene === "setup") {
      if (!g.balancesLoaded) return;
      if (!funded) {
        const combined = g.balances.x + g.balances.o;
        const diff =
          g.balances.x > g.balances.o
            ? g.balances.x - g.balances.o
            : g.balances.o - g.balances.x;
        // Even the bots first: if shifting half the surplus from the richer bot lifts the
        // poorer one over the bar, do that cheap bot→bot transfer instead of a wallet top-up.
        // Only fund from the wallet when the pair is genuinely short.
        if (
          !autoEvenedRef.current &&
          diff >= 4_000_000n &&
          combined >= 2n * MIN_BOT_BALANCE_MIST
        ) {
          autoEvenedRef.current = true;
          g.rebalance();
          return;
        }
        if (!autoFundRef.current) {
          autoFundRef.current = true; // fund AT MOST ONCE per window (Global Constraint)
          console.log("[tictactoe] funding bots from wallet…");
          setPreparing(true);
          void (async () => {
            try {
              await executeTransaction({ tx: buildFundTx(loadOrCreateBots()) });
              await g.refresh();
            } catch (e) {
              // Do NOT reset autoFundRef — a retry would re-fire against the unstable
              // `g` dep and risk an infinite real-SUI fund loop. On failure the SetupScene
              // surfaces the error and the manual fund button remains as the recovery path.
              console.error("[tictactoe] wallet fund failed", e);
            } finally {
              setPreparing(false);
            }
          })();
        }
        return;
      }
      if (!autoStartedRef.current) {
        autoStartedRef.current = true;
        setScene("game");
        g.startAuto();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, scene, funded, g, executeTransaction, startNonce]);

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
            g.phase === "error" ? (
              <div className="w-full h-full flex flex-col items-center justify-center gap-6 p-8">
                <p className="text-sm text-rose-400 text-center break-words max-w-xs">
                  {String(g.phase)}
                </p>
                <button
                  onClick={() => {
                    autoFundRef.current = false;
                    autoEvenedRef.current = false;
                  }}
                  className="px-4 py-2 text-xs font-bold uppercase tracking-widest border border-secondary text-on-surface hover:bg-secondary/20 rounded transition-colors"
                >
                  Retry
                </button>
              </div>
            ) : (
              <SetupScene
                funded={funded && !preparing}
                maxGames={g.maxGames}
                setMaxGames={g.setMaxGames}
                difficulty={difficulty}
                setDifficulty={setDifficulty}
                gameType={gameType}
                setGameType={setGameType}
                boardSize={boardSize}
                setBoardSize={setBoardSize}
                onStart={handleStart}
                onBack={() => setScene("login")}
                isPortrait={isPortrait}
                preparingLabel={preparing ? "Setting up bots…" : g.rebalancing ? "Preparing bots…" : undefined}
              />
            )
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
