import { useState } from "react";
import type { GameWindowProps } from "../types";
import { DUEL, glass } from "./ui/tokens";
import { DuelView } from "./ui/DuelView";
import { type DuelDifficulty } from "./usePaintDuel";
import { usePaintDuelOnchain } from "./usePaintDuelOnchain";

/**
 * Pixel Wall ("Pixel Duel") — a secret-shape pixel duel on the Sui tunnel. TWO
 * modes, both running the SAME game (memorize a hidden shape, paint it from
 * memory, sabotage the opponent, reveal + score):
 *   - Play vs Bot (PvE): you duel a design-bot.
 *   - Watch Bots (Auto): two bots duel each other while you spectate.
 * The chooser mirrors the Battleship window's horizontal mode-bar + difficulty
 * pills. Difficulty tunes the bot(s) in both modes.
 */

type PaintMode = "vs-bot" | "auto";
const DIFFICULTIES: readonly DuelDifficulty[] = ["easy", "normal", "hard"];
const DIFFICULTY_LABEL: Record<DuelDifficulty, string> = {
  easy: "Easy",
  normal: "Normal",
  hard: "Hard",
};

export function PaintWindow(_props: GameWindowProps) {
  const [mode, setMode] = useState<PaintMode | null>(null);
  const [difficulty, setDifficulty] = useState<DuelDifficulty>("normal");

  if (mode === null) {
    return (
      <ModeChooser
        onPick={setMode}
        difficulty={difficulty}
        onDifficulty={setDifficulty}
      />
    );
  }
  return (
    <div className="relative h-full min-h-0 w-full">
      <DuelMode mode={mode} difficulty={difficulty} />
      <button
        onClick={() => setMode(null)}
        className="absolute right-4 top-3.5 z-10 flex h-[52px] items-center rounded-[14px] px-3 text-xs font-bold"
        style={{ ...glass, color: DUEL.text }}
        title="Back to modes"
      >
        ✕ Modes
      </button>
    </div>
  );
}

/** Mounts the duel hook keyed by mode so switching modes rebuilds a fresh duel.
 *  Branch on the (stable, keyed) mode so each child calls exactly one hook: BOTH
 *  modes run over an OffchainTunnel, differing only in who drives seat A — a bot
 *  (auto) or you (vs-bot). */
function DuelMode({
  mode,
  difficulty,
}: {
  mode: PaintMode;
  difficulty: DuelDifficulty;
}) {
  return mode === "auto" ? (
    <AutoDuelInner key={mode} difficulty={difficulty} />
  ) : (
    <VsBotDuelInner key={mode} difficulty={difficulty} />
  );
}

/** Play vs Bot — your seat-A paints + the bot's seat-B ticks co-signed over an
 *  OffchainTunnel (fog stays on; the local duel still drives the UI), reporting
 *  heartbeat TPS and (when the bots hold gas) settling on-chain. */
function VsBotDuelInner({ difficulty }: { difficulty: DuelDifficulty }) {
  const { duel, status } = usePaintDuelOnchain({ difficulty, auto: false });
  return <DuelView duel={duel} onchain={status} />;
}

/** Watch Bots (Auto) — bot-vs-bot self-play co-signed over an OffchainTunnel,
 *  reporting heartbeat TPS and (when the bots hold gas) settling on-chain. */
function AutoDuelInner({ difficulty }: { difficulty: DuelDifficulty }) {
  const { duel, status } = usePaintDuelOnchain({ difficulty, auto: true });
  return <DuelView duel={duel} onchain={status} />;
}

// ---- Mode chooser (Battleship-style mode-bar + difficulty pills) ---------
function ModeChooser({
  onPick,
  difficulty,
  onDifficulty,
}: {
  onPick: (m: PaintMode) => void;
  difficulty: DuelDifficulty;
  onDifficulty: (d: DuelDifficulty) => void;
}) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center"
      style={{ background: DUEL.bg }}
    >
      <div>
        <div className="text-2xl font-extrabold" style={{ color: DUEL.accent }}>
          ⚔️ Pixel Duel
        </div>
        <p className="mt-1 max-w-[24rem] text-xs" style={{ color: DUEL.muted }}>
          Memorize a secret shape, paint it from memory, and sabotage your
          opponent's. Highest match wins the stake.
        </p>
      </div>

      <DifficultyPicker difficulty={difficulty} onDifficulty={onDifficulty} />

      <div className="flex flex-wrap justify-center gap-2">
        <button
          onClick={() => onPick("vs-bot")}
          className="rounded-full px-4 py-2 text-sm font-semibold transition-transform hover:-translate-y-0.5"
          style={{
            background: DUEL.accent,
            color: "#06203B",
            boxShadow: "0 0 12px rgba(77,162,255,0.3)",
          }}
        >
          Play vs Bot
        </button>
        <button
          onClick={() => onPick("auto")}
          className="rounded-full border px-4 py-2 text-sm font-semibold transition-transform hover:-translate-y-0.5"
          style={{
            borderColor: DUEL.panelBorder,
            background: "rgba(77,162,255,0.08)",
            color: DUEL.accent,
          }}
        >
          Watch Bots (Auto)
        </button>
      </div>
    </div>
  );
}

/** Segmented Easy / Normal / Hard control for the bot(s)' skill. */
function DifficultyPicker({
  difficulty,
  onDifficulty,
}: {
  difficulty: DuelDifficulty;
  onDifficulty: (d: DuelDifficulty) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span
        className="text-[11px] uppercase tracking-wide"
        style={{ color: DUEL.muted }}
      >
        Bot difficulty
      </span>
      <div
        className="inline-flex rounded-full border p-0.5"
        style={{
          borderColor: DUEL.panelBorder,
          background: "rgba(77,162,255,0.08)",
        }}
      >
        {DIFFICULTIES.map((d) => {
          const active = d === difficulty;
          return (
            <button
              key={d}
              onClick={() => onDifficulty(d)}
              aria-pressed={active}
              className="rounded-full px-3 py-1 text-xs font-semibold transition-colors"
              style={
                active
                  ? { background: DUEL.accent, color: "#06203B" }
                  : { color: DUEL.accent }
              }
            >
              {DIFFICULTY_LABEL[d]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
