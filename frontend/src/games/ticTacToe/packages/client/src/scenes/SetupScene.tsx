import { useState } from "react";
import { BotPanel } from "@/components/BotPanel";
import type { Difficulty } from "@/hooks/useBotGame";

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
          className={`px-4 py-2 border-2 border-primary rounded-sm font-body-lg text-lg transition-all ${
            value === o.id
              ? "bg-primary text-on-primary shadow-[2px_2px_0px_#001e40]"
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
    <div className="flex flex-col gap-2 ml-4 mt-4">
      <span className="font-label-sm text-xs uppercase tracking-wide text-outline">
        Board size (9–29)
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {BOARD_PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            className={`px-3 py-1 border-2 border-primary rounded-sm font-label-sm text-sm transition-all ${
              value === n
                ? "bg-primary text-on-primary shadow-[1px_1px_0px_#001e40]"
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
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Custom board size"
          className="w-20 px-2 py-1 border-2 border-primary rounded-sm bg-surface text-primary font-label-sm text-sm tabular-nums text-center"
        />
      </div>
    </div>
  );
}

const MODES: { id: PlayMode; label: string; desc: string }[] = [
  { id: "single", label: "Single game", desc: "Play one game, then stop." },
  { id: "auto", label: "Auto-play", desc: "Loop games until a bot is low on gas, or you stop." },
];

const DIFFICULTIES: { id: Difficulty; label: string; desc: string }[] = [
  { id: "perfect", label: "Both perfect", desc: "Both bots play minimax → almost always a draw." },
  { id: "even", label: "Even (varied)", desc: "Both competent + random → mixed wins/losses/draws." },
  { id: "uneven", label: "Uneven", desc: "Bot X plays perfectly, Bot O is weaker → X wins more." },
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
          <label key={o.id} className="relative cursor-pointer flex items-center justify-center p-4">
            <input
              type="radio"
              name="play_mode"
              checked={active}
              onChange={() => onChange(o.id)}
              className="custom-radio sr-only"
            />
            <div className="relative z-10 font-body-lg text-2xl hover:text-secondary transition-colors select-none text-primary">
              {o.label}
              <svg
                className={`red-circle absolute -inset-4 w-[calc(100%+32px)] h-[calc(100%+32px)] transition-all duration-300 pointer-events-none ${
                  active ? "opacity-100 scale-100 rotate-[-2deg]" : "opacity-0 scale-95"
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
        const rotation = idx === 0 ? "rotate-3" : idx === 1 ? "-rotate-6" : "rotate-12";
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
            <div className="w-6 h-6 border-2 border-primary rounded-sm flex items-center justify-center relative bg-white shadow-sm">
              <span
                className={`red-cross absolute text-secondary font-bold text-xl leading-none -mt-0.5 pointer-events-none transition-all duration-200 ${
                  active ? "opacity-100 scale-100" : "opacity-0 scale-75"
                } ${rotation}`}
              >
                X
              </span>
            </div>
            <div className="flex flex-col">
              <span className="font-body-lg text-xl text-primary leading-tight">{o.label}</span>
              <span className="text-xs text-outline">{o.desc}</span>
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
  const [activeTab, setActiveTab] = useState<"fund" | "mode" | "difficulty">("fund");

  return (
    <div className="w-full max-w-xl flex flex-col gap-4 pt-6 pb-3 relative min-h-[520px] justify-between">
      <div className="flex flex-col gap-4">
        {/* Page Header */}
        <header className="flex justify-between items-center border-b-2 border-primary/20 pb-2">
          <h1 className="font-headline-xl text-3xl text-primary underline decoration-secondary decoration-2 truncate tracking-tight">
            Tic-Tac-Toe Journal
          </h1>
          <button
            onClick={onBack}
            className="text-sm font-label-sm text-outline hover:text-secondary flex items-center gap-1 transition-colors"
          >
            <span className="material-symbols-outlined text-sm">arrow_back</span>
            back
          </button>
        </header>

        {/* Binder style Tab Dividers */}
        <div className="flex gap-1 border-b-2 border-primary/20 pb-0.5 mt-1">
          <button
            type="button"
            onClick={() => setActiveTab("fund")}
            className={`px-4 py-1.5 font-headline-lg text-base rounded-t-md border-t-2 border-x-2 transition-all relative outline-none whitespace-nowrap ${
              activeTab === "fund"
                ? "border-primary bg-surface text-primary -mb-[2px] z-10 shadow-[0_-2px_0px_theme('colors.surface')]"
                : "border-transparent text-outline hover:text-primary bg-transparent"
            }`}
          >
            {activeTab === "fund" && (
              <span className="absolute -inset-1 bg-tertiary-container/20 -z-10 rounded-t-md highlight-bg"></span>
            )}
            Bots
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("mode")}
            className={`px-4 py-1.5 font-headline-lg text-base rounded-t-md border-t-2 border-x-2 transition-all relative outline-none whitespace-nowrap ${
              activeTab === "mode"
                ? "border-primary bg-surface text-primary -mb-[2px] z-10 shadow-[0_-2px_0px_theme('colors.surface')]"
                : "border-transparent text-outline hover:text-primary bg-transparent"
            }`}
          >
            {activeTab === "mode" && (
              <span className="absolute -inset-1 bg-tertiary-container/20 -z-10 rounded-t-md highlight-bg"></span>
            )}
            Play Mode
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("difficulty")}
            className={`px-4 py-1.5 font-headline-lg text-base rounded-t-md border-t-2 border-x-2 transition-all relative outline-none whitespace-nowrap ${
              activeTab === "difficulty"
                ? "border-primary bg-surface text-primary -mb-[2px] z-10 shadow-[0_-2px_0px_theme('colors.surface')]"
                : "border-transparent text-outline hover:text-primary bg-transparent"
            }`}
          >
            {activeTab === "difficulty" && (
              <span className="absolute -inset-1 bg-tertiary-container/20 -z-10 rounded-t-md highlight-bg"></span>
            )}
            Difficulty
          </button>
        </div>

        {/* Tab Content Box - min height is fixed to 340px to prevent shrinking/expansion */}
        <div className="mt-2 min-h-[340px] flex flex-col justify-start">
          {activeTab === "fund" && (
            <div className="space-y-3">
              <h2 className="font-headline-lg-mobile text-base text-primary">Fund the AI Opponents</h2>
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
            <div className="space-y-3">
              <h2 className="font-headline-lg-mobile text-base text-primary">Select Game</h2>
              <div className="py-1">
                <GameTypeChoice value={gameType} onChange={setGameType} />
              </div>
              {gameType === "caro" && (
                <BoardSizeChoice value={boardSize} onChange={setBoardSize} />
              )}
              <h2 className="font-headline-lg-mobile text-base text-primary pt-2">Play Mode</h2>
              <p className="text-xs text-outline -mt-1.5">Choose how the bot matches are run.</p>
              <div className="py-2">
                <PlayModeChoice value={mode} onChange={setMode} />
              </div>
            </div>
          )}

          {activeTab === "difficulty" && (
            <div className="space-y-3">
              <h2 className="font-headline-lg-mobile text-base text-primary">Set Bot Difficulty</h2>
              <p className="text-xs text-outline -mt-1.5">Adjust the intelligence level of the bots.</p>
              <div className="py-1">
                <DifficultyChoice value={difficulty} onChange={setDifficulty} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Start Button & Warning at the bottom center (Fixed on all tabs) */}
      <div className="pt-3 border-t-2 border-dashed border-primary/20 flex flex-col items-center gap-2 mt-auto">
        {!funded && (
          <div className="text-center text-secondary font-body-lg text-xs italic animate-pulse">
            * Please fund both bots to start *
          </div>
        )}
        <button
          onClick={onStart}
          disabled={!funded}
          className="btn-scribble relative w-full max-w-xs px-12 py-2.5 bg-primary text-on-primary font-headline-lg text-lg hand-drawn-border overflow-hidden transition-all duration-200 hover:-translate-y-1 hover:shadow-[4px_4px_0px_#bc0000] active:translate-y-0 active:shadow-none disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none flex items-center gap-2 justify-center"
        >
          <span>Start playing</span>
          <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>play_arrow</span>
        </button>
      </div>
    </div>
  );
}

