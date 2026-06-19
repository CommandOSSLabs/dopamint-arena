import { useState } from "react";
import { BotPanel } from "@/games/ticTacToe/app/components/BotPanel";
import type { Difficulty } from "@/games/ticTacToe/app/hooks/useBotGame";

export type PlayMode = "single" | "auto";

export type GameType = "ttt" | "caro";

const BOARD_PRESETS = [15, 19, 25] as const;

function GameTypeChoice({
  value,
  onChange,
}: {
  value: GameType;
  onChange: (v: GameType) => void;
}) {
  const opts: { id: GameType; label: string }[] = [
    { id: "ttt", label: "Tic-Tac-Toe (3×3)" },
    { id: "caro", label: "Caro (5-in-a-row)" },
  ];
  return (
    <div className="flex flex-wrap gap-3 ml-4">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`px-10 py-6 border-[6px] border-primary rounded-xl font-body-lg text-4xl transition-all ${
            value === o.id
              ? "bg-primary text-on-primary shadow-[6px_6px_0px_#001e40]"
              : "bg-surface text-primary hover:bg-primary/5"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function BoardSizeChoice({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex flex-col gap-4 ml-4 mt-8">
      <span className="font-label-sm text-2xl uppercase tracking-wide text-outline">
        Board size (9–29)
      </span>
      <div className="flex flex-wrap items-center gap-6">
        {BOARD_PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            className={`px-8 py-4 border-[6px] border-primary rounded-xl font-label-sm text-3xl transition-all ${
              value === n
                ? "bg-primary text-on-primary shadow-[4px_4px_0px_#001e40]"
                : "bg-surface text-primary hover:bg-primary/5"
            }`}
          >
            {n}×{n}
          </button>
        ))}
        <input
          type="number"
          min={9}
          max={29}
          value={value}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (Number.isFinite(n)) onChange(n);
          }}
          aria-label="Custom board size"
          className="w-40 px-6 py-4 border-[6px] border-primary rounded-xl bg-surface text-primary font-label-sm text-3xl tabular-nums text-center"
        />
      </div>
    </div>
  );
}

const MODES: { id: PlayMode; label: string; desc: string }[] = [
  { id: "single", label: "Single game", desc: "Play one game, then stop." },
  {
    id: "auto",
    label: "Auto-play",
    desc: "Loop games until a bot is low on gas, or you stop.",
  },
];

const DIFFICULTIES: { id: Difficulty; label: string; desc: string }[] = [
  {
    id: "perfect",
    label: "Both perfect",
    desc: "Both bots play minimax → almost always a draw.",
  },
  {
    id: "even",
    label: "Even (varied)",
    desc: "Both competent + random → mixed wins/losses/draws.",
  },
  {
    id: "uneven",
    label: "Uneven",
    desc: "Bot X plays perfectly, Bot O is weaker → X wins more.",
  },
  {
    id: "fast",
    label: "Super Fast",
    desc: "Bots play instantly on random empty cells to maximize actions/sec.",
  },
];

function PlayModeChoice({
  value,
  onChange,
}: {
  value: PlayMode;
  onChange: (v: PlayMode) => void;
}) {
  return (
    <div className="flex flex-wrap gap-8 ml-4">
      {MODES.map((o) => {
        const active = o.id === value;
        return (
          <label
            key={o.id}
            className="relative cursor-pointer flex items-center justify-center p-4"
          >
            <input
              type="radio"
              name="play_mode"
              checked={active}
              onChange={() => onChange(o.id)}
              className="custom-radio sr-only"
            />
            <div className="relative z-10 font-body-lg text-5xl hover:text-secondary transition-colors select-none text-primary">
              {o.label}
              <svg
                className={`red-circle absolute -inset-4 w-[calc(100%+32px)] h-[calc(100%+32px)] transition-all duration-300 pointer-events-none ${
                  active
                    ? "opacity-100 scale-100 rotate-[-2deg]"
                    : "opacity-0 scale-95"
                }`}
                preserveAspectRatio="none"
                viewBox="0 0 100 40"
              >
                <path
                  className="text-secondary drop-shadow-sm"
                  d="M5,20 C10,5 90,5 95,20 C100,35 20,40 10,25"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  style={{ strokeLinecap: "round", strokeLinejoin: "round" }}
                />
              </svg>
            </div>
          </label>
        );
      })}
    </div>
  );
}

function DifficultyChoice({
  value,
  onChange,
}: {
  value: Difficulty;
  onChange: (v: Difficulty) => void;
}) {
  return (
    <div className="flex flex-col gap-4 ml-4">
      {DIFFICULTIES.map((o, idx) => {
        const active = o.id === value;
        const rotation =
          idx === 0 ? "rotate-3" : idx === 1 ? "-rotate-6" : "rotate-12";
        return (
          <label
            key={o.id}
            className="relative flex items-center gap-4 cursor-pointer hover:bg-tertiary/10 p-2 -ml-2 rounded-sm w-max transition-colors"
          >
            <input
              type="radio"
              name="difficulty"
              checked={active}
              onChange={() => onChange(o.id)}
              className="custom-checkbox sr-only"
            />
            <div className="w-14 h-14 border-[6px] border-primary rounded-xl flex items-center justify-center relative bg-white shadow-sm">
              <span
                className={`red-cross absolute text-secondary font-bold text-5xl leading-none -mt-1.5 pointer-events-none transition-all duration-200 ${
                  active ? "opacity-100 scale-100" : "opacity-0 scale-75"
                } ${rotation}`}
              >
                X
              </span>
            </div>
            <div className="flex flex-col ml-2">
              <span className="font-body-lg text-4xl text-primary leading-tight">
                {o.label}
              </span>
              <span className="text-2xl text-outline mt-1">{o.desc}</span>
            </div>
          </label>
        );
      })}
    </div>
  );
}

export function SetupScene({
  balances,
  onFund,
  funding,
  onRefresh,
  onRebalance,
  rebalancing,
  funded,
  mode,
  setMode,
  difficulty,
  setDifficulty,
  gameType,
  setGameType,
  boardSize,
  setBoardSize,
  onStart,
  onBack,
}: {
  balances: { x: bigint; o: bigint };
  onFund: () => void;
  funding: boolean;
  onRefresh: () => Promise<unknown>;
  onRebalance: () => void;
  rebalancing: boolean;
  funded: boolean;
  mode: PlayMode;
  setMode: (m: PlayMode) => void;
  difficulty: Difficulty;
  setDifficulty: (d: Difficulty) => void;
  gameType: GameType;
  setGameType: (g: GameType) => void;
  boardSize: number;
  setBoardSize: (n: number) => void;
  onStart: () => void;
  onBack: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"fund" | "mode" | "difficulty">(
    "fund",
  );

  return (
    <div className="w-[95%] max-w-5xl h-full flex flex-col gap-6 pt-0 pb-0 relative">
      {/* Page Header */}
      <header className="flex justify-between items-start border-b-4 border-primary/20 pb-4 shrink-0">
        <div className="flex flex-col items-start gap-2 mt-2">
          <h1 className="font-headline-xl text-4xl md:text-5xl text-primary underline decoration-secondary decoration-[3px] truncate tracking-tight">
            Tic-Tac-Toe Journal
          </h1>
          <button
            onClick={onBack}
            className="text-2xl font-label-sm text-outline hover:text-secondary flex items-center gap-2 transition-colors mt-2"
          >
            <span className="material-symbols-outlined text-3xl">
              arrow_back
            </span>
            back
          </button>
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          {!funded && (
            <div className="text-right text-secondary font-headline-lg text-lg italic animate-pulse bg-secondary/10 px-4 py-2 rounded-lg border-2 border-secondary/30 shadow-sm w-max">
              * Please fund both bots to start *
            </div>
          )}
          <button
            onClick={onStart}
            disabled={!funded}
            className="btn-scribble relative px-10 py-4 bg-primary text-on-primary font-headline-xl text-3xl hand-drawn-border overflow-hidden transition-all duration-200 hover:-translate-y-2 hover:shadow-[6px_6px_0px_#bc0000] active:translate-y-0 active:shadow-none disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none flex items-center gap-4 justify-center"
          >
            <span>Start playing</span>
            <span
              className="material-symbols-outlined text-4xl mt-1"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              play_arrow
            </span>
          </button>
        </div>
      </header>

      {/* Main Setting Area */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Binder style Tab Dividers */}
        <div className="flex gap-2 border-b-[6px] border-primary/20 pb-1 shrink-0 mt-2">
          <button
            type="button"
            onClick={() => setActiveTab("fund")}
            className={`px-12 py-5 font-headline-lg text-3xl md:text-4xl rounded-t-2xl border-t-[6px] border-x-[6px] transition-all relative outline-none whitespace-nowrap ${
              activeTab === "fund"
                ? "border-primary bg-surface text-primary -mb-[6px] z-10 shadow-[0_-6px_0px_theme('colors.surface')]"
                : "border-primary/20 bg-surface text-outline hover:text-primary hover:border-primary/40 -mb-[6px]"
            }`}
          >
            {activeTab === "fund" && (
              <span className="absolute -inset-1.5 bg-tertiary-container/20 -z-10 rounded-t-xl highlight-bg"></span>
            )}
            Bots
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("mode")}
            className={`px-12 py-5 font-headline-lg text-3xl md:text-4xl rounded-t-2xl border-t-[6px] border-x-[6px] transition-all relative outline-none whitespace-nowrap ${
              activeTab === "mode"
                ? "border-primary bg-surface text-primary -mb-[6px] z-10 shadow-[0_-6px_0px_theme('colors.surface')]"
                : "border-primary/20 bg-surface text-outline hover:text-primary hover:border-primary/40 -mb-[6px]"
            }`}
          >
            {activeTab === "mode" && (
              <span className="absolute -inset-1.5 bg-tertiary-container/20 -z-10 rounded-t-xl highlight-bg"></span>
            )}
            Play Mode
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("difficulty")}
            className={`px-12 py-5 font-headline-lg text-3xl md:text-4xl rounded-t-2xl border-t-[6px] border-x-[6px] transition-all relative outline-none whitespace-nowrap ${
              activeTab === "difficulty"
                ? "border-primary bg-surface text-primary -mb-[6px] z-10 shadow-[0_-6px_0px_theme('colors.surface')]"
                : "border-primary/20 bg-surface text-outline hover:text-primary hover:border-primary/40 -mb-[6px]"
            }`}
          >
            {activeTab === "difficulty" && (
              <span className="absolute -inset-1.5 bg-tertiary-container/20 -z-10 rounded-t-xl highlight-bg"></span>
            )}
            Difficulty
          </button>
        </div>

        {/* Tab Content Box - Stretches to bottom */}
        <div className="flex-1 mt-2 flex flex-col justify-start pb-4">
          {activeTab === "fund" && (
            <div className="space-y-4">
              <h2 className="font-headline-lg-mobile text-2xl text-primary mb-2">
                Fund the AI Opponents
              </h2>
              <BotPanel
                bots={balances}
                onFund={onFund}
                funding={funding}
                onRefresh={onRefresh}
                onRebalance={onRebalance}
                rebalancing={rebalancing}
                locked={false}
              />
            </div>
          )}

          {activeTab === "mode" && (
            <div className="space-y-10 flex-1 flex flex-col justify-start">
              <div>
                <h2 className="font-headline-lg-mobile text-4xl text-primary">
                  Select Game
                </h2>
                <div className="py-4">
                  <GameTypeChoice value={gameType} onChange={setGameType} />
                </div>
                {gameType === "caro" && (
                  <BoardSizeChoice value={boardSize} onChange={setBoardSize} />
                )}
              </div>
              <div className="mt-8">
                <h2 className="font-headline-lg-mobile text-4xl text-primary pt-2">
                  Play Mode
                </h2>
                <p className="text-2xl text-outline mt-1 mb-6">
                  Choose how the bot matches are run.
                </p>
                <div className="py-2">
                  <PlayModeChoice value={mode} onChange={setMode} />
                </div>
              </div>
            </div>
          )}

          {activeTab === "difficulty" && (
            <div className="space-y-8 flex-1 flex flex-col justify-start">
              <h2 className="font-headline-lg-mobile text-4xl text-primary">
                Set Bot Difficulty
              </h2>
              <p className="text-2xl text-outline mt-1 mb-6">
                Adjust the intelligence level of the bots.
              </p>
              <div className="py-4">
                <DifficultyChoice value={difficulty} onChange={setDifficulty} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
