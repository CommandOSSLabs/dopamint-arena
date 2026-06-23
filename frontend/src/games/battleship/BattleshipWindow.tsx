import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Bot,
  Check,
  Coins,
  Crosshair,
  Users,
  Wallet,
  Zap,
} from "lucide-react";
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

type Mode = "bot" | "pvp";

// Which mode a window is in, kept by windowId so a remount (minimize / maximize /
// desktop reflow) returns to the live game rather than the chooser. Cleared on close.
const modeStore = new Map<string, Mode | null>();

// Big pill actions, sized for touch (full-width on a narrow window, auto on wider).
// Colors follow the design system (DesignSystemPage): lilac brand-fill on ink for
// the primary, lilac outline for the secondary — vivid hexes since this surface is
// always dark, exactly as the design system's brand-fill buttons do it.
const BTN_PRIMARY =
  "inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#cab1ff] px-5 py-3 text-sm font-semibold text-[#0c0f1d] shadow-[0_0_18px_rgba(202,177,255,0.35)] transition-all hover:bg-[#b79bff] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40";
const BTN_SECONDARY =
  "inline-flex w-full items-center justify-center gap-2 rounded-full border border-[#cab1ff]/35 bg-[#cab1ff]/8 px-5 py-3 text-sm font-semibold text-[#cab1ff] transition-all hover:border-[#cab1ff]/70 hover:bg-[#cab1ff]/15 active:scale-[0.97]";

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
    <div className="relative h-full min-h-0 overflow-hidden text-arena-text [container-type:size] bg-[radial-gradient(ellipse_at_50%_38%,rgba(97,61,255,0.18)_0%,rgba(20,16,45,0.6)_46%,#07070f_100%)]">
      {/* Sonar sweep glow: a second, offset radial in lilac for depth. */}
      <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(120%_80%_at_85%_15%,rgba(202,177,255,0.12),transparent_55%)]" />
      {/* Scanline pattern for the radar effect (pure CSS, no asset). */}
      <div className="pointer-events-none absolute inset-0 z-0 opacity-[0.05] bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.35)_50%),linear-gradient(90deg,rgba(202,177,255,0.06),rgba(118,90,255,0.03),rgba(97,61,255,0.06))] bg-[size:100%_4px,6px_100%]" />
      {/* Top ambient glow line */}
      <div className="pointer-events-none absolute left-0 right-0 top-0 z-10 h-[1.5px] bg-gradient-to-r from-transparent via-[#cab1ff]/50 to-transparent" />

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
      <div className="flex flex-col items-center gap-2">
        <span className="wal-eyebrow">Naval tunnel duel</span>
        <h2 className="wal-display text-3xl text-white @[26rem]:text-4xl">
          Battle<span className="wal-gradient-text">ship</span>
        </h2>
        <p className="max-w-xs text-sm leading-relaxed text-arena-muted">
          Hide your fleet, then sink your foe's. Every shot is{" "}
          <span className="text-[#cab1ff]">commit-revealed</span> and co-signed
          in the tunnel — the winner settles on-chain.
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
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-arena-muted">
      {children}
    </div>
  );
}

/** Wallet gate: every battleship match opens + settles a real tunnel, so a wallet
 *  is required (gas is sponsored — free to play). One-click connect via Enoki. */
function ConnectWalletPane({ note }: { note: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-5 text-center">
      <div className="flex flex-col items-center gap-2">
        <span className="wal-eyebrow">Wallet required</span>
        <h3 className="wal-display text-2xl text-white">Connect to play</h3>
        <p className="max-w-xs text-sm leading-relaxed text-arena-muted">
          {note}
        </p>
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
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-all active:scale-95",
        on
          ? "border-[#cab1ff] bg-[#cab1ff]/15 text-[#e7ddff] shadow-[0_0_12px_rgba(202,177,255,0.3)]"
          : "border-[#cab1ff]/30 bg-[#cab1ff]/[0.06] text-[#cab1ff]/80 hover:border-[#cab1ff]/60",
      )}
    >
      <span
        className={cn(
          "grid size-4 place-items-center rounded-[5px] border transition-colors",
          on
            ? "border-[#cab1ff] bg-[#cab1ff] text-[#0c0f1d]"
            : "border-[#cab1ff]/50 bg-transparent",
        )}
      >
        {on && <Check className="size-3" strokeWidth={3} />}
      </span>
      <Zap className="size-3.5" />
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
      className="inline-flex items-center gap-1.5 rounded-full bg-[#cab1ff] px-3 py-1.5 text-xs font-semibold text-[#0c0f1d] shadow-[0_0_12px_rgba(202,177,255,0.3)] transition-all hover:bg-[#b79bff] active:scale-95"
    >
      <Coins className="size-3.5" /> Settle
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
      <div className="flex flex-col items-center gap-2">
        <span className="wal-eyebrow">
          {settling ? "Settling" : "Session settled"}
        </span>
        <h3 className="wal-display text-2xl text-white">
          {settling ? "Closing tunnel…" : "Settled ✓"}
        </h3>
        <p className="max-w-xs text-sm leading-relaxed text-arena-muted">
          You <span className="text-[#9cefcf]">{score.you}</span> –{" "}
          <span className="text-[#fb7185]">{score.foe}</span> Bot over {games}{" "}
          game{games === 1 ? "" : "s"} on one tunnel.
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

/** Every mode renders inside this frame: a top header bar carries the back button,
 *  a contextual title, and optional trailing controls (e.g. the Auto toggle), with
 *  the mode's own UI filling the space BELOW it — so nothing overlaps the board and
 *  there's always a way out. */
function ModeFrame({
  onBack,
  title,
  headerExtra,
  children,
}: {
  onBack: () => void;
  title?: ReactNode;
  headerExtra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-[#cab1ff]/15 bg-slate-950/40 px-2.5 py-2 backdrop-blur-sm">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-full border border-[#cab1ff]/40 bg-[#cab1ff]/[0.08] px-3 py-1.5 text-xs font-semibold text-[#cab1ff] transition-colors hover:border-[#cab1ff]/70 hover:bg-[#cab1ff]/15 active:scale-95"
        >
          <ArrowLeft className="size-3.5" /> Back
        </button>
        {title && (
          <span className="wal-mono truncate text-[11px] uppercase tracking-wider text-[#cab1ff]/70">
            {title}
          </span>
        )}
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
      <p className="text-[#fb7185]">{error ?? "something went wrong"}</p>
      <button
        onClick={onBack}
        className="rounded-full border border-arena-edge px-4 py-2 text-sm text-arena-text"
      >
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

  const back = () => {
    setPlacingNext(false);
    reset();
    onExit();
  };
  const newSession = () => {
    setPlacingNext(false);
    reset();
  };

  const live = status === "playing";
  // State bar (top): which game + the running score.
  const stateLabel = `vs Bot · Game ${gamesPlayed + 1} · ${score.you}–${score.foe}`;
  let title: ReactNode = "vs Bot";
  let content: ReactNode;
  if (!account && !view) {
    // No wallet → require connect before the on-chain match opens.
    content = (
      <ConnectWalletPane note="Bot matches open a real tunnel and settle on-chain — gas is sponsored, so it's free to play." />
    );
  } else if (status === "error") {
    content = <ErrorPane error={error} onBack={back} />;
  } else if (status === "settling" || status === "settled") {
    title = stateLabel;
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
    title = "vs Bot · place fleet";
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
    title = stateLabel;
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
    <ModeFrame onBack={back} title={title} headerExtra={headerExtra}>
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
    <ModeFrame onBack={back} title="PvP Match" headerExtra={headerExtra}>
      {content}
    </ModeFrame>
  );
}
