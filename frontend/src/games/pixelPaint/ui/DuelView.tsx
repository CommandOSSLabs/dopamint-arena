/**
 * DuelView — the FOG-OF-WAR "secret-shape duel" board (you vs a bot). A big
 * pan/zoom PixelCanvas shows the wall under fog: in vs-bot you see ONLY your own
 * painted cells + cells an attack has REVEALED (the bot's hidden builds stay
 * fogged); in auto/spectator you watch both shapes god-view. A faint
 * paint-by-numbers GUIDE of YOUR shape flashes during the 10s memorize window,
 * then hides. MONOCHROME — your seat color is fixed (Sui blue), so there's no
 * palette; a "You ●" chip + cyan cooldown ring sit in its place. A "YOUR
 * MISSION" panel tracks your live completion and a HIT/MISS strip tallies your
 * probes. On reveal the fog lifts and an overlay shows BOTH designs, both %, the
 * winner, and the stake outcome. Pure presentation over `usePaintDuel`.
 */
import { useMemo } from "react";
import { PixelCanvas } from "./PixelCanvas";
import { ActivityFeed } from "./panels";
import { DraggablePanel } from "./DraggablePanel";
import { CooldownRing } from "./CooldownRing";
import { DUEL, glass, COOLDOWN_MS } from "./tokens";
import { cooldownState } from "./cooldown";
import { colorHex } from "../palette";
import {
  PROBE_COLOR,
  type DuelSpeed,
  type UsePaintDuel,
} from "../usePaintDuel";
import type { PaintDuelOnchainStatus } from "../usePaintDuelOnchain";
import type { PlacementEvent } from "../types";

/** Stake at risk in the duel — mirrors the protocol config in usePaintDuel. */
const STAKE = 10;

export function DuelView({
  duel,
  onchain,
}: {
  duel: UsePaintDuel;
  /** On-chain tunnel status for the Watch-Bots-Auto run (absent in vs-bot). */
  onchain?: PaintDuelOnchainStatus;
}) {
  const auto = duel.auto;
  const revealed = duel.phase === "revealed";
  const memorizing = duel.phase === "memorize";
  const memSec = Math.ceil(duel.memorizeRemaining / 1000);
  const youPct = Math.round(duel.scores.you.pct * 100);
  // In auto (Watch Bots) god-view both bots are fully shown, so the opponent's
  // live completion is public; in vs-bot it stays fogged ("??? hidden").
  const botPct = Math.round(duel.scores.bot.pct * 100);
  // Cooldown derived from remaining ms so the ring drains with the same math as
  // every other mode's dock.
  const cooldown = cooldownState(0, duel.cooldownRemaining, COOLDOWN_MS);

  // Probe tally for the human seat (A), scoped to YOUR own placements so bot
  // probes never leak into your count. A placement OFF your target is an attack;
  // it's a HIT if that cell ended up blocked (it lay in the bot's shape),
  // otherwise a MISS. Derived from `events` + overlays so the hook stays additive.
  const probeTally = useMemo(
    () => tallyProbes(duel.events, duel.blocked, duel.yourTarget, duel.state.width),
    [duel.events, duel.blocked, duel.yourTarget, duel.state.width],
  );
  // Your two headline stats: total attacks fired (hits + misses) and how many of
  // YOUR shape cells the bot has blocked ("cells lost"). The cells-lost count is
  // a derived tally from the hook, so no shape data crosses the boundary.
  const yourAttacks = probeTally.hits + probeTally.misses;
  const yourCellsLost = duel.cellsLost.you;

  // AUTO god-view: per-seat attack totals for the symmetric pair shown for both
  // bots. Both seats are bot-driven here, so every attack is probe-colored and a
  // simple feed count isolates it (cheap to skip outside spectator mode).
  const botAAttacks = auto ? countSeatAttacks(duel.events, "A") : 0;
  const botBAttacks = auto ? countSeatAttacks(duel.events, "B") : 0;

  // FOG: in vs-bot you see your cells + revealed cells; in auto it's god-view.
  // Once revealed, drop the mask so the final board shows everything.
  const fogMask = !auto && !revealed ? duel.visibleMask : undefined;

  // FOG for the activity feed: in vs-bot show ONLY your own moves + bot cells that
  // are REVEALED (its attacks) — never the bot's hidden build coordinates, which
  // would let you reconstruct its secret shape. God-view (all events) in auto.
  const feedWidth = duel.state.width;
  const feedEvents =
    auto || revealed
      ? duel.events
      : duel.events.filter(
          (e) => e.by === "A" || duel.revealed[e.y * feedWidth + e.x] === 1,
        );

  // On reveal, overlay BOTH full target shapes (each in its seat color) as a faint
  // guide so you see exactly WHERE the bot's shape was + what it intended — even
  // the cells it never finished. Painted cells already show solid (fog dropped).
  const revealGuide = useMemo(() => {
    if (!revealed || !duel.botTarget) return undefined;
    const merged = duel.yourTarget.slice();
    const bt = duel.botTarget;
    for (let i = 0; i < merged.length; i++) {
      if (merged[i] === 0 && bt[i] !== 0) merged[i] = bt[i];
    }
    return merged;
  }, [revealed, duel.botTarget, duel.yourTarget]);

  return (
    <div
      className="relative h-full min-h-0 w-full overflow-hidden"
      style={{ background: DUEL.bg }}
    >
      <PixelCanvas
        state={duel.state}
        // In auto (spectator) mode the human never paints — no ghost cursor.
        ghostColor={revealed || auto ? null : colorHex(duel.yourColor)}
        disabled={revealed || auto}
        onPlace={(x, y) => duel.place(x, y)}
        tool="draw"
        guide={
          revealed
            ? revealGuide
            : !auto && duel.guideVisible
              ? duel.guideColors
              : undefined
        }
        reveal={fogMask}
        blocked={duel.blocked}
      />

      {memorizing && <MemorizeBadge sec={memSec} design={duel.yourDesignName} />}

      {/* Top strip: title + live mission status */}
      <div
        className="absolute left-4 right-4 top-3.5 flex h-[52px] items-center gap-3 rounded-[14px] px-4"
        style={glass}
      >
        <span
          className="text-sm font-extrabold tracking-wide"
          style={{ color: DUEL.accent }}
        >
          ⚔️ Pixel Duel
        </span>
        <span
          className="hidden flex-1 truncate text-center text-xs sm:block"
          style={{ color: DUEL.muted }}
        >
          {auto
            ? "God-view: watch both bots build hidden shapes & probe each other"
            : "Fog of war · build your shape, probe to reveal & block the bot's"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {onchain && <OnchainChip status={onchain} />}
          <span
            className="rounded-full px-2.5 py-1 text-xs font-bold tabular-nums"
            style={{ background: "rgba(255,255,255,0.06)", color: DUEL.text }}
          >
            💰 {STAKE} on the line
          </span>
        </div>
      </div>

      {/* YOUR MISSION panel — draggable, default top-left. */}
      <DraggablePanel
        defaultX={16}
        defaultY={78}
        width={210}
        collapsedLabel={auto ? "Bots" : "Your mission"}
      >
        <div className="p-3">
          <div
            className="mb-2 text-[11px] font-extrabold uppercase tracking-wider"
            style={{ color: DUEL.muted }}
          >
            {auto ? "Bot A's shape" : "Your mission"}
          </div>
          <div
            className="mb-1 flex items-center gap-2 text-sm font-extrabold"
            style={{ color: DUEL.text }}
          >
            <span className="truncate">
              🎯 {auto ? "Bot A · " : ""}
              {duel.yourDesignName}
            </span>
            {auto && (
              <span
                className="ml-auto tabular-nums"
                style={{ color: DUEL.accent }}
              >
                {youPct}%
              </span>
            )}
          </div>
          <div className="mb-2 text-[11px]" style={{ color: DUEL.muted }}>
            {auto
              ? "Spectating — bots paint from their own plan."
              : memorizing
                ? `Memorize it — guide hides in ${memSec}s`
                : "Guide's gone — paint it from memory."}
          </div>
          <ProgressBar pct={youPct} color={DUEL.accent} />
          <div
            className="mt-1 text-[10px] uppercase tracking-wider"
            style={{ color: DUEL.muted }}
          >
            {duel.scores.you.correct}/{duel.scores.you.total} cells · {youPct}%
          </div>

          {/* AUTO: Bot A's attack/defense pair (symmetric with Bot B below). */}
          {auto && (
            <div className="mt-2 flex items-center gap-2 text-[11px] font-bold tabular-nums">
              <span style={{ color: DUEL.accent }}>🗡️ {botAAttacks} attacks</span>
              <span style={{ color: DUEL.muted }}>·</span>
              <span style={{ color: DUEL.hit }}>🎯 {duel.cellsLost.bot} hits</span>
              <span style={{ color: DUEL.muted }}>·</span>
              <span style={{ color: DUEL.muted }}>
                🛡️ {duel.cellsLost.you} lost
              </span>
            </div>
          )}

          {/* Probe tally — only meaningful for the human seat (vs-bot). */}
          {!auto && (
            <div className="mt-2 flex items-center gap-2 text-[11px] font-bold tabular-nums">
              <span style={{ color: DUEL.accent }}>
                🎯 {probeTally.hits} hit
              </span>
              <span style={{ color: DUEL.muted }}>·</span>
              <span style={{ color: DUEL.muted }}>
                💨 {probeTally.misses} miss
              </span>
            </div>
          )}

          {/* Your attacks (hits + misses) and shape cells the bot has blocked. */}
          {!auto && (
            <div className="mt-1 flex items-center gap-2 text-[11px] font-bold tabular-nums">
              <span style={{ color: DUEL.text }}>🗡️ {yourAttacks} attacks</span>
              <span style={{ color: DUEL.muted }}>·</span>
              <span style={{ color: DUEL.seatB }}>
                🛡️ {yourCellsLost} cells lost
              </span>
            </div>
          )}

          <div
            className="mt-3 mb-1 text-[11px] font-extrabold uppercase tracking-wider"
            style={{ color: DUEL.muted }}
          >
            Opponent
          </div>
          {auto ? (
            // GOD-VIEW: no secret to protect — show Bot B's name, %, and bar.
            <>
              <div className="flex items-center gap-2 text-sm font-bold">
                <span style={{ color: DUEL.seatB }}>
                  🤖 Bot B · {duel.botDesignName ?? "—"}
                </span>
                <span
                  className="ml-auto tabular-nums"
                  style={{ color: DUEL.seatB }}
                >
                  {botPct}%
                </span>
              </div>
              <div className="mt-1.5">
                <ProgressBar pct={botPct} color={DUEL.seatB} />
              </div>
              <div
                className="mt-1 text-[10px] uppercase tracking-wider"
                style={{ color: DUEL.muted }}
              >
                {duel.scores.bot.correct}/{duel.scores.bot.total} cells
              </div>
              {/* Bot B's symmetric attack/defense pair. */}
              <div className="mt-2 flex items-center gap-2 text-[11px] font-bold tabular-nums">
                <span style={{ color: DUEL.seatB }}>
                  🗡️ {botBAttacks} attacks
                </span>
                <span style={{ color: DUEL.muted }}>·</span>
                <span style={{ color: DUEL.hit }}>🎯 {duel.cellsLost.you} hits</span>
                <span style={{ color: DUEL.muted }}>·</span>
                <span style={{ color: DUEL.muted }}>
                  🛡️ {duel.cellsLost.bot} lost
                </span>
              </div>
            </>
          ) : (
            // vs-bot: opponent stays fogged until reveal — never leak the shape.
            <div className="flex items-center gap-2 text-sm font-bold">
              <span style={{ color: DUEL.seatB }}>🤖 Bot</span>
              <span style={{ color: DUEL.muted }}>· ??? hidden</span>
            </div>
          )}
        </div>
      </DraggablePanel>

      {/* Live activity — draggable, default top-right (16px in from the right). */}
      <DraggablePanel
        defaultX={16}
        defaultY={78}
        anchor="right"
        width={200}
        collapsedLabel="Live activity"
      >
        <ActivityFeed events={feedEvents} />
      </DraggablePanel>

      {/* MONOCHROME dock — no palette to pick. A fixed "You ●" color chip plus
          the cyan cooldown ring gate your placements. Hidden when spectating
          (no human paints) or after reveal. */}
      {!revealed && !auto && (
        <SeatColorDock color={duel.yourColor} cooldown={cooldown} />
      )}

      {/* draw/give-up controls + bot fast-forward */}
      <div className="absolute bottom-[18px] right-4 flex items-center gap-2">
        {!revealed && (
          <SpeedPills speed={duel.speed} onSpeed={duel.setSpeed} />
        )}
        {!revealed && (
          <DuelButton onClick={duel.reveal} title="End the duel and score now">
            🏁 Finish
          </DuelButton>
        )}
        <DuelButton primary onClick={duel.reset} title="Start a fresh duel">
          ↻ New duel
        </DuelButton>
      </div>

      {revealed && <RevealOverlay duel={duel} />}
    </div>
  );
}

/** Shorten a 0x digest for the chip: `0x1234…cdef`. */
function shortDigest(d: string): string {
  return d.length > 12 ? `${d.slice(0, 6)}…${d.slice(-4)}` : d;
}

/** One-line on-chain status for the chip, by phase. */
function onchainLabel(s: PaintDuelOnchainStatus): string {
  const moves = `${s.movesCoSigned} co-signed`;
  switch (s.phase) {
    case "opening":
      return "tunnel: opening…";
    case "open":
      return `tunnel: open · ${moves}`;
    case "settling":
      return `tunnel: settling · ${moves}`;
    case "settled":
      return `tunnel: settled ✓ ${
        s.settleDigest ? shortDigest(s.settleDigest) : ""
      } · ${moves}`;
    case "error":
      return "on-chain error";
    default:
      return `off-chain demo · ${moves}`;
  }
}

/**
 * Small glass chip showing the Watch-Bots-Auto tunnel lifecycle: opening → open →
 * settled ✓ <digest> with a live co-signed-move count, or "off-chain demo" when
 * the bots have no gas (still co-signing locally + reporting heartbeat TPS).
 */
function OnchainChip({ status }: { status: PaintDuelOnchainStatus }) {
  const settled = status.phase === "settled";
  const isError = status.phase === "error";
  const demo = status.phase === "demo" || status.phase === "idle";
  const color = settled
    ? "#7ee787"
    : isError
      ? DUEL.hit
      : demo
        ? DUEL.muted
        : DUEL.accent;
  return (
    <span
      className="hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold tabular-nums md:inline-flex"
      style={{ ...glass, color }}
      title={status.tunnelId ?? "off-chain demo"}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: color, boxShadow: `0 0 6px ${color}` }}
      />
      {onchainLabel(status)}
    </span>
  );
}

/** Big centered countdown during the opening "memorize" flash, then it vanishes. */
function MemorizeBadge({ sec, design }: { sec: number; design: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div
        className="rounded-2xl px-6 py-4 text-center"
        style={{ ...glass, border: `1px solid ${DUEL.accent}` }}
      >
        <div
          className="text-[11px] font-extrabold uppercase tracking-widest"
          style={{ color: DUEL.muted }}
        >
          Memorize your shape
        </div>
        <div
          className="my-1 text-4xl font-extrabold tabular-nums"
          style={{ color: DUEL.accent }}
        >
          {sec}
        </div>
        <div className="text-xs font-bold" style={{ color: DUEL.text }}>
          🎯 {design} — guide hides, then paint from memory
        </div>
      </div>
    </div>
  );
}

/** Full-board reveal: both designs, both %, winner + stake outcome. */
function RevealOverlay({ duel }: { duel: UsePaintDuel }) {
  const auto = duel.auto;
  const youPct = Math.round(duel.scores.you.pct * 100);
  const botPct = Math.round(duel.scores.bot.pct * 100);
  const w = duel.winner; // 1 you/A, 2 bot/B, 3 draw
  const headline = auto
    ? w === 1
      ? "🏆 Bot A wins the duel"
      : w === 2
        ? "🏆 Bot B wins the duel"
        : "🤝 Draw — shapes tied"
    : w === 1
      ? "🏆 You win the duel"
      : w === 2
        ? "🤖 Bot wins the duel"
        : "🤝 Draw — shapes tied";
  const stakeLine = auto
    ? w === 3
      ? `No stake moves — ${STAKE} stays put.`
      : `+${STAKE} to ${w === 1 ? "Bot A" : "Bot B"} (the other pays the stake).`
    : w === 3
      ? `No stake moves — ${STAKE} stays put.`
      : w === 1
        ? `+${STAKE} to you (bot pays the stake).`
        : `−${STAKE} from you (bot takes the stake).`;

  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div
        className="w-full max-w-[30rem] rounded-2xl p-5 text-center"
        style={{ ...glass, border: `1px solid ${DUEL.accent}` }}
      >
        <div
          className="mb-1 text-xl font-extrabold"
          style={{ color: DUEL.text }}
        >
          {headline}
        </div>
        <div className="mb-4 text-xs" style={{ color: DUEL.muted }}>
          {stakeLine}
        </div>
        <div className="flex gap-3">
          <RevealCard
            label={auto ? "Bot A" : "You"}
            design={duel.yourDesignName}
            pct={youPct}
            correct={duel.scores.you.correct}
            total={duel.scores.you.total}
            color={DUEL.accent}
            won={w === 1}
            lost={duel.cellsLost.you}
          />
          <RevealCard
            label={auto ? "Bot B" : "Bot"}
            design={duel.botDesignName ?? "—"}
            pct={botPct}
            correct={duel.scores.bot.correct}
            total={duel.scores.bot.total}
            color={DUEL.seatB}
            won={w === 2}
            lost={duel.cellsLost.bot}
          />
        </div>
        <button
          onClick={duel.reset}
          className="mt-4 rounded-[12px] px-4 py-2 text-xs font-extrabold transition-transform hover:-translate-y-0.5"
          style={{
            background: DUEL.accent,
            color: "#06203B",
            boxShadow: "0 3px 0 rgba(6,32,59,0.5)",
          }}
        >
          ↻ New duel
        </button>
      </div>
    </div>
  );
}

function RevealCard({
  label,
  design,
  pct,
  correct,
  total,
  color,
  won,
  lost,
}: {
  label: string;
  design: string;
  pct: number;
  correct: number;
  total: number;
  color: string;
  won: boolean;
  /** Cells of this seat's shape the enemy blocked — explains the shrunk goal. */
  lost?: number;
}) {
  return (
    <div
      className="flex-1 rounded-[14px] p-3 text-left"
      style={{
        background: "rgba(255,255,255,0.04)",
        border: won ? `1px solid ${color}` : "1px solid transparent",
      }}
    >
      <div className="flex items-center gap-1.5">
        <span className="h-3 w-3 rounded-sm" style={{ background: color }} />
        <span className="text-xs font-extrabold" style={{ color: DUEL.text }}>
          {label}
        </span>
        {won && <span className="ml-auto text-sm">🏆</span>}
      </div>
      <div
        className="mt-1 truncate text-[13px] font-bold"
        style={{ color: DUEL.text }}
      >
        {design}
      </div>
      <div
        className="mt-2 text-2xl font-extrabold tabular-nums"
        style={{ color }}
      >
        {pct}%
      </div>
      <div className="text-[10px] tabular-nums" style={{ color: DUEL.muted }}>
        {correct}/{total} cells
      </div>
      {lost !== undefined && (
        <div
          className="text-[10px] tabular-nums"
          style={{ color: DUEL.seatB }}
        >
          🛡️ {lost} cells lost to probes
        </div>
      )}
      <div className="mt-2">
        <ProgressBar pct={pct} color={color} />
      </div>
    </div>
  );
}

function ProgressBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div
      className="h-2 overflow-hidden rounded-full"
      style={{ background: "rgba(255,255,255,0.12)" }}
    >
      <div
        style={{
          width: `${Math.min(100, Math.max(0, pct))}%`,
          height: "100%",
          background: color,
          transition: "width 0.2s linear",
        }}
      />
    </div>
  );
}

/**
 * MONOCHROME placement dock — replaces the palette. Shows the seat's single
 * fixed color (no picking) and the cyan cooldown ring, matching the dock
 * position/glass of the other modes.
 */
function SeatColorDock({
  color,
  cooldown,
}: {
  color: number;
  cooldown: ReturnType<typeof cooldownState>;
}) {
  return (
    <div
      className="absolute bottom-[18px] left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-[14px] px-3 py-2"
      style={glass}
    >
      <div className="flex items-center gap-2 px-1.5 py-1">
        <span
          className="h-[26px] w-[26px] rounded-md"
          style={{
            background: colorHex(color),
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.3)",
          }}
        />
        <span className="text-xs font-bold" style={{ color: DUEL.text }}>
          You · Sui blue
        </span>
      </div>
      <div className="h-8 w-px" style={{ background: "rgba(255,255,255,0.12)" }} />
      <CooldownRing cooldown={cooldown} />
    </div>
  );
}

/** Speed multipliers offered by the fast-forward pill row. */
const SPEEDS: readonly DuelSpeed[] = [1, 2, 4];

/**
 * Compact "1× / 2× / 4×" fast-forward pill row — divides the bot tick interval
 * so the duel plays out faster. DUEL-styled segmented control matching the
 * difficulty pills; most useful in auto/Watch-Bots where you're spectating.
 */
function SpeedPills({
  speed,
  onSpeed,
}: {
  speed: DuelSpeed;
  onSpeed: (s: DuelSpeed) => void;
}) {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-[12px] px-1.5 py-1"
      style={glass}
      title="Bot tick speed"
    >
      <span
        className="px-1 text-[10px] font-extrabold uppercase tracking-wide"
        style={{ color: DUEL.muted }}
      >
        Speed
      </span>
      {SPEEDS.map((s) => {
        const active = s === speed;
        return (
          <button
            key={s}
            onClick={() => onSpeed(s)}
            aria-pressed={active}
            className="rounded-[9px] px-2.5 py-1 text-xs font-extrabold tabular-nums transition-colors"
            style={
              active
                ? { background: DUEL.accent, color: "#06203B" }
                : { color: DUEL.accent }
            }
          >
            {s}×
          </button>
        );
      })}
    </div>
  );
}

/**
 * Tally the human seat's (A) probes from its OWN placement events. A placement
 * that lands OFF your target is an attack; it's a HIT when that cell is now
 * blocked (it lay in the bot's shape), otherwise a MISS. Scoping to seat-A
 * events keeps bot probes out of your count. Note: `events` is a recent window
 * (capped), so this reads as a live "your probes" readout, not a lifetime total.
 */
function tallyProbes(
  events: readonly PlacementEvent[],
  blocked: Uint8Array,
  yourTarget: Uint8Array,
  width: number,
): { hits: number; misses: number } {
  let hits = 0;
  let misses = 0;
  for (const e of events) {
    if (e.by !== "A") continue;
    const idx = e.y * width + e.x;
    if (yourTarget[idx] !== 0) continue; // a build, not a probe
    if (blocked[idx]) hits++;
    else misses++;
  }
  return { hits, misses };
}

/**
 * Count a seat's ATTACK placements (probes) from the recent event feed. Bot
 * probes are painted in PROBE_COLOR — distinct from a seat's build color — so a
 * probe-colored placement by `seat` is exactly one attack. Used only in auto
 * god-view, where BOTH seats are bot-driven (so every attack is probe-colored).
 * Like the human probe tally it reads the capped feed — a live recent count, not
 * a lifetime total.
 */
function countSeatAttacks(
  events: readonly PlacementEvent[],
  seat: PlacementEvent["by"],
): number {
  let n = 0;
  for (const e of events) {
    if (e.by === seat && e.color === PROBE_COLOR) n++;
  }
  return n;
}

/** Local glass/accent button matching the other mode controls. */
function DuelButton({
  children,
  onClick,
  primary,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded-[12px] px-3.5 py-2 text-xs font-extrabold transition-transform hover:-translate-y-0.5"
      style={
        primary
          ? {
              background: DUEL.accent,
              color: "#06203B",
              boxShadow: "0 3px 0 rgba(6,32,59,0.5)",
            }
          : { ...glass, color: DUEL.text }
      }
    >
      {children}
    </button>
  );
}
