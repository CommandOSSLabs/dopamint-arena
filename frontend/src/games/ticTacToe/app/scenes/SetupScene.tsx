import { useState } from "react";
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
          className={`qp-btn transition-colors ${isPortrait ? "!px-4 !py-3 !text-lg" : "!px-10 !py-6 !text-4xl"
            } ${value === o.id
              ? "qp-btn--go"
              : ""
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
        className={`text-[var(--qp-amber)] tracking-[0.08em] uppercase font-bold ${isPortrait ? "text-lg" : "text-3xl"} mb-2`}
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
            className={`qp-btn transition-colors ${isPortrait ? "!px-4 !py-2 !text-base" : "!px-10 !py-5 !text-4xl"
              } ${value === n
                ? "qp-btn--go"
                : ""
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
          className={`qp-input bg-[#fffdf6] border-2 border-[var(--qp-ink)] focus:border-[var(--qp-amber)] rounded-md font-mono tabular-nums text-center outline-none ${isPortrait
              ? "w-20 px-2 py-2 text-base"
              : "w-48 px-6 py-5 text-4xl"
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
          className={`qp-btn transition-colors ${isPortrait ? "!px-4 !py-2 !text-base" : "!px-10 !py-5 !text-4xl"
            } ${value === n
              ? "qp-btn--go"
              : ""
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
        data-testid="ttt-max-games"
        className={`qp-input bg-[#fffdf6] border-2 border-[var(--qp-ink)] focus:border-[var(--qp-amber)] rounded-md font-mono tabular-nums text-center outline-none ${isPortrait
            ? "w-16 px-2 py-2 text-base"
            : "w-40 px-6 py-5 text-4xl"
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
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={`qp-btn transition-colors flex flex-col items-start text-left ${isPortrait
                ? "!px-4 !py-3 !text-sm"
                : "!px-6 !py-5 !text-2xl"
              } ${active
                ? "qp-btn--go shadow-sm"
                : ""
              }`}
            style={{ transform: active ? `rotate(${rotation})` : "none" }}
          >
            <span className="font-bold">{o.label}</span>
            <span
              className={`opacity-80 mt-1 ${isPortrait ? "text-[10px]" : "text-lg"} leading-tight font-mono`}
            >
              {o.desc}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function SetupScene({
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
  preparingLabel,
}: {
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
  /** Non-null while actively funding bots — shows a small status indicator instead of
   *  the Start button's enabled state. */
  preparingLabel?: string;
}) {
  const [activeTab, setActiveTab] = useState<"mode" | "difficulty">("mode");

  return (
    <div className="qp-panel qp-stroke w-[98%] max-w-[120rem] h-[98%] max-h-none p-6 md:p-12 flex flex-col text-left mx-auto">
      {/* Page Header */}
      <header
        className={`flex justify-between items-start border-[var(--qp-ink-soft)] pb-4 shrink-0 ${isPortrait ? "border-b-2" : "border-b-4"}`}
      >
        <div className="flex flex-col items-start gap-1 mt-1">
          <h1
            className={`qp-title ${isPortrait ? "text-3xl" : "text-4xl md:text-5xl"
              }`}
          >
            Tic-Tac-Toe
          </h1>
          <button
            onClick={onBack}
            className={`font-bold text-[var(--qp-ink-soft)] hover:text-[var(--qp-ink)] flex items-center gap-1.5 transition-colors mt-1 uppercase tracking-widest ${isPortrait ? "text-xs" : "text-lg"
              }`}
          >
            <span className={`material-symbols-outlined ${isPortrait ? "text-sm" : "text-2xl"}`}>
              arrow_back
            </span>
            Return to Main menu
          </button>
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          {preparingLabel && (
            <div
              className={`text-right text-secondary font-headline-lg italic animate-pulse bg-secondary/10 rounded-lg border-secondary/30 shadow-sm w-max ${isPortrait
                  ? "text-xs px-2 py-1 border"
                  : "text-lg px-4 py-2 border-2"
                }`}
            >
              {preparingLabel}
            </div>
          )}
          <button
            onClick={onStart}
            disabled={!funded}
            data-testid="ttt-start"
            className={`qp-btn qp-btn--go transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center font-black ${isPortrait
                ? "!px-6 !py-3 !text-base gap-2"
                : "!px-10 !py-4 !text-3xl gap-4"
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
          className={`flex gap-4 border-[var(--qp-ink-soft)] pb-0.5 shrink-0 mt-2 border-b-2`}
        >
          <button
            type="button"
            onClick={() => setActiveTab("mode")}
            className={`transition-colors font-bold uppercase tracking-widest ${isPortrait ? "px-2 py-2 text-sm" : "px-4 py-4 text-2xl"
              } ${activeTab === "mode"
                ? "text-[var(--qp-ink)] border-b-4 border-[var(--qp-ink)] -mb-[3px]"
                : "text-[var(--qp-ink-soft)] hover:text-[var(--qp-ink)]"
              }`}
          >
            Play Mode
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("difficulty")}
            className={`transition-colors font-bold uppercase tracking-widest ${isPortrait ? "px-2 py-2 text-sm" : "px-4 py-4 text-2xl"
              } ${activeTab === "difficulty"
                ? "text-[var(--qp-ink)] border-b-4 border-[var(--qp-ink)] -mb-[3px]"
                : "text-[var(--qp-ink-soft)] hover:text-[var(--qp-ink)]"
              }`}
          >
            Difficulty
          </button>
        </div>

        {/* Tab Content Box - Stretches to bottom */}
        <div className="flex-1 mt-2 flex flex-col justify-start pb-4">
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
