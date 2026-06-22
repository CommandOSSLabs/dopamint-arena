import { useState } from "react";
import { BotPanel } from "@/games/ticTacToe/app/components/BotPanel";
import type { Difficulty } from "@/games/ticTacToe/app/hooks/useBotGame";

export type PlayMode = "single" | "auto";

export type GameType = "ttt" | "caro";

const BOARD_PRESETS = [15, 19, 25] as const;

function GameTypeChoice({
  value,
  onChange,
  isPortrait = false,
}: {
  value: GameType;
  onChange: (v: GameType) => void;
  isPortrait?: boolean;
}) {
  const opts: { id: GameType; label: string }[] = [
    { id: "ttt", label: "Tic-Tac-Toe (3×3)" },
    { id: "caro", label: "Caro (5-in-a-row)" },
  ];
  return (
    <div
      className={`flex flex-wrap ${isPortrait ? "gap-2 ml-2" : "gap-3 ml-4"}`}
    >
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`border-primary rounded-xl font-body-lg transition-all ${
            isPortrait
              ? "px-4 py-3 border-4 text-lg rounded-lg"
              : "px-10 py-6 border-[6px] text-4xl rounded-xl"
          } ${
            value === o.id
              ? "bg-primary text-on-primary shadow-[4px_4px_0px_#001e40]"
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
  isPortrait = false,
}: {
  value: number;
  onChange: (n: number) => void;
  isPortrait?: boolean;
}) {
  return (
    <div
      className={`flex flex-col ml-4 ${isPortrait ? "gap-2 mt-4" : "gap-4 mt-8"}`}
    >
      <span
        className={`font-label-sm uppercase tracking-wide text-outline ${isPortrait ? "text-sm" : "text-2xl"}`}
      >
        Board size (9–29)
      </span>
      <div
        className={`flex flex-wrap items-center ${isPortrait ? "gap-3" : "gap-6"}`}
      >
        {BOARD_PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            className={`border-primary rounded-xl font-label-sm transition-all ${
              isPortrait
                ? "px-4 py-2 border-4 text-sm rounded-lg shadow-[2px_2px_0px_#001e40]"
                : "px-8 py-4 border-[6px] text-3xl rounded-xl shadow-[4px_4px_0px_#001e40]"
            } ${
              value === n
                ? "bg-primary text-on-primary"
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
          className={`border-primary rounded-xl bg-surface text-primary font-label-sm tabular-nums text-center ${
            isPortrait
              ? "w-20 px-2 py-2 border-4 text-sm rounded-lg"
              : "w-40 px-6 py-4 border-[6px] text-3xl rounded-xl"
          }`}
        />
      </div>
    </div>
  );
}

const GAME_PRESETS = [1, 5, 10, 25] as const;

function GamesPerTunnelChoice({
  value,
  onChange,
  isPortrait = false,
}: {
  value: number;
  onChange: (n: number) => void;
  isPortrait?: boolean;
}) {
  return (
    <div
      className={`flex flex-wrap items-center ml-4 ${isPortrait ? "gap-3" : "gap-6"}`}
    >
      {GAME_PRESETS.map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          className={`border-primary rounded-xl font-label-sm transition-all ${
            isPortrait
              ? "px-4 py-2 border-4 text-sm rounded-lg shadow-[2px_2px_0px_#001e40]"
              : "px-8 py-4 border-[6px] text-3xl rounded-xl shadow-[4px_4px_0px_#001e40]"
          } ${
            value === n
              ? "bg-primary text-on-primary"
              : "bg-surface text-primary hover:bg-primary/5"
          }`}
        >
          {n}
        </button>
      ))}
      <input
        type="number"
        min={1}
        max={100}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (Number.isFinite(n)) onChange(n);
        }}
        aria-label="Custom games per tunnel"
        className={`border-primary rounded-xl bg-surface text-primary font-label-sm tabular-nums text-center ${
          isPortrait
            ? "w-16 px-2 py-2 border-4 text-sm rounded-lg"
            : "w-32 px-6 py-4 border-[6px] text-3xl rounded-xl"
        }`}
      />
    </div>
  );
}

const DIFFICULTIES: { id: Difficulty; label: string; desc: string }[] = [
  {
    id: "fast",
    label: "Super Easy",
    desc: "Bots play instantly on random empty cells (super easy mode).",
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
    id: "perfect",
    label: "Both perfect",
    desc: "Both bots play minimax → almost always a draw.",
  },
];

function DifficultyChoice({
  value,
  onChange,
  isPortrait = false,
}: {
  value: Difficulty;
  onChange: (v: Difficulty) => void;
  isPortrait?: boolean;
}) {
  return (
    <div className={`flex flex-col ml-4 ${isPortrait ? "gap-2" : "gap-4"}`}>
      {DIFFICULTIES.map((o, idx) => {
        const active = o.id === value;
        const rotation =
          idx === 0
            ? "rotate-3"
            : idx === 1
              ? "-rotate-6"
              : idx === 2
                ? "rotate-12"
                : "-rotate-3";
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
            <div
              className={`border-primary rounded-xl flex items-center justify-center relative bg-white shadow-sm ${
                isPortrait
                  ? "w-8 h-8 border-4 rounded-lg"
                  : "w-14 h-14 border-[6px] rounded-xl"
              }`}
            >
              <span
                className={`red-cross absolute text-secondary font-bold leading-none pointer-events-none transition-all duration-200 ${
                  active ? "opacity-100 scale-100" : "opacity-0 scale-75"
                } ${rotation} ${isPortrait ? "text-2xl -mt-1" : "text-5xl -mt-1.5"}`}
              >
                X
              </span>
            </div>
            <div className="flex flex-col ml-2">
              <span
                className={`font-body-lg text-primary leading-tight ${isPortrait ? "text-lg" : "text-4xl"}`}
              >
                {o.label}
              </span>
              <span
                className={`text-outline mt-1 ${isPortrait ? "text-xs" : "text-2xl"}`}
              >
                {o.desc}
              </span>
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
  maxGames,
  setMaxGames,
  difficulty,
  setDifficulty,
  gameType,
  setGameType,
  boardSize,
  setBoardSize,
  onStart,
  onBack,
  isPortrait = false,
}: {
  balances: { x: bigint; o: bigint };
  onFund: () => void;
  funding: boolean;
  onRefresh: () => Promise<unknown>;
  onRebalance: () => void;
  rebalancing: boolean;
  funded: boolean;
  maxGames: number;
  setMaxGames: (n: number) => void;
  difficulty: Difficulty;
  setDifficulty: (d: Difficulty) => void;
  gameType: GameType;
  setGameType: (g: GameType) => void;
  boardSize: number;
  setBoardSize: (n: number) => void;
  onStart: () => void;
  onBack: () => void;
  isPortrait?: boolean;
}) {
  const [activeTab, setActiveTab] = useState<"fund" | "mode" | "difficulty">(
    "fund",
  );

  return (
    <div
      className={`h-full flex flex-col relative ${isPortrait ? "w-full gap-3 p-2" : "w-[95%] max-w-5xl gap-6 pt-0 pb-0"}`}
    >
      {/* Page Header */}
      <header
        className={`flex justify-between items-start border-primary/20 pb-4 shrink-0 ${isPortrait ? "border-b-2" : "border-b-4"}`}
      >
        <div className="flex flex-col items-start gap-1 mt-1">
          <h1
            className={`font-headline-xl text-primary underline decoration-secondary decoration-[3px] truncate tracking-tight ${
              isPortrait ? "text-2xl" : "text-4xl md:text-5xl"
            }`}
          >
            Tic-Tac-Toe Journal
          </h1>
          <button
            onClick={onBack}
            className={`font-label-sm text-outline hover:text-secondary flex items-center gap-1.5 transition-colors mt-1 ${
              isPortrait ? "text-sm" : "text-2xl"
            }`}
          >
            <span
              className={`material-symbols-outlined ${isPortrait ? "text-xl" : "text-3xl"}`}
            >
              arrow_back
            </span>
            back
          </button>
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          {!funded && (
            <div
              className={`text-right text-secondary font-headline-lg italic animate-pulse bg-secondary/10 rounded-lg border-secondary/30 shadow-sm w-max ${
                isPortrait
                  ? "text-xs px-2 py-1 border"
                  : "text-lg px-4 py-2 border-2"
              }`}
            >
              * Please fund both bots *
            </div>
          )}
          <button
            onClick={onStart}
            disabled={!funded}
            data-testid="ttt-start"
            className={`btn-scribble relative bg-primary text-on-primary font-headline-xl hand-drawn-border overflow-hidden transition-all duration-200 hover:-translate-y-2 hover:shadow-[6px_6px_0px_#bc0000] active:translate-y-0 active:shadow-none disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none flex items-center justify-center ${
              isPortrait
                ? "px-4 py-2 text-base gap-2 rounded-lg"
                : "px-10 py-4 text-3xl gap-4"
            }`}
          >
            <span>Start playing</span>
            <span
              className={`material-symbols-outlined mt-1 ${isPortrait ? "text-xl" : "text-4xl"}`}
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
        <div
          className={`flex gap-1.5 border-primary/20 pb-0.5 shrink-0 mt-2 ${isPortrait ? "border-b-[3px]" : "border-b-[6px]"}`}
        >
          <button
            type="button"
            onClick={() => setActiveTab("fund")}
            data-testid="ttt-tab-bots"
            className={`font-headline-lg transition-all relative outline-none whitespace-nowrap ${
              isPortrait
                ? "px-4 py-2 text-sm rounded-t-lg border-t-[3px] border-x-[3px] -mb-[3px]"
                : "px-12 py-5 text-3xl md:text-4xl rounded-t-2xl border-t-[6px] border-x-[6px] -mb-[6px]"
            } ${
              activeTab === "fund"
                ? "border-primary bg-surface text-primary z-10 shadow-[0_-6px_0px_theme('colors.surface')]"
                : "border-primary/20 bg-surface text-outline hover:text-primary hover:border-primary/40"
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
            className={`font-headline-lg transition-all relative outline-none whitespace-nowrap ${
              isPortrait
                ? "px-4 py-2 text-sm rounded-t-lg border-t-[3px] border-x-[3px] -mb-[3px]"
                : "px-12 py-5 text-3xl md:text-4xl rounded-t-2xl border-t-[6px] border-x-[6px] -mb-[6px]"
            } ${
              activeTab === "mode"
                ? "border-primary bg-surface text-primary z-10 shadow-[0_-6px_0px_theme('colors.surface')]"
                : "border-primary/20 bg-surface text-outline hover:text-primary hover:border-primary/40"
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
            className={`font-headline-lg transition-all relative outline-none whitespace-nowrap ${
              isPortrait
                ? "px-4 py-2 text-sm rounded-t-lg border-t-[3px] border-x-[3px] -mb-[3px]"
                : "px-12 py-5 text-3xl md:text-4xl rounded-t-2xl border-t-[6px] border-x-[6px] -mb-[6px]"
            } ${
              activeTab === "difficulty"
                ? "border-primary bg-surface text-primary z-10 shadow-[0_-6px_0px_theme('colors.surface')]"
                : "border-primary/20 bg-surface text-outline hover:text-primary hover:border-primary/40"
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
            <div
              className={`flex-1 flex flex-col ${isPortrait ? "space-y-2" : "space-y-4"}`}
            >
              <h2
                className={`font-headline-lg-mobile text-primary ${isPortrait ? "text-base mb-1" : "text-2xl mb-2"}`}
              >
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
                isPortrait={isPortrait}
              />
            </div>
          )}

          {activeTab === "mode" && (
            <div
              className={`flex-1 flex flex-col justify-start ${isPortrait ? "space-y-4" : "space-y-10"}`}
            >
              <div>
                <h2
                  className={`font-headline-lg-mobile text-primary ${isPortrait ? "text-lg" : "text-4xl"}`}
                >
                  Select Game
                </h2>
                <div className={isPortrait ? "py-2" : "py-4"}>
                  <GameTypeChoice
                    value={gameType}
                    onChange={setGameType}
                    isPortrait={isPortrait}
                  />
                </div>
                {gameType === "caro" && (
                  <BoardSizeChoice
                    value={boardSize}
                    onChange={setBoardSize}
                    isPortrait={isPortrait}
                  />
                )}
              </div>
              <div className={isPortrait ? "mt-2" : "mt-8"}>
                <h2
                  className={`font-headline-lg-mobile text-primary ${isPortrait ? "text-lg pt-1" : "text-4xl pt-2"}`}
                >
                  Games per tunnel
                </h2>
                <p
                  className={`text-outline ${isPortrait ? "text-sm mt-0.5 mb-2" : "text-2xl mt-1 mb-6"}`}
                >
                  Choose the number of games to play within one tunnel before
                  settling once.
                </p>
                <div className={isPortrait ? "py-1" : "py-2"}>
                  <GamesPerTunnelChoice
                    value={maxGames}
                    onChange={setMaxGames}
                    isPortrait={isPortrait}
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === "difficulty" && (
            <div
              className={`flex-1 flex flex-col justify-start ${isPortrait ? "space-y-4" : "space-y-8"}`}
            >
              <h2
                className={`font-headline-lg-mobile text-primary ${isPortrait ? "text-lg" : "text-4xl"}`}
              >
                Set Bot Difficulty
              </h2>
              <p
                className={`text-outline ${isPortrait ? "text-sm mt-0.5 mb-2" : "text-2xl mt-1 mb-6"}`}
              >
                Adjust the intelligence level of the bots.
              </p>
              <div className={isPortrait ? "py-2" : "py-4"}>
                <DifficultyChoice
                  value={difficulty}
                  onChange={setDifficulty}
                  isPortrait={isPortrait}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
