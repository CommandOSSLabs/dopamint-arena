import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRegisterCabinet } from "@/shell/cabinet/CabinetContext";
import type { CabinetController } from "@/shell/cabinet/CabinetController";
import { ArrowLeft, Bot, Check, Crosshair, Users, Wallet } from "lucide-react";
import { ConnectModal, useCurrentAccount } from "@mysten/dapp-kit";
import { isEnokiWallet } from "@mysten/enoki";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { registerWindowDisposer } from "@/lib/windowSessions";
import type { GameWindowProps } from "../types";
import { PlacementBoard } from "./components/PlacementBoard";
import { BattleView } from "./components/BattleView";
import { useBattleship } from "./useBattleship";
import { useBattleshipPvp } from "./useBattleshipPvp";
import { SketchDefs } from "../sketch";
import "./battleship.css";

type Mode = "bot" | "pvp";

// Which mode a window is in, kept by windowId so a remount (minimize / maximize /
// desktop reflow) returns to the live game rather than the chooser. Cleared on close.
const modeStore = new Map<string, Mode | null>();

// Big pill actions in the shared hand-drawn "sketch" skin (matches Quantum Poker):
// amber-inked "go" for the primary, plain ink outline for the secondary. The
// `qp-btn` class carries the wobble border + cqmin sizing; we add layout utilities.
const BTN_PRIMARY =
  "sketch-btn sketch-btn--go inline-flex w-full items-center justify-center gap-2";
const BTN_SECONDARY =
  "sketch-btn inline-flex w-full items-center justify-center gap-2";

/**
 * Battleship over a REAL Sui tunnel. Both modes require a connected wallet (gas is
 * sponsored, so play is free): vs-Bot opens + funds a self-play tunnel from one
 * wallet; PvP matches a real opponent over the relay. Every shot is commit-revealed
 * and co-signed; the result settles on-chain. The session lives in a windowId-keyed
 * store, so minimizing or resizing the window never drops the game. ADR 0003.
 */
export function BattleshipWindow({ windowId }: GameWindowProps) {
  // Default straight into vs-Bot (it auto-starts with autopilot on); Back reaches the
  // chooser for PvP. A remount restores the window's last mode.
  const [mode, setModeState] = useState<Mode | null>(
    () => modeStore.get(windowId) ?? "bot",
  );
  useEffect(() => {
    registerWindowDisposer(windowId, "battleship-mode", () => {
      modeStore.delete(windowId);
    });
  }, [windowId]);
  const setMode = (m: Mode | null) => {
    if (m === null) modeStore.delete(windowId);
    else modeStore.set(windowId, m);
    setModeState(m);
  };

  // One size-container for the whole game so every pane sizes off the WINDOW's
  // width AND height (container queries + cqh units), not the viewport — correct
  // in a small floating window on a big screen, or full-width on mobile.
  return (
    <div className="sketch relative h-full min-h-0 overflow-hidden">
      {/* The roughen filter every `.qp-*` / `.bs-*` border references — rendered once. */}
      <SketchDefs />

      {/* Actual game layout sits on top */}
      <div className="relative z-20 h-full w-full">
        {mode === "bot" ? (
          <BotGame windowId={windowId} onExit={() => setMode(null)} />
        ) : mode === "pvp" ? (
          <PvpGame windowId={windowId} onExit={() => setMode(null)} />
        ) : (
          <ModeChooser onPick={setMode} />
        )}
      </div>
    </div>
  );
}

/** Home screen (reached via Back): pick an opponent — vs-Bot or a PvP match. */
function ModeChooser({ onPick }: { onPick: (m: Mode) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-5 text-center">
      <div className="flex flex-col items-center gap-1">
        <span className="sketch-eyebrow">You vs the sea</span>
        <h2 className="sketch-title text-[clamp(26px,9cqmin,40px)]">Battleship</h2>
        <p className="sketch-note mt-1 max-w-xs">
          Hide your fleet, then sink your foe's. Every shot is{" "}
          <span className="text-[var(--sketch-accent)]">commit-revealed</span> and
          co-signed in the tunnel — the winner settles on-chain.
        </p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2.5">
        <button onClick={() => onPick("bot")} className={BTN_PRIMARY}>
          <Bot className="size-4" /> Play vs Bot
        </button>
        <button onClick={() => onPick("pvp")} className={BTN_SECONDARY}>
          <Users className="size-4" /> Find Match · PvP
        </button>
      </div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="sketch-note flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      {children}
    </div>
  );
}

/** Wallet gate: every battleship match opens + settles a real tunnel, so a wallet
 *  is required (gas is sponsored — free to play). One-click connect via Enoki. */
function ConnectWalletPane({ note }: { note: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-5 text-center">
      <div className="flex flex-col items-center gap-1">
        <span className="sketch-eyebrow">Wallet required</span>
        <h3 className="sketch-title text-[clamp(20px,7cqmin,30px)]">
          Connect to play
        </h3>
        <p className="sketch-note mt-1 max-w-xs">{note}</p>
      </div>
      <ConnectModal
        walletFilter={isEnokiWallet}
        trigger={
          <button className={cn(BTN_PRIMARY, "max-w-xs")}>
            <Wallet className="size-4" /> Connect wallet
          </button>
        }
      />
    </div>
  );
}

/** Big tap-to-toggle "Auto" checkbox: hands your shots to autopilot vs the bot. */
function AutoToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      title="Let the bot play your shots too"
      className={cn(
        "sketch-btn inline-flex items-center gap-1",
        on && "sketch-btn--go",
      )}
    >
      <span className="grid size-[1.1em] place-items-center">
        {on ? <Check className="size-[0.9em]" strokeWidth={3} /> : "○"}
      </span>
      Auto
    </button>
  );
}

/** Header action: settle + close the multi-game tunnel now (allowed anytime). */
function SettleButton({ onSettle }: { onSettle: () => void }) {
  return (
    <button
      type="button"
      onClick={onSettle}
      title="Settle and close the tunnel now (cash out)"
      className="sketch-btn sketch-btn--go"
    >
      Settle
    </button>
  );
}

/** Shown while settling / after a multi-game session closes: the running tally + a
 *  way to start a fresh tunnel. */
function SettledPane({
  score,
  settling,
  onNewGame,
}: {
  score: { you: number; foe: number };
  settling: boolean;
  onNewGame: () => void;
}) {
  const games = score.you + score.foe;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-5 text-center">
      <div className="flex flex-col items-center gap-1">
        <span className="sketch-eyebrow">
          {settling ? "Settling" : "Session settled"}
        </span>
        <h3 className="sketch-title text-[clamp(20px,7cqmin,30px)]">
          {settling ? "Closing tunnel…" : "Settled ✓"}
        </h3>
        <p className="sketch-note mt-1 max-w-xs">
          You <span className="text-[var(--sketch-felt)]">{score.you}</span> –{" "}
          <span className="text-[var(--sketch-red)]">{score.foe}</span> Bot over{" "}
          {games} game{games === 1 ? "" : "s"} on one tunnel.
        </p>
      </div>
      {!settling && (
        <button onClick={onNewGame} className={cn(BTN_PRIMARY, "max-w-xs")}>
          <Crosshair className="size-4" /> New session
        </button>
      )}
    </div>
  );
}

/** Every mode renders inside this frame: a thin control strip carries the back button
 *  and optional trailing actions (Auto / Settle) — NOT a title, since the desktop window
 *  chrome above already shows one — with the mode's own UI filling the space below it. */
function ModeFrame({
  onBack,
  headerExtra,
  children,
}: {
  onBack: () => void;
  headerExtra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full w-full flex-col">
      {/* A thin in-game control strip. The window chrome above already shows the title,
          so this carries only the game actions (Back / Auto / Settle), kept compact. */}
      <header className="bs-head shrink-0 py-[clamp(4px,1.4cqmin,9px)]">
        <button
          onClick={onBack}
          className="sketch-btn inline-flex items-center gap-1"
        >
          <ArrowLeft className="size-[1em]" /> Back
        </button>
        {headerExtra && <div className="ml-auto shrink-0">{headerExtra}</div>}
      </header>
      {/* Scrolls vertically when a pane is taller than the window (e.g. stacked
          boards on a short phone); the radar background behind stays fixed. */}
      <div className="relative min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function ErrorPane({
  error,
  onBack,
}: {
  error: string | null;
  onBack: () => void;
}) {
  return (
    <Centered>
      <p className="text-[var(--sketch-red)]">{error ?? "something went wrong"}</p>
      <button onClick={onBack} className="sketch-btn">
        Back
      </button>
    </Centered>
  );
}

function settleLabel(status: string): string | undefined {
  if (status === "settling") return "settling on-chain…";
  if (status === "settled") return "settled ✓";
  return undefined;
}

function BotGame({
  windowId,
  onExit,
}: {
  windowId: string;
  onExit: () => void;
}) {
  const {
    status,
    view,
    error,
    fire,
    autoStartOnLoad,
    auto,
    setAuto,
    pause,
    resume,
    score,
    gamesPlayed,
    playNextGame,
    settleNow,
    reset,
  } = useBattleship(windowId);
  const account = useCurrentAccount();
  // Manual rematch: with autopilot off, "Play Again" re-opens the placement board to
  // deploy a fresh fleet for the next game on the SAME tunnel.
  const [placingNext, setPlacingNext] = useState(false);

  // First open: drop straight into an auto-played game once the wallet is ready
  // (idempotent — the session guards against re-opening a tunnel). Skipped while
  // the player is hand-placing the next game.
  useEffect(() => {
    if (!placingNext) autoStartOnLoad();
  }, [autoStartOnLoad, account?.address, status, placingNext]);

  // Stable refs so the cabinet controller below doesn't re-register every render.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const back = useCallback(() => {
    setPlacingNext(false);
    reset();
    onExitRef.current();
  }, [reset]);
  const newSession = useCallback(() => {
    setPlacingNext(false);
    reset();
  }, [reset]);

  // Arcade-cabinet take-over (shared GameCabinet shell, applied to every window).
  // While autopilot runs this is the "attract" state: hovering freezes the demo and
  // offers "Play vs Bot" — take-over reuses manual play (autopilot off). Inert
  // otherwise (connect / placement / manual / settled), so those scenes are untouched.
  const takeOver = useCallback(() => {
    setAuto(false);
    resume(); // unfreeze if the hover paused the loop
  }, [setAuto, resume]);
  const cabinet = useMemo<CabinetController>(
    () => ({
      active: auto && status === "playing",
      pause,
      resume,
      takeOver,
      returnHome: back,
    }),
    [auto, status, pause, resume, takeOver, back],
  );
  useRegisterCabinet(cabinet);

  const live = status === "playing";
  // State bar (top): which game + the running score.
  let content: ReactNode;
  if (!account && !view) {
    // No wallet → require connect before the on-chain match opens.
    content = (
      <ConnectWalletPane note="Bot matches open a real tunnel and settle on-chain — gas is sponsored, so it's free to play." />
    );
  } else if (status === "error") {
    content = <ErrorPane error={error} onBack={back} />;
  } else if (status === "settling" || status === "settled") {
    content = (
      <SettledPane
        score={score}
        settling={status === "settling"}
        onNewGame={newSession}
      />
    );
  } else if (status === "funding") {
    content = (
      <Centered>
        Opening + funding the tunnel on-chain… approve in your wallet.
      </Centered>
    );
  } else if (live && placingNext) {
    content = (
      <PlacementBoard
        ctaLabel="Start"
        onReady={(p) => {
          setPlacingNext(false);
          playNextGame(p);
        }}
      />
    );
  } else if (live && view) {
    content = (
      <BattleView
        view={view}
        statusLabel={settleLabel(status)}
        onFire={fire}
        onPlayAgain={() => setPlacingNext(true)}
        onSettle={settleNow}
        auto={auto}
        score={score}
        gameNumber={gamesPlayed + 1}
      />
    );
  } else {
    // Idle for the instant before the auto-start lands (e.g. wallet just connected).
    content = <Centered>Starting…</Centered>;
  }

  // Header (top): Auto toggle + Settle whenever a tunnel is live (one tunnel hosts
  // many games). Hidden while hand-placing the next game.
  const headerExtra =
    live && !placingNext ? (
      <div className="flex items-center gap-1.5">
        <AutoToggle on={auto} onChange={setAuto} />
        <SettleButton onSettle={settleNow} />
      </div>
    ) : undefined;
  return (
    <ModeFrame onBack={back} headerExtra={headerExtra}>
      {content}
    </ModeFrame>
  );
}

function PvpGame({
  windowId,
  onExit,
}: {
  windowId: string;
  onExit: () => void;
}) {
  const {
    status,
    view,
    error,
    opponentWallet,
    findMatch,
    fire,
    auto,
    setAuto,
    reset,
  } = useBattleshipPvp(windowId);
  const account = useCurrentAccount();

  // Notify once when the match settles on-chain (auto-settles at game end in PvP).
  useEffect(() => {
    if (status === "settled") {
      toast.success(
        view?.outcome === "win"
          ? "Victory — match settled ✓"
          : view?.outcome === "lose"
            ? "Defeat — match settled ✓"
            : "Match settled ✓",
      );
    }
    // outcome is stable once settled; status drives the one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Courtesy autopilot: if it's YOUR turn and you sit idle for 10s, switch autopilot
  // on so the opponent isn't left waiting. Firing passes the turn (myTurn → false),
  // which clears the timer; it re-arms each time it's your turn, and stops once auto.
  useEffect(() => {
    if (status !== "playing" || auto || !view?.myTurn) return;
    const t = setTimeout(() => {
      setAuto(true);
      toast("Autopilot on — you were idle");
    }, 10_000);
    return () => clearTimeout(t);
  }, [status, auto, view?.myTurn, setAuto]);

  const back = () => {
    reset();
    onExit();
  };
  let content: ReactNode;
  if (!account && !view) {
    // No wallet → require connect before matchmaking (the match is on-chain).
    content = (
      <ConnectWalletPane note="PvP matches open a shared tunnel and settle on-chain — gas is sponsored, so it's free to play." />
    );
  } else if (status === "error") {
    content = <ErrorPane error={error} onBack={back} />;
  } else if (status === "idle") {
    content = <PlacementBoard onReady={findMatch} ctaLabel="Find Match" />;
  } else if (status === "matching" || status === "funding" || !view) {
    content = (
      <Centered>
        <div>
          {status === "matching"
            ? "Finding an opponent…"
            : status === "funding"
              ? "Opening + funding the tunnel on-chain… approve in your wallet."
              : "Setting up…"}
        </div>
        {opponentWallet && (
          <div className="text-[11px]">vs {opponentWallet.slice(0, 10)}…</div>
        )}
      </Centered>
    );
  } else {
    content = (
      <BattleView
        view={view}
        statusLabel={settleLabel(status)}
        onFire={fire}
        // "Find next match": after the match settles, reset to placement (stay in PvP)
        // so the next Find Match is one tap away — not back out to the arena.
        onPlayAgain={reset}
        playAgainLabel="Find next match"
        playAgainDisabled={status === "settling"}
        auto={auto}
      />
    );
  }
  // Autopilot toggle appears once a match is live (a fired shot is possible).
  const headerExtra =
    view && status === "playing" ? (
      <AutoToggle on={auto} onChange={setAuto} />
    ) : undefined;
  return (
    <ModeFrame onBack={back} headerExtra={headerExtra}>
      {content}
    </ModeFrame>
  );
}
