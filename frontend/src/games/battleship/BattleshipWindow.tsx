import { useEffect, useState, type ReactNode } from "react";
import { registerWindowDisposer } from "@/lib/windowSessions";
import type { GameWindowProps } from "../types";
import { PlacementBoard } from "./components/PlacementBoard";
import { BattleView } from "./components/BattleView";
import { AutoBattleView } from "./components/AutoBattleView";
import { useBattleship } from "./useBattleship";
import { useBattleshipPvp } from "./useBattleshipPvp";
import { useBattleshipAuto } from "./useBattleshipAuto";
import {
  BOT_CONFIGS,
  BOT_DIFFICULTIES,
  DEFAULT_BOT_DIFFICULTY,
  type BotDifficulty,
} from "./engine/bot";

type Mode = "bot" | "pvp" | "auto";

// Which mode a window is in, plus the chosen bot difficulty, kept by windowId so
// a remount (minimize / maximize / desktop reflow) returns to the live game with
// the same settings rather than the chooser. Both cleared on close.
const modeStore = new Map<string, Mode | null>();
const difficultyStore = new Map<string, BotDifficulty>();

/**
 * Battleship over a REAL Sui tunnel. Place a fleet, then fight a bot (one wallet
 * opens + funds a self-play tunnel, or a no-wallet off-chain demo) or match a real
 * opponent (PvP over the relay). Every shot is commit-revealed and co-signed; the
 * result settles on-chain. The session lives in a windowId-keyed store, so
 * minimizing or resizing the window never drops the game. ADR 0003.
 */
export function BattleshipWindow({ windowId }: GameWindowProps) {
  const [mode, setModeState] = useState<Mode | null>(
    () => modeStore.get(windowId) ?? null,
  );
  const [difficulty, setDifficultyState] = useState<BotDifficulty>(
    () => difficultyStore.get(windowId) ?? DEFAULT_BOT_DIFFICULTY,
  );
  useEffect(() => {
    registerWindowDisposer(windowId, "battleship-mode", () => {
      modeStore.delete(windowId);
      difficultyStore.delete(windowId);
    });
  }, [windowId]);
  const setMode = (m: Mode | null) => {
    if (m === null) modeStore.delete(windowId);
    else modeStore.set(windowId, m);
    setModeState(m);
  };
  const setDifficulty = (d: BotDifficulty) => {
    difficultyStore.set(windowId, d);
    setDifficultyState(d);
  };

  // One size-container for the whole game so every pane sizes off the WINDOW's
  // width AND height (container queries + cqh units), not the viewport — correct
  // in a small floating window on a big screen, or full-width on mobile.
  return (
    <div
      className="h-full min-h-0 [container-type:size] bg-cover bg-center bg-no-repeat relative overflow-hidden text-arena-text"
      style={{ backgroundImage: "url('/games/battleship-bg.png')" }}
    >
      {/* Dark overlay & blur to ensure readability */}
      <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-[2px] pointer-events-none z-0" />
      {/* Scanline pattern for radar effect */}
      <div className="absolute inset-0 pointer-events-none z-0 opacity-[0.04] bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[size:100%_4px,6px_100%]" />
      {/* Top ambient glow line */}
      <div className="absolute top-0 left-0 right-0 h-[1.5px] bg-gradient-to-r from-transparent via-cyan-500/50 to-transparent pointer-events-none z-10" />

      {/* Actual game layout sits on top */}
      <div className="relative z-20 h-full w-full">
        {mode === "bot" ? (
          <BotGame
            windowId={windowId}
            difficulty={difficulty}
            onExit={() => setMode(null)}
          />
        ) : mode === "pvp" ? (
          <PvpGame windowId={windowId} onExit={() => setMode(null)} />
        ) : mode === "auto" ? (
          <AutoGame windowId={windowId} onExit={() => setMode(null)} />
        ) : (
          <ModeChooser
            onPick={setMode}
            difficulty={difficulty}
            onDifficulty={setDifficulty}
          />
        )}
      </div>
    </div>
  );
}

function ModeChooser({
  onPick,
  difficulty,
  onDifficulty,
}: {
  onPick: (m: Mode) => void;
  difficulty: BotDifficulty;
  onDifficulty: (d: BotDifficulty) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      <p className="text-sm text-arena-muted">
        Hide a fleet, then sink your foe's. Each shot is{" "}
        <span className="text-arena-accent">commit-revealed</span> and co-signed
        in the tunnel; winner takes 100 on-chain.
      </p>
      <DifficultyPicker difficulty={difficulty} onDifficulty={onDifficulty} />
      <div className="flex flex-wrap justify-center gap-2">
        <button
          onClick={() => onPick("bot")}
          className="rounded-full bg-cyan-400 px-4 py-2 text-sm font-semibold text-black shadow-[0_0_12px_rgba(34,211,238,0.3)] transition-colors hover:bg-cyan-300"
        >
          Play vs Bot
        </button>
        <button
          onClick={() => onPick("pvp")}
          className="rounded-full border border-cyan-500/40 bg-cyan-950/40 px-4 py-2 text-sm font-semibold text-cyan-300 transition-colors hover:border-cyan-400 hover:bg-cyan-500/10"
        >
          Find Match (PvP)
        </button>
        <button
          onClick={() => onPick("auto")}
          className="rounded-full border border-cyan-500/40 bg-cyan-950/40 px-4 py-2 text-sm font-semibold text-cyan-300 transition-colors hover:border-cyan-400 hover:bg-cyan-500/10"
        >
          Watch Bots (Auto)
        </button>
      </div>
    </div>
  );
}

/** Segmented Easy / Normal / Hard control for a bot's skill. */
function DifficultyPicker({
  difficulty,
  onDifficulty,
  label = "Bot difficulty",
}: {
  difficulty: BotDifficulty;
  onDifficulty: (d: BotDifficulty) => void;
  label?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[11px] uppercase tracking-wide text-arena-muted">
        {label}
      </span>
      <div className="inline-flex rounded-full border border-cyan-500/30 bg-cyan-950/40 p-0.5">
        {BOT_DIFFICULTIES.map((d) => {
          const active = d === difficulty;
          return (
            <button
              key={d}
              onClick={() => onDifficulty(d)}
              aria-pressed={active}
              className={
                "rounded-full px-3 py-1 text-xs font-semibold transition-colors " +
                (active
                  ? "bg-cyan-400 text-black"
                  : "text-cyan-300 hover:bg-cyan-500/10")
              }
            >
              {BOT_CONFIGS[d].label}
            </button>
          );
        })}
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

function ErrorPane({
  error,
  onBack,
}: {
  error: string | null;
  onBack: () => void;
}) {
  return (
    <Centered>
      <p className="text-red-400">{error ?? "something went wrong"}</p>
      <button
        onClick={onBack}
        className="rounded border border-arena-edge px-3 py-1.5 text-sm text-arena-text"
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
  difficulty,
  onExit,
}: {
  windowId: string;
  difficulty: BotDifficulty;
  onExit: () => void;
}) {
  const { status, view, error, startBattle, fire, setDifficulty, reset } =
    useBattleship(windowId);

  // Keep the live session's foe skill in sync with the chooser selection.
  useEffect(() => {
    setDifficulty(difficulty);
  }, [difficulty, setDifficulty]);

  if (status === "error") {
    return (
      <ErrorPane
        error={error}
        onBack={() => {
          reset();
          onExit();
        }}
      />
    );
  }
  if (status === "funding") {
    return (
      <Centered>
        Opening + funding the tunnel on-chain… approve in your wallet.
      </Centered>
    );
  }
  if (!view || status === "idle" || status === "placing") {
    return <PlacementBoard onReady={startBattle} />;
  }
  return (
    <BattleView
      view={view}
      statusLabel={settleLabel(status)}
      onFire={fire}
      onPlayAgain={reset}
    />
  );
}

function PvpGame({
  windowId,
  onExit,
}: {
  windowId: string;
  onExit: () => void;
}) {
  const { status, view, error, opponentWallet, findMatch, fire, reset } =
    useBattleshipPvp(windowId);

  if (status === "error") {
    return (
      <ErrorPane
        error={error}
        onBack={() => {
          reset();
          onExit();
        }}
      />
    );
  }
  if (status === "idle") {
    return <PlacementBoard onReady={findMatch} ctaLabel="Find Match" />;
  }
  if (status === "matching" || status === "funding" || !view) {
    return (
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
  }
  return (
    <BattleView
      view={view}
      statusLabel={settleLabel(status)}
      onFire={fire}
      onPlayAgain={() => {
        reset();
        onExit();
      }}
    />
  );
}

function AutoGame({
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
    balances,
    funded,
    canFundFromWallet,
    fund,
    fundFromWallet,
    startAuto,
    stopAuto,
    reset,
  } = useBattleshipAuto(windowId);

  if (status === "error") {
    return (
      <ErrorPane
        error={error}
        onBack={() => {
          reset();
          onExit();
        }}
      />
    );
  }
  if (status === "idle" || status === "funding") {
    return (
      <AutoSetup
        balances={balances}
        funded={funded}
        funding={status === "funding"}
        canFundFromWallet={canFundFromWallet}
        onFund={fund}
        onFundFromWallet={fundFromWallet}
        onStart={startAuto}
        onBack={onExit}
      />
    );
  }
  if (!view) {
    return <Centered>Opening the first match on-chain…</Centered>;
  }
  return <AutoBattleView view={view} onStop={stopAuto} onReset={reset} />;
}

/** MIST → a short SUI string. */
const formatSui = (mist: bigint) => `${(Number(mist) / 1e9).toFixed(3)} SUI`;

/** Pre-run screen for the auto mode: fund the bots, pick each skill, then watch them loop. */
function AutoSetup({
  balances,
  funded,
  funding,
  canFundFromWallet,
  onFund,
  onFundFromWallet,
  onStart,
  onBack,
}: {
  balances: { a: bigint; b: bigint };
  funded: boolean;
  funding: boolean;
  canFundFromWallet: boolean;
  onFund: () => void;
  onFundFromWallet: () => void;
  onStart: (a: BotDifficulty, b: BotDifficulty) => void;
  onBack: () => void;
}) {
  const [a, setA] = useState<BotDifficulty>("normal");
  const [b, setB] = useState<BotDifficulty>("hard");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      <p className="text-sm text-arena-muted">
        Two on-chain bots auto-play match after match — each opens + settles a
        real tunnel and self-signs, so no wallet is needed. Fund them once
        (testnet faucet); the run loops until a bot is low on gas, or you stop.
      </p>
      <div className="flex items-center justify-center gap-4 text-xs text-arena-muted">
        <span>
          Bot A <span className="text-arena-text">{formatSui(balances.a)}</span>
        </span>
        <span>
          Bot B <span className="text-arena-text">{formatSui(balances.b)}</span>
        </span>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {canFundFromWallet && (
          <button
            onClick={onFundFromWallet}
            disabled={funding}
            className="rounded-full bg-cyan-400 px-4 py-1.5 text-sm font-semibold text-black shadow-[0_0_12px_rgba(34,211,238,0.3)] transition-colors hover:bg-cyan-300 disabled:opacity-50"
          >
            {funding ? "Funding…" : "Fund from wallet · 0.1 SUI/bot"}
          </button>
        )}
        <button
          onClick={onFund}
          disabled={funding}
          className="rounded-full border border-cyan-500/40 bg-cyan-950/40 px-4 py-1.5 text-sm font-semibold text-cyan-300 transition-colors hover:border-cyan-400 hover:bg-cyan-500/10 disabled:opacity-50"
        >
          {funding ? "Funding…" : "Faucet"}
        </button>
      </div>
      <div className="flex flex-wrap items-end justify-center gap-4">
        <DifficultyPicker label="Bot A" difficulty={a} onDifficulty={setA} />
        <span className="pb-1.5 text-xs text-arena-muted">vs</span>
        <DifficultyPicker label="Bot B" difficulty={b} onDifficulty={setB} />
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          onClick={() => onStart(a, b)}
          disabled={!funded}
          className="rounded-full bg-cyan-400 px-4 py-2 text-sm font-semibold text-black shadow-[0_0_12px_rgba(34,211,238,0.3)] transition-colors hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Start Auto-play
        </button>
        <button
          onClick={onBack}
          className="rounded-full border border-cyan-500/40 bg-cyan-950/40 px-4 py-2 text-sm font-semibold text-cyan-300 transition-colors hover:border-cyan-400 hover:bg-cyan-500/10"
        >
          Back
        </button>
      </div>
      {!funded && (
        <p className="text-[11px] text-arena-muted">Fund both bots to start.</p>
      )}
    </div>
  );
}
