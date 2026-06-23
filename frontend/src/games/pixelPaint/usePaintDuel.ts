/**
 * usePaintDuel — local FOG-OF-WAR monochrome "secret-shape duel". Two SECRET
 * target shapes are dropped at random, SPREAD-APART locations (seat A in the
 * left region, seat B in the right, with a gap so they never touch). Each seat
 * paints in ONE fixed color — A is Sui blue (14), B is pink (5) — there is no
 * palette to pick. A GUIDE of your own shape flashes for MEMORIZE_MS, then hides;
 * from then on both sides build from memory AND attack.
 *
 * FOG OF WAR is the core rule: a player sees only (a) their OWN painted cells and
 * (b) cells that have been REVEALED. The opponent's hidden build cells render as
 * empty fog. Every accepted paint is classified against the PAINTER'S OWN target:
 *   - IN own target  -> BUILD: paint your color, counts toward your %, stays
 *     hidden from the opponent (not revealed).
 *   - NOT in own target -> ATTACK (a probe): the cell is REVEALED to both. If it
 *     lies in the OPPONENT's target it's a HIT — the cell is BLOCKED so the
 *     opponent can never complete it (their achievable % drops). Otherwise it's a
 *     MISS — just revealed, plus a longer self cooldown for the wasted probe.
 *
 * SCORING (per seat) is `scoreDuelFog`: cells in your target painted YOUR color
 * AND not enemy-blocked, over your unblocked target-cell count. Higher % wins;
 * the stake shifts loser→winner; a tie is a draw.
 *
 * Two flavors, selected by options:
 *   - vs-bot (default): seat A is YOU, seat B is a bot.
 *   - auto (spectator): BOTH seats are bot-driven — the same planner steers A and
 *     B so the wall plays itself out to reveal with no human input; memorize is
 *     skipped (there's no human to study the guide).
 *
 * `difficulty` ("easy" | "normal" | "hard") tunes the bot(s): tick speed, how
 * often they ATTACK vs build, and how disciplined their battleship-style search
 * is. CRUCIALLY the bot NEVER reads the foe's secret shape to aim — it probes
 * blind using only PUBLIC intel (`revealed`/`blocked` masks + its own prior probe
 * results), so a hit is earned by search+hunt, not by cheating. A wasted probe
 * (MISS) costs the bot a cooldown, exactly as it does the human.
 *
 * The PixelPaintProtocol (war mode) still drives the canvas cells; fog `revealed`
 * and `blocked` overlays live alongside it. Everything is client-side for this
 * MVP (no tunnel/crypto). A single seed drives target picks, anchors, AND every
 * bot RNG, so a test can replay an entire duel; omit `seed` for a fresh duel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PixelPaintProtocol,
  type PixelPaintState,
  type PixelPaintMove,
} from "sui-tunnel-ts/protocol/pixelPaint";
import {
  DESIGNS,
  projectDesignAt,
  type PixelDesign,
} from "@/agent/games/pixelPaint/designs";
import { scoreDuelFog, type DuelSideScore } from "./duelScore";
import { COOLDOWN_MS } from "./ui/tokens";
import type { PlacementEvent } from "./types";

const BOARD = { width: 36, height: 18 };
const OVERWRITE_LIMIT = 3;
/** Terminal placement budget — every cell painted up to its overwrite limit. A
 *  duel almost always ends earlier via targetResolved; this is the hard backstop
 *  (scaled to the board, not a fixed magic number that a small wall can't reach). */
const CAP = BOARD.width * BOARD.height * OVERWRITE_LIMIT;
/** Empty center columns separating seat A's (left) and seat B's (right) zones so
 *  the two secret shapes always sit apart and never touch — see build(). */
const ZONE_GAP = 4;
const DEFAULT_STAKE = 10;
/** The guide flashes for this long at the start, then HIDES — both sides then
 *  build from memory AND attack (the bot pauses during the study window too, for
 *  fairness). Skipped entirely in `auto` mode (no human studies the guide). */
const MEMORIZE_MS = 10000;

/** Fixed seat colors — MONOCHROME, no palette picking. */
const SEAT_A_COLOR = 14; // Sui blue
const SEAT_B_COLOR = 5; // pink

/** A whiffed probe (ATTACK that hit empty space) costs this much extra cooldown
 *  on top of the base place cooldown, to punish blind fishing. */
const MISS_PENALTY_MS = 3000;

const DESIGN_POOL: readonly PixelDesign[] = Object.values(DESIGNS);

export type DuelPhase = "memorize" | "playing" | "revealed";
export type DuelDifficulty = "easy" | "normal" | "hard";
/** Bot-tick speed multiplier: divides `profile.tickMs` so the duel fast-forwards
 *  (1× = real cadence, 4× = four times as fast). Caps the discrete pill choices. */
export type DuelSpeed = 1 | 2 | 4;

/** How a single paint was classified against the PAINTER's own target. */
export type PaintKind = "build" | "hit" | "miss";

/**
 * Per-difficulty bot tuning: cadence, attack appetite, and how disciplined its
 * BLIND battleship search is. None of these let the bot read the foe's shape —
 * they only shape how it explores public space.
 */
interface BotProfile {
  /** ms between bot ticks — slower is easier. */
  tickMs: number;
  /** Fraction of ticks that ATTACK (probe the enemy) instead of building. */
  attackRate: number;
  /** Chance a tick is wasted entirely (no move) — easy bots dawdle. */
  skipRate: number;
  /** Chance the bot IGNORES a live hunt target and probes blind anyway — a dumber
   *  bot fails to concentrate fire around its confirmed hits. 0 = always hunt. */
  huntSloppiness: number;
  /** Use a checkerboard (parity) bias during SEARCH so probes can't miss a ship
   *  in the gaps. Hard bots search on parity; easy bots probe any cell. */
  paritySearch: boolean;
}

const BOT_PROFILES: Record<DuelDifficulty, BotProfile> = {
  easy: { tickMs: 820, attackRate: 0.18, skipRate: 0.28, huntSloppiness: 0.5, paritySearch: false },
  normal: { tickMs: 560, attackRate: 0.3, skipRate: 0, huntSloppiness: 0.15, paritySearch: false },
  hard: { tickMs: 360, attackRate: 0.42, skipRate: 0, huntSloppiness: 0, paritySearch: true },
};

export interface DuelScores {
  you: DuelSideScore;
  bot: DuelSideScore;
}

export interface UsePaintDuelOptions {
  /** Pin the duel for replay; omit for a fresh random duel per mount. */
  seed?: number;
  /** Bot skill — affects tick speed, attack rate, and probe accuracy. */
  difficulty?: DuelDifficulty;
  /** Spectator mode: both seats are bot-driven (no human input, no memorize). */
  auto?: boolean;
  /** Initial tick-speed multiplier (1×/2×/4×). Divides `profile.tickMs` so the
   *  bots act faster; live-adjustable via the returned `setSpeed`. Default 1. */
  speed?: DuelSpeed;
  /** Display stake / pot in SUI (default 10). The on-chain tunnel stake is separate. */
  stake?: number;
  /**
   * Optional sink invoked EXACTLY ONCE per accepted move, in application order —
   * covering EVERY move that hits `applyMove`: the human's `place` (seat A in
   * vs-bot) AND both bot ticks (seat A in auto, seat B always). The on-chain
   * wrapper (`usePaintDuelOnchain`) uses it to co-sign each paint through an
   * OffchainTunnel. When set, every commit (human place + bot ticks) runs off a
   * ref (not a functional updater) so the sink can't double-fire under
   * StrictMode. Leaving it unset keeps the original client-only commit.
   */
  onMove?: (move: PixelPaintMove, by: "A" | "B") => void;
}

/** Mulberry32 — small, fast, seedable PRNG so a test can drive the whole duel. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick two DISTINCT designs from the pool using `rng`. */
function pickTwoDesigns(rng: () => number): [PixelDesign, PixelDesign] {
  const a = Math.floor(rng() * DESIGN_POOL.length);
  let b = Math.floor(rng() * (DESIGN_POOL.length - 1));
  if (b >= a) b++; // skip `a` so the two are always distinct
  return [DESIGN_POOL[a], DESIGN_POOL[b]];
}

/**
 * Project `design` at a random on-board anchor whose WHOLE bitmap is confined to
 * the column zone `[zoneLo, zoneHi)` (an absolute, design-width-aware range — not
 * a fraction of the board). Seat A gets the LEFT zone and seat B the RIGHT, with
 * an empty center gap between the zones, so on the small wall the two secret
 * shapes always land fully apart and never clip the edge or each other — even the
 * 16-wide walrus, whose zone is sized to hold it exactly. Every wanted cell is
 * recolored to `seatColor` (MONOCHROME): the projected stencil holds 0 for
 * don't-care and `seatColor` everywhere the design paints.
 */
function projectDesignInRegion(
  design: PixelDesign,
  width: number,
  height: number,
  zoneLo: number,
  zoneHi: number,
  seatColor: number,
  rng: () => number,
): Uint8Array {
  // Top-left X range that keeps the ENTIRE design inside [zoneLo, zoneHi) (and on
  // the board). Anchoring on absolute columns — rather than a fraction of
  // (width - w) — keeps wide designs from poking past the zone toward center.
  const loX = Math.max(0, zoneLo);
  const hiX = Math.max(loX, Math.min(width - design.w, zoneHi - design.w));
  const ox = loX + Math.floor(rng() * (hiX - loX + 1));
  // Y is free across the whole height (clamped to fit).
  const maxOy = Math.max(0, height - design.h);
  const oy = Math.floor(rng() * (maxOy + 1));
  // Invert projectDesignAt's offset math, then overwrite colors to monochrome.
  const anchorX = (ox + Math.floor(design.w / 2)) / (width - 1);
  const anchorY = (oy + Math.floor(design.h / 2)) / (height - 1);
  const raw = projectDesignAt(design, width, height, anchorX, anchorY);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] !== 0 ? seatColor : 0;
  return out;
}

/**
 * Classify a paint against the painter's OWN target stencil.
 *   - in own target  -> "build".
 *   - not in own target, but in the foe target -> "hit" (a blocking probe).
 *   - not in either   -> "miss" (a wasted probe).
 * Pure; exported so the duel hook and a test can share one source of truth.
 */
export function classifyPaint(
  idx: number,
  ownTarget: Uint8Array,
  foeTarget: Uint8Array,
): PaintKind {
  if (ownTarget[idx] !== 0) return "build";
  if (foeTarget[idx] !== 0) return "hit";
  return "miss";
}

/**
 * The SYMMETRIC cooldown a paint of `kind` incurs — the single source of truth
 * shared by the human `place` and both bot ticks so all seats obey one rule:
 *   - BUILD (cell in the painter's OWN shape): 0 — paint your shape at full speed.
 *   - HIT (attack landing in the foe shape): COOLDOWN_MS.
 *   - MISS (attack into empty space): COOLDOWN_MS + MISS_PENALTY_MS (the whiff tax).
 * Pure; exported so a test can pin the build-free / attack-gated contract.
 */
export function attackCooldownMs(kind: PaintKind): number {
  if (kind === "build") return 0;
  return COOLDOWN_MS + (kind === "miss" ? MISS_PENALTY_MS : 0);
}

/**
 * A seat's secret shape is RESOLVED once every wanted cell is either already
 * painted in that seat's color OR blocked by the enemy — nothing winnable
 * remains, so the seat can make no further progress. When BOTH seats are
 * resolved (or the protocol settles) the duel is terminal. Guarding on this
 * prevents the bots from grinding forever once all build cells are claimed.
 */
function targetResolved(
  canvas: Uint8Array,
  target: Uint8Array,
  blocked: Uint8Array,
  seatColor: number,
): boolean {
  for (let i = 0; i < target.length; i++) {
    if (target[i] === 0) continue;
    if (blocked[i]) continue;
    if (canvas[i] !== seatColor) return false;
  }
  return true;
}

/**
 * Count how many of a seat's wanted cells the enemy has BLOCKED — the seat's
 * "cells lost" to enemy probes. A pure tally (a count, never positions), so
 * surfacing even the opponent's figure can't reconstruct a hidden shape.
 */
function countBlockedTargetCells(
  target: Uint8Array,
  blocked: Uint8Array,
): number {
  let n = 0;
  for (let i = 0; i < target.length; i++) {
    if (target[i] !== 0 && blocked[i]) n++;
  }
  return n;
}

export interface UsePaintDuel {
  state: PixelPaintState;
  /** Your secret stencil (length width*height; 0 = don't-care, else seat color). */
  yourTarget: Uint8Array;
  yourDesignName: string;
  /** Your fixed seat color (always 14 for the human seat A). */
  yourColor: number;
  /** Alias of `yourTarget` — the faint paint-by-numbers guide for your shape. */
  guideColors: Uint8Array;
  /** True only during the opening "memorize" flash — render the guide iff this. */
  guideVisible: boolean;
  /** Milliseconds left in the memorize flash (0 once it's hidden / play begins). */
  memorizeRemaining: number;
  /** 1 where a cell is REVEALED (visible to both sides); 0 = fog. */
  revealed: Uint8Array;
  /** 1 where the enemy has BLOCKED a cell (unwinnable for its target owner). */
  blocked: Uint8Array;
  /**
   * Cells the HUMAN (seat A) may see: their own painted cells ∪ revealed cells.
   * A renderer can mask `state.canvas` against this so opponent build cells stay
   * fogged. 1 = visible, 0 = hidden.
   */
  visibleMask: Uint8Array;
  /** Place a pixel in YOUR seat color. BUILDS (cells in your shape) are always
   *  free; only ATTACKS are blocked while the attack cooldown is live. Ignored
   *  after reveal or in auto. */
  place: (x: number, y: number) => void;
  /** Milliseconds left on the ATTACK cooldown before another attack is allowed
   *  (0 when ready). Building is never gated by this. */
  cooldownRemaining: number;
  phase: DuelPhase;
  /** Spectator mode: both seats are bot-driven. Starts from the `auto` option but
   *  is LIVE — `setAuto(true)` hands seat A to a bot mid-duel. */
  auto: boolean;
  /** Hand seat A to a bot on the SAME board (vs-bot "Auto" handoff): flips the duel
   *  to bot-vs-bot self-play with no remount/new shapes; the human's place() then
   *  no-ops and the running tunnel co-signs seat A's bot moves. Idempotent. */
  setAuto: (auto: boolean) => void;
  /** Active bot skill (mirrors the `difficulty` option). */
  difficulty: DuelDifficulty;
  /** Display stake / pot in SUI (mirrors the `stake` option, default 10). */
  stake: number;
  /** Current tick-speed multiplier (1×/2×/4×) — divides the bot tick interval. */
  speed: DuelSpeed;
  /** Live-set the tick-speed multiplier; re-arms both bot intervals at the new
   *  cadence without rebuilding the duel. */
  setSpeed: (s: DuelSpeed) => void;
  /** Force the reveal/score phase (also fires automatically on terminal). */
  reveal: () => void;
  scores: DuelScores;
  /** Counts of each seat's OWN target cells the enemy has BLOCKED ("cells lost"
   *  to enemy probes). Pure tallies — never positions — so a count can't rebuild
   *  a secret shape. `you` = seat A (the human in vs-bot); `bot` = seat B. */
  cellsLost: { you: number; bot: number };
  /** The opponent's secret stencil — null until revealed. */
  botTarget: Uint8Array | null;
  /** Opponent's design name. In vs-bot it's null until reveal (fog hides seat B);
   *  in `auto` god-view it's public from the start (both bots are shown fully). */
  botDesignName: string | null;
  botColor: number;
  /** Secret-shape winner: 1 = you/A, 2 = bot/B, 3 = draw, 0 = not yet revealed. */
  winner: 0 | 1 | 2 | 3;
  reset: () => void;
  events: PlacementEvent[];
}

export function usePaintDuel(options: UsePaintDuelOptions = {}): UsePaintDuel {
  const { seed, difficulty = "normal", stake = DEFAULT_STAKE } = options;
  const profile = BOT_PROFILES[difficulty];
  // `auto` is LIVE state (not just the option) so the vs-bot "Auto" button can
  // hand seat A to a bot MID-DUEL: flipping false→true arms the seat-A bot tick on
  // the SAME board and turns the human's place() into a no-op — no remount, no new
  // shapes, the co-signing tunnel keeps running with seat A now driven by the bot.
  const [auto, setAuto] = useState<boolean>(options.auto ?? false);
  // Speed is live state (not just an option) so the pill row can fast-forward an
  // in-progress duel: changing it re-arms the bot intervals at the new cadence.
  const [speed, setSpeed] = useState<DuelSpeed>(options.speed ?? 1);
  const tickMs = Math.max(1, Math.round(profile.tickMs / speed));

  const proto = useMemo(
    () =>
      new PixelPaintProtocol({
        ...BOARD,
        cap: CAP,
        overwriteLimit: OVERWRITE_LIMIT,
        stake: BigInt(stake),
        mode: "war",
      }),
    [stake],
  );

  // One seed drives target picks, anchors, AND the bots; `seedRef` lets reset
  // advance it so a no-arg reset reshuffles, while a fixed `seed` stays replayable.
  const seedRef = useRef(seed ?? (Math.random() * 0xffffffff) >>> 0);

  /** Build a fresh duel (targets + spread-apart positions + state + bot rngs). */
  const build = useCallback(() => {
    const pickRng = mulberry32(seedRef.current);
    const [yourDesign, botDesign] = pickTwoDesigns(pickRng);
    // Split the wall into a LEFT zone (seat A), an empty center gap, and a RIGHT
    // zone (seat B). Each zone is wide enough to hold the widest design (16-wide
    // walrus), so both shapes sit fully inside their half and the gap keeps them
    // apart — no overlap, no clipping. Same stream picks the positions, so a seed
    // replays both shape AND placement.
    const leftZoneHi = Math.floor((BOARD.width - ZONE_GAP) / 2);
    const rightZoneLo = leftZoneHi + ZONE_GAP;
    const yourTarget = projectDesignInRegion(
      yourDesign,
      BOARD.width,
      BOARD.height,
      0,
      leftZoneHi,
      SEAT_A_COLOR,
      pickRng,
    );
    const botTarget = projectDesignInRegion(
      botDesign,
      BOARD.width,
      BOARD.height,
      rightZoneLo,
      BOARD.width,
      SEAT_B_COLOR,
      pickRng,
    );
    const state = proto.initialState({
      tunnelId: "0xpaint-duel",
      initialBalances: { a: 100n, b: 100n },
    });
    const size = BOARD.width * BOARD.height;
    // Each seat's bot RNG is seeded off the same root, offset per seat so their
    // build/attack choices don't mirror each other or the target-pick stream.
    const botRng = mulberry32((seedRef.current ^ 0x9e3779b9) >>> 0);
    const youRng = mulberry32((seedRef.current ^ 0x85ebca6b) >>> 0);
    return {
      yourDesign,
      botDesign,
      yourTarget,
      botTarget,
      state,
      botRng,
      youRng,
      revealed: new Uint8Array(size),
      blocked: new Uint8Array(size),
    };
  }, [proto]);

  const initial = useMemo(build, [build]);

  const [state, setState] = useState<PixelPaintState>(initial.state);
  const [yourTarget, setYourTarget] = useState<Uint8Array>(initial.yourTarget);
  const [yourDesignName, setYourDesignName] = useState(initial.yourDesign.name);
  // In auto mode there's no human to study the guide — jump straight to play.
  const [phase, setPhase] = useState<DuelPhase>(auto ? "playing" : "memorize");
  const [memorizeRemaining, setMemorizeRemaining] = useState(
    auto ? 0 : MEMORIZE_MS,
  );
  const [events, setEvents] = useState<PlacementEvent[]>([]);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);

  // Fog overlays. Kept in both a ref (mutated in place by the loops/place) and
  // React state (a fresh copy bumped on change) so renders see updates without
  // the protocol ever learning about fog. `revealed` = visible to both; `blocked`
  // = unwinnable for its target owner.
  const [revealed, setRevealed] = useState<Uint8Array>(initial.revealed);
  const [blocked, setBlocked] = useState<Uint8Array>(initial.blocked);
  const revealedRef = useRef<Uint8Array>(initial.revealed);
  const blockedRef = useRef<Uint8Array>(initial.blocked);

  // The opponent's target is kept off React state until reveal so it can't leak
  // into the rendered UI early; refs hold the live duel internals the loops read.
  const botTargetRef = useRef<Uint8Array>(initial.botTarget);
  const botDesignRef = useRef<PixelDesign>(initial.botDesign);
  const botRngRef = useRef<() => number>(initial.botRng);
  const youRngRef = useRef<() => number>(initial.youRng);
  const yourTargetRef = useRef<Uint8Array>(initial.yourTarget);
  yourTargetRef.current = yourTarget;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const lastPlaceRef = useRef(0); // ms timestamp of your last accepted place
  const cooldownUntilRef = useRef(0); // ms timestamp your ATTACK cooldown ends (builds never gate; miss penalty extends it)
  // Per-seat bot ATTACK cooldown: an attack tick pauses that bot until this ms
  // timestamp (COOLDOWN_MS, + MISS_PENALTY_MS on a whiff); builds never pause.
  // Same symmetric rule the human obeys. Seat A's only matters in auto mode
  // (where a bot drives A); seat B's always.
  const botPausedUntilRef = useRef<{ A: number; B: number }>({ A: 0, B: 0 });

  // Revealed snapshot of the opponent target (null while playing).
  const [botTarget, setBotTarget] = useState<Uint8Array | null>(null);
  const [botDesignName, setBotDesignName] = useState<string | null>(null);

  const pushEvent = useCallback((e: PlacementEvent) => {
    setEvents((prev) => [e, ...prev].slice(0, 24));
  }, []);

  const reveal = useCallback(() => {
    setPhase((p) => (p === "revealed" ? p : "revealed"));
    setBotTarget(botTargetRef.current);
    setBotDesignName(botDesignRef.current.name);
  }, []);

  /**
   * Apply a seat's accepted move to the fog overlays. Classifies the paint
   * against the painter's own target: a BUILD stays hidden; an ATTACK reveals the
   * cell and, on a HIT, blocks it for the foe. Mutates the refs in place AND
   * bumps the React copies so the canvas re-renders. Returns the classification
   * (so `place` can apply the miss penalty).
   */
  const applyFog = useCallback(
    (idx: number, seat: "A" | "B"): PaintKind => {
      const ownTarget = seat === "A" ? yourTargetRef.current : botTargetRef.current;
      const foeTarget = seat === "A" ? botTargetRef.current : yourTargetRef.current;
      const kind = classifyPaint(idx, ownTarget, foeTarget);
      if (kind === "build") return kind; // stays hidden — no fog change
      // ATTACK: reveal the probed cell to both sides.
      if (!revealedRef.current[idx]) {
        revealedRef.current[idx] = 1;
        setRevealed(revealedRef.current.slice());
      }
      // HIT: block the foe's cell so they can never complete it.
      if (kind === "hit" && !blockedRef.current[idx]) {
        blockedRef.current[idx] = 1;
        setBlocked(blockedRef.current.slice());
      }
      return kind;
    },
    [],
  );

  // Memorize flash: show the guide for MEMORIZE_MS, then hide it and start play.
  // The bot is paused (effects below gate on phase === "playing") so the study
  // window is fair to both sides. Auto mode skips this entirely.
  const memorizeStartRef = useRef(0);
  useEffect(() => {
    if (phase !== "memorize") return;
    memorizeStartRef.current = Date.now();
    setMemorizeRemaining(MEMORIZE_MS);
    const t = setInterval(() => {
      const left = Math.max(
        0,
        MEMORIZE_MS - (Date.now() - memorizeStartRef.current),
      );
      setMemorizeRemaining(left);
      if (left <= 0) {
        clearInterval(t);
        setPhase("playing");
      }
    }, 80);
    return () => clearInterval(t);
  }, [phase]);

  // Auto-reveal once the protocol settles (cap) or BOTH secret shapes are
  // resolved (every winnable cell painted or blocked) — whichever comes first
  // ends the duel. Only while actively playing.
  useEffect(() => {
    if (phase !== "playing") return;
    const done =
      proto.isTerminal(state) ||
      (targetResolved(
        state.canvas,
        yourTargetRef.current,
        blockedRef.current,
        SEAT_A_COLOR,
      ) &&
        targetResolved(
          state.canvas,
          botTargetRef.current,
          blockedRef.current,
          SEAT_B_COLOR,
        ));
    if (done) reveal();
  }, [state, phase, proto, reveal]);

  // Cooldown countdown (drives the UI ring); ticks only while a cooldown is live.
  useEffect(() => {
    if (cooldownRemaining <= 0) return;
    const t = setInterval(() => {
      const left = Math.max(0, cooldownUntilRef.current - Date.now());
      setCooldownRemaining(left);
      if (left <= 0) clearInterval(t);
    }, 80);
    return () => clearInterval(t);
  }, [cooldownRemaining]);

  // Mirror of `state` readable synchronously BETWEEN renders, so the on-chain
  // wrapper's per-move commit (below) can chain consecutive bot ticks without a
  // functional updater. Refreshed every render; advanced in place per accepted
  // move so a burst of ticks before the next paint still sees the latest board.
  const stateRef = useRef(state);
  stateRef.current = state;
  // Per-move sink: read via a ref so the running interval always sees the latest.
  const onMoveRef = useRef(options.onMove);
  onMoveRef.current = options.onMove;

  // Commit one bot move for `seat`. With a move sink wired (on-chain auto), drive
  // the canvas from `stateRef` and notify the sink EXACTLY once per accepted move
  // — a functional updater would double-invoke under StrictMode and double-co-sign
  // the tunnel. Without a sink (vs-bot + plain auto) this is the original
  // functional-updater commit, behavior-identical. Picks the move by the same
  // BLIND planner, then applies the SYMMETRIC build-free / attack-gated cooldown.
  const tickSeat = useCallback(
    (seat: "A" | "B") => {
      const now = Date.now();
      const ownTarget =
        seat === "A" ? yourTargetRef.current : botTargetRef.current;
      const rng = seat === "A" ? youRngRef.current : botRngRef.current;
      const seatColor = seat === "A" ? SEAT_A_COLOR : SEAT_B_COLOR;
      const sink = onMoveRef.current;

      if (sink) {
        const prev = stateRef.current;
        if (proto.isTerminal(prev) || phaseRef.current !== "playing") return;
        const mv = planBotMove(
          prev,
          ownTarget,
          revealedRef.current,
          blockedRef.current,
          rng,
          profile,
          seatColor,
        );
        if (!mv) return;
        // Gate AFTER planning, ONLY for ATTACKS — a build always proceeds.
        if (mv.color === PROBE_COLOR && now < botPausedUntilRef.current[seat]) {
          return;
        }
        // Atomic commit: applyMove + fog/cooldown/event must ALL succeed before
        // we advance React state and co-sign — else local state and the tunnel
        // diverge. Mirrors the no-sink path's all-or-nothing guarantee.
        let next: PixelPaintState;
        try {
          next = proto.applyMove(prev, mv, seat);
          stateRef.current = next;
          const kind = applyFog(mv.y * prev.width + mv.x, seat);
          const cd = attackCooldownMs(kind);
          if (cd > 0) botPausedUntilRef.current[seat] = now + cd;
          pushEvent({ ...mv, by: seat, t: now });
        } catch {
          stateRef.current = prev; // roll back the ref; nothing co-signed
          return; // cell locked / any post-move error — skip
        }
        setState(next);
        sink(mv, seat); // co-sign only a fully-committed move
        return;
      }

      setState((prev) => {
        if (proto.isTerminal(prev) || phaseRef.current !== "playing") return prev;
        const mv = planBotMove(
          prev,
          ownTarget,
          revealedRef.current,
          blockedRef.current,
          rng,
          profile,
          seatColor,
        );
        if (!mv) return prev;
        if (mv.color === PROBE_COLOR && now < botPausedUntilRef.current[seat]) {
          return prev;
        }
        try {
          const next = proto.applyMove(prev, mv, seat);
          const kind = applyFog(mv.y * prev.width + mv.x, seat);
          const cd = attackCooldownMs(kind);
          if (cd > 0) botPausedUntilRef.current[seat] = now + cd;
          pushEvent({ ...mv, by: seat, t: now });
          return next;
        } catch {
          return prev; // cell locked between plan and apply — skip
        }
      });
    },
    [proto, profile, applyFog, pushEvent],
  );

  // Seat B bot tick: builds toward its secret shape, sometimes ATTACKS by BLIND
  // battleship search/hunt over the PUBLIC `revealed`/`blocked` masks — it never
  // reads the human's shape to aim. Runs in both modes (seat B is always a bot).
  useEffect(() => {
    if (phase !== "playing") return;
    const t = setInterval(() => tickSeat("B"), tickMs);
    return () => clearInterval(t);
  }, [phase, tickMs, tickSeat]);

  // Seat A bot tick (AUTO mode only): the same BLIND planner drives YOUR seat too,
  // so the wall plays itself bot-vs-bot with no human input.
  useEffect(() => {
    if (!auto || phase !== "playing") return;
    const t = setInterval(() => tickSeat("A"), tickMs);
    return () => clearInterval(t);
  }, [auto, phase, tickMs, tickSeat]);

  // Your move: BUILDS are free (paint your own shape at click speed); only
  // ATTACKS pay the cooldown — a HIT/MISS costs ATTACK_COOLDOWN (COOLDOWN_MS),
  // and a MISS adds MISS_PENALTY_MS on top. The build-vs-attack split is decided
  // by classifying the target cell against YOUR own stencil BEFORE gating, so a
  // pending attack cooldown never blocks building. Disabled in auto mode (seat A
  // is bot-driven there). With a move sink wired (vs-bot on-chain), the accepted
  // commit runs off `stateRef` and notifies the sink EXACTLY once so the human's
  // seat-A paints are co-signed through the tunnel just like the bot's seat-B
  // ticks — a functional updater would double-fire under StrictMode and
  // double-co-sign. Without a sink this is the original functional-updater commit,
  // behavior-identical. Either way the local fog/cooldown/stats are untouched.
  const place = useCallback(
    (x: number, y: number) => {
      if (auto) return; // seat A is bot-driven in spectator mode
      if (phaseRef.current !== "playing") return; // look-only during memorize
      const now = Date.now();
      const idx = y * BOARD.width + x;
      const isAttack = yourTargetRef.current[idx] === 0; // off your shape -> attack
      // Only ATTACKS are cooldown-gated; building is always free.
      if (isAttack && now < cooldownUntilRef.current) {
        setCooldownRemaining(cooldownUntilRef.current - now);
        return; // attack still cooling down — ignore (building stays allowed)
      }
      // Probes use the NEUTRAL probe color (identical to the bot's), so YOUR
      // attacks — hits and misses alike — read as visible probe marks rather than
      // your win color. Builds keep your seat color. Scoring is unaffected: an
      // attack lands off your own target, so it never counted toward your % anyway.
      const move: PixelPaintMove = {
        x,
        y,
        color: placementColor(idx, yourTargetRef.current, SEAT_A_COLOR),
      };
      // Shared local commit for an accepted paint: advance fog/cooldown/stats and
      // push the event. Identical effects on either path; the sink path calls it
      // after a direct `setState(next)`, the legacy path from inside the updater.
      const commit = () => {
        const kind = applyFog(idx, "A");
        lastPlaceRef.current = now;
        // BUILD: no cooldown — paint your shape back-to-back. ATTACK: pay the
        // attack cooldown, plus the miss penalty for a whiffed blind probe.
        const cd = attackCooldownMs(kind);
        if (cd > 0) {
          cooldownUntilRef.current = now + cd;
          setCooldownRemaining(cd);
        }
        pushEvent({ ...move, by: "A", t: now });
      };

      const sink = onMoveRef.current;
      if (sink) {
        const prev = stateRef.current;
        if (proto.isTerminal(prev)) return;
        // Atomic commit: applyMove + commit (fog/cooldown/event) must ALL succeed
        // before we advance React state and co-sign, so local state and the tunnel
        // never diverge. Mirrors the no-sink path's all-or-nothing guarantee.
        let next: PixelPaintState;
        try {
          next = proto.applyMove(prev, move, "A");
          stateRef.current = next;
          commit();
        } catch {
          stateRef.current = prev; // roll back the ref; nothing co-signed
          return; // out of bounds / locked / any post-move error — skip
        }
        setState(next);
        sink(move, "A"); // co-sign only a fully-committed move
        return;
      }

      setState((prev) => {
        if (proto.isTerminal(prev)) return prev;
        try {
          const next = proto.applyMove(prev, move, "A");
          commit();
          return next;
        } catch {
          return prev; // out of bounds / locked — silent no-op, no cooldown spent
        }
      });
    },
    [proto, pushEvent, auto, applyFog],
  );

  const reset = useCallback(() => {
    seedRef.current =
      seed ?? ((seedRef.current * 1664525 + 1013904223) >>> 0 || 1);
    const next = build();
    botTargetRef.current = next.botTarget;
    botDesignRef.current = next.botDesign;
    botRngRef.current = next.botRng;
    youRngRef.current = next.youRng;
    yourTargetRef.current = next.yourTarget;
    revealedRef.current = next.revealed;
    blockedRef.current = next.blocked;
    lastPlaceRef.current = 0;
    cooldownUntilRef.current = 0;
    botPausedUntilRef.current = { A: 0, B: 0 };
    setYourTarget(next.yourTarget);
    setYourDesignName(next.yourDesign.name);
    setState(next.state);
    setRevealed(next.revealed);
    setBlocked(next.blocked);
    setPhase(auto ? "playing" : "memorize");
    setMemorizeRemaining(auto ? 0 : MEMORIZE_MS);
    setBotTarget(null);
    setBotDesignName(null);
    setEvents([]);
    setCooldownRemaining(0);
  }, [build, seed, auto]);

  // Fog-of-war scores. While playing, the opponent column is scored too (it's
  // used for the live win-meter) but `botTarget` stays hidden until reveal.
  const scores = useMemo<DuelScores>(
    () => ({
      you: scoreDuelFog(state.canvas, yourTargetRef.current, blockedRef.current),
      bot: scoreDuelFog(state.canvas, botTargetRef.current, blockedRef.current),
    }),
    [state, revealed, blocked],
  );

  // "Cells lost": how many of each seat's own wanted cells the enemy has blocked.
  // A count only (never positions), so exposing the bot's figure in vs-bot can't
  // reconstruct its hidden shape. Recomputed as the blocked overlay grows.
  const cellsLost = useMemo(
    () => ({
      you: countBlockedTargetCells(yourTargetRef.current, blockedRef.current),
      bot: countBlockedTargetCells(botTargetRef.current, blockedRef.current),
    }),
    [blocked, yourTarget],
  );

  // What the human may see: own painted cells ∪ revealed cells. Recomputed when
  // the canvas or the revealed overlay changes.
  const visibleMask = useMemo<Uint8Array>(() => {
    const c = state.canvas;
    const own = yourTargetRef.current;
    const rev = revealed;
    const mask = new Uint8Array(c.length);
    for (let i = 0; i < c.length; i++) {
      // A cell is yours-and-visible if you painted it in your seat color on one
      // of YOUR target cells (your hidden build); revealed cells show regardless.
      const mine = own[i] !== 0 && c[i] === SEAT_A_COLOR;
      mask[i] = rev[i] || mine ? 1 : 0;
    }
    return mask;
  }, [state, revealed]);

  const winner: 0 | 1 | 2 | 3 =
    phase !== "revealed"
      ? 0
      : scores.you.pct > scores.bot.pct
        ? 1
        : scores.bot.pct > scores.you.pct
          ? 2
          : 3;

  // GOD-VIEW: in auto (spectator) mode there's no human secret to protect, so the
  // opponent's design name is public from the start (its shape is rendered fully
  // god-view anyway). In vs-bot it stays fogged (null) until reveal so the human
  // can't read seat B's shape early. `botDesignRef` tracks the live duel; reading
  // it in auto is safe and lets the UI label both bots immediately.
  const botDesignNamePublic = auto ? botDesignRef.current.name : botDesignName;

  return {
    state,
    yourTarget,
    yourDesignName,
    yourColor: SEAT_A_COLOR,
    guideColors: yourTarget,
    guideVisible: phase === "memorize",
    memorizeRemaining,
    revealed,
    blocked,
    visibleMask,
    place,
    cooldownRemaining,
    phase,
    auto,
    setAuto,
    difficulty,
    stake,
    speed,
    setSpeed,
    reveal,
    scores,
    cellsLost,
    botTarget,
    botDesignName: botDesignNamePublic,
    botColor: SEAT_B_COLOR,
    winner,
    reset,
    events,
  };
}

/** Probe color: irrelevant to scoring (a probe lands off the painter's own
 *  target, so it's never a build), painted in a neutral mid-palette gray so a
 *  hit reads as "a probe mark", never a seat's win color. Exported so the UI can
 *  count a seat's ATTACK placements (probe-colored) in the god-view feed. */
export const PROBE_COLOR = 3;

/**
 * The color a seat paints for a move at `idx` against its OWN target stencil:
 *   - BUILD (cell in your shape) -> your fixed `seatColor`.
 *   - ATTACK (cell off your shape, i.e. a hit OR a miss) -> the neutral
 *     `PROBE_COLOR`, so your probes look identical to the bot's and stay visible.
 * Scoring is unaffected — an attack lands off your target, so it was never a
 * scoring cell regardless of color. Pure; the single source of truth shared by
 * the human `place` and a test.
 */
export function placementColor(
  idx: number,
  ownTarget: Uint8Array,
  seatColor: number,
): number {
  return ownTarget[idx] === 0 ? PROBE_COLOR : seatColor;
}

/**
 * Choose a seat's next move under fog-of-war rules — WITHOUT ever reading the
 * foe's secret shape. With probability `attackRate` the bot ATTACKS, picking its
 * probe by BLIND battleship search/hunt over PUBLIC intel only:
 *
 *   - HUNT: if any cell is `blocked` (a confirmed hit — only an attack landing in
 *     a foe-shape cell sets `blocked`) and has an un-probed orthogonal neighbor,
 *     probe that neighbor to walk along the ship. This is how a hit gets parlayed
 *     into more hits, fairly: the public `blocked` mask is the bot's memory.
 *   - SEARCH (no hunt lead): probe a random un-probed cell biased toward the half
 *     of the board OPPOSITE the bot's OWN shape centroid (shapes spread to
 *     opposite regions, so the foe is likely far away). Hard bots add a
 *     checkerboard parity bias so a probe can't slip through a ship's gaps.
 *
 * Otherwise it BUILDS its OWN shape (legitimately reading `ownTarget`): nearest
 * unfinished, unblocked own target cell, center-out. Returns null only when it
 * has nothing left to do (so the duel can settle — building always terminates
 * regardless of probing, so there's no deadlock).
 *
 * `revealed`/`blocked` are the PUBLIC fog masks (the only foe intel the bot sees).
 * `seatColor` is the painter's fixed monochrome color. Pure given its args
 * (modulo the `rng` stream) — exported for the duel hook's ticks only.
 */
export function planBotMove(
  state: PixelPaintState,
  ownTarget: Uint8Array,
  revealed: Uint8Array,
  blocked: Uint8Array,
  rng: () => number,
  profile: BotProfile,
  seatColor: number,
): PixelPaintMove | null {
  if (state.winner !== 0) return null;
  if (profile.skipRate > 0 && rng() < profile.skipRate) return null; // dawdle
  const W = state.width;
  const limit = state.overwriteLimit;
  const open = (i: number) => state.paints[i] < limit;

  // ATTACK: blind search/hunt over public masks only. Never touches the foe shape.
  if (rng() < profile.attackRate) {
    const probe = pickBlindProbe(state, ownTarget, revealed, blocked, rng, profile);
    if (probe) return probe;
    // nothing useful to probe yet — fall through to building.
  }

  // BUILD: nearest own open target cell that isn't already seat-colored or
  // enemy-blocked. Center-out so shapes fill coherently.
  const cx = (W - 1) / 2;
  const cy = (state.height - 1) / 2;
  let best = -1;
  let bestKey = Infinity;
  for (let i = 0; i < ownTarget.length; i++) {
    if (ownTarget[i] === 0 || blocked[i] || !open(i)) continue;
    if (state.canvas[i] === seatColor) continue; // already built here
    const x = i % W;
    const y = (i / W) | 0;
    const key =
      ((x - cx) * (x - cx) + (y - cy) * (y - cy)) * ownTarget.length + i;
    if (key < bestKey) {
      bestKey = key;
      best = i;
    }
  }
  if (best >= 0) {
    return { x: best % W, y: (best / W) | 0, color: seatColor };
  }
  return null; // nothing left to build — let the duel settle
}

/** Centroid (mean x,y) of the bot's OWN target cells — used only to bias SEARCH
 *  away from itself toward where the foe likely sits. Reads ownTarget (legit). */
function ownCentroid(ownTarget: Uint8Array, W: number): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < ownTarget.length; i++) {
    if (ownTarget[i] === 0) continue;
    sx += i % W;
    sy += (i / W) | 0;
    n++;
  }
  if (n === 0) return { x: (W - 1) / 2, y: 0 };
  return { x: sx / n, y: sy / n };
}

/** A cell is a legal, INFORMATIVE probe target iff it's paintable, not already
 *  revealed (no fresh intel otherwise), and not one of the bot's OWN shape cells
 *  (no point attacking yourself). Uses only public state + ownTarget. */
function probeable(
  i: number,
  state: PixelPaintState,
  ownTarget: Uint8Array,
  revealed: Uint8Array,
): boolean {
  return (
    state.paints[i] < state.overwriteLimit &&
    revealed[i] === 0 &&
    ownTarget[i] === 0
  );
}

/**
 * Pick an ATTACK probe using ONLY public intel (`revealed`/`blocked`) plus the
 * bot's own shape (to avoid self-fire and to bias search). The foe's secret shape
 * is NEVER consulted, so early probes land at roughly the random base rate — the
 * bot earns hits by hunting around confirmed blocks, exactly like battleship.
 */
function pickBlindProbe(
  state: PixelPaintState,
  ownTarget: Uint8Array,
  revealed: Uint8Array,
  blocked: Uint8Array,
  rng: () => number,
  profile: BotProfile,
): PixelPaintMove | null {
  const W = state.width;

  // HUNT: walk outward from any confirmed hit (`blocked`). A sloppy bot sometimes
  // skips hunting; a disciplined bot always concentrates fire on a live lead.
  if (rng() >= profile.huntSloppiness) {
    const hunt = pickHuntNeighbor(state, ownTarget, revealed, blocked, rng);
    if (hunt) return { x: hunt % W, y: (hunt / W) | 0, color: PROBE_COLOR };
  }

  // SEARCH: random un-probed cell, biased toward the half OPPOSITE our own shape.
  const c = ownCentroid(ownTarget, W);
  const farFromHalf = c.x <= (W - 1) / 2; // our shape is left -> hunt the right
  const useParity = profile.paritySearch;
  // Parity phase chosen so the checkerboard covers the searched half densely.
  const parity = 0;

  const primary: number[] = [];
  const fallback: number[] = []; // any probeable cell, ignoring the bias filters
  for (let i = 0; i < state.paints.length; i++) {
    if (!probeable(i, state, ownTarget, revealed)) continue;
    fallback.push(i);
    const x = i % W;
    const y = (i / W) | 0;
    const onFarHalf = farFromHalf ? x >= W / 2 : x < W / 2;
    if (!onFarHalf) continue;
    if (useParity && ((x + y) & 1) !== parity) continue;
    primary.push(i);
  }
  const pool = primary.length > 0 ? primary : fallback;
  if (pool.length === 0) return null; // nothing left worth probing
  const pick = pool[Math.floor(rng() * pool.length)];
  return { x: pick % W, y: (pick / W) | 0, color: PROBE_COLOR };
}

/**
 * HUNT step: scan for a confirmed hit (`blocked[i] === 1`) that has an un-probed,
 * probeable orthogonal neighbor, and return that neighbor to extend the strike.
 * This is the battleship "after a hit, try adjacent cells" rule, driven entirely
 * by the PUBLIC `blocked` mask — the bot's fair memory of where it has landed.
 * Returns the chosen neighbor index, or -1-as-null when no live lead exists.
 */
function pickHuntNeighbor(
  state: PixelPaintState,
  ownTarget: Uint8Array,
  revealed: Uint8Array,
  blocked: Uint8Array,
  rng: () => number,
): number | null {
  const W = state.width;
  const H = state.height;
  const leads: number[] = [];
  for (let i = 0; i < blocked.length; i++) {
    if (blocked[i] !== 1) continue;
    if (ownTarget[i] !== 0) continue; // our own cell got blocked — not a foe lead
    const x = i % W;
    const y = (i / W) | 0;
    const ns = [
      y > 0 ? i - W : -1,
      y < H - 1 ? i + W : -1,
      x > 0 ? i - 1 : -1,
      x < W - 1 ? i + 1 : -1,
    ];
    for (const n of ns) {
      if (n >= 0 && probeable(n, state, ownTarget, revealed)) {
        leads.push(n);
      }
    }
  }
  if (leads.length === 0) return null;
  return leads[Math.floor(rng() * leads.length)];
}
