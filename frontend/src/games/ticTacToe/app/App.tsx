import { useCallback, useEffect, useRef, useState } from "react";
import { useSoloCabinet } from "@/shell/cabinet/soloCabinet";
import {
  useBotGame,
  type Difficulty,
} from "@/games/ticTacToe/app/hooks/useBotGame";
import { useCaroBotGame } from "@/games/ticTacToe/app/hooks/useCaroBotGame";
import {
  useCustomWallet,
  CustomWalletProvider,
} from "@/games/ticTacToe/app/contexts/CustomWallet";
import { loadOrCreateBots, buildFundTx } from "@/games/ticTacToe/app/lib/bots";
import { LoginScene } from "@/games/ticTacToe/app/scenes/LoginScene";
import type {
  PlayMode,
  GameType,
} from "@/games/ticTacToe/app/scenes/SetupScene";
import { SetupScene } from "@/games/ticTacToe/app/scenes/SetupScene";
import { GameScene } from "@/games/ticTacToe/app/scenes/GameScene";
import { PvpScene } from "@/games/ticTacToe/app/scenes/PvpScene";
import { GameCardScale } from "@/games/ticTacToe/app/components/GameCardScale";
import { isMtpsConfigured } from "@/onchain/mtps";
import { SketchDefs } from "@/games/blackjack/app/App";
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

  // MTPS mode (ADR-0010): bots play free (sponsored gas + faucet-minted stake), so they need
  // no SUI — they're always "funded". SUI fallback still requires a positive gas balance per bot.
  const funded = isMtpsConfigured || (g.balances.x > 0n && g.balances.o > 0n);

  // --- Shared arcade-cabinet seam (GameCabinet, applied to every window in Desktop). The shell
  // owns hover → pause → overlay; this game wires the verbs to its engine. Take-over reuses the
  // in-game manual play (setAuto(false) → you drive X); offerable only while auto-playing.
  const { setAuto, pause: gPause, resume: gResume } = g;
  const offerable = scene === "game" && g.auto;
  // "Return to Home" → the game's title screen (login), stopping the auto-play loop. Stable refs
  // (stopAuto is useCallback'd) so the controller doesn't re-register every render. Does NOT reset
  // the auto-pilot one-shots, so re-entering "Play vs Bot" lands on setup (not an auto-start).
  const stopTttAuto = tttGame.stopAuto;
  const stopCaroAuto = caroGame.stopAuto;
  const goToGameHome = useCallback(() => {
    stopTttAuto();
    stopCaroAuto();
    setScene("login");
  }, [stopTttAuto, stopCaroAuto]);
  // Hand X to the human (flip to manual play). Stable so the controller doesn't re-register.
  const goManual = useCallback(() => setAuto(false), [setAuto]);
  useSoloCabinet({
    offerable,
    pause: gPause,
    resume: gResume,
    goManual,
    goHome: goToGameHome,
  });

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
        // Fresh window (auto-piloted from login, startNonce 0) starts in watch; entering from
        // the main menu means the user pressed Start (startNonce > 0) → start in manual.
        g.startAuto(startNonce === 0);
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
  // ONE fixed design size per orientation for the WHOLE game (like blackjack's ScaledWrapper):
  // every scene fills this box and the whole card scales uniformly to the window, instead of each
  // scene resizing to its own target. Sized to the tallest scene (caro board / pvp) so nothing is
  // clipped; lighter scenes (login/setup) just center within it.
  const targetWidth = isPortrait ? 500 : 1024;
  // Login is a centered content card → use Blackjack's shorter 1024×640 landscape box so it scales
  // up to the same size (a 900-tall box shrinks it ~30%). Setup/PvP fill the box (`h-[98%]`) and
  // were sized for 900, so keep theirs.
  const targetHeight = isPortrait ? 850 : scene === "login" ? 640 : 900;

  return (
    <div
      className={`ttt-root qp-sketch h-full w-full relative flex items-center justify-center overflow-hidden select-none ${isPortrait ? "p-0" : scene === "game" ? "p-1" : "p-4"}`}
    >
      <SketchDefs />

      <div
        ref={containerRef}
        className={`w-full h-full flex items-center justify-center z-10 ${
          // The game & pvp scenes lay themselves out responsively (3 panes + a flex-1 board) and
          // must fill the real window — wrapping them in the fixed 1024×900 GameCardScale
          // letterboxes them and pinches the board. Only login/setup use the fixed design box.
          scene === "game" || scene === "pvp"
            ? ""
            : isPortrait
              ? "pl-0"
              : "pl-[20px] md:pl-[32px]"
        }`}
      >
        {scene === "game" ? (
          <GameScene
            g={g}
            mode={mode}
            gameType={gameType}
            onBack={backToSetup}
            onMenu={goToGameHome}
            isPortrait={isPortrait}
          />
        ) : scene === "pvp" ? (
          <PvpScene onBack={() => setScene("login")} isPortrait={isPortrait} />
        ) : (
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

            {scene === "setup" &&
            (g.phase === "error" ? (
              <div className="w-full h-full flex flex-col items-center justify-center gap-6 p-8">
                <p className="text-sm text-rose-400 text-center break-words max-w-md">
                  {/* The real failure (e.g. "sponsor request failed (422): …"), not the bare
                      "error" phase — so the cause is visible instead of hidden. */}
                  {g.error ?? "Something went wrong."}
                </p>
                <button
                  onClick={() => {
                    // Resume the attract demo: clear the one-shot latches and restart in watch.
                    // (Without this the latches stayed set and Retry did nothing.)
                    autoFundRef.current = false;
                    autoEvenedRef.current = false;
                    autoStartedRef.current = true;
                    setScene("game");
                    g.startAuto(true);
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
                preparingLabel={
                  preparing
                    ? "Setting up bots…"
                    : g.rebalancing
                      ? "Preparing bots…"
                      : undefined
                }
              />
            ))}
          </GameCardScale>
        )}
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
