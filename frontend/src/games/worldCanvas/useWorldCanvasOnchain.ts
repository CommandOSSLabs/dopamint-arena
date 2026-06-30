/**
 * useWorldCanvasOnchain — runs "The World is Your Canvas" as a COLLABORATIVE,
 * APPEND-ONLY paint stream over ONE strictly-2-party OffchainTunnel, so every
 * painted cell becomes a real co-signed move (TPS on the dashboard under
 * "world-canvas"). It mirrors the proven arena solo on-ramp the other games use
 * (chicken-cross / bomb-it / battleship vs-bot): ONE `create_and_fund` funds BOTH
 * seats from a SINGLE signature, the off-chain {@link core.OffchainTunnel.selfPlay}
 * holds both seats' keypairs, and an AUTO toggle lets the human take the wheel —
 * transposed from a finite duel to an endless, winner-less wall: no turns, no
 * winner, no stake shift (free/draw — balances lock at open and return in full at
 * every cooperative close).
 *
 * EXACTLY ONE TUNNEL, TWO SEATS — the corrected arena shape (no "Wall Bot", no
 * "+pair" swarm, no many parallel tunnels). The window opens a single 2-party
 * tunnel whose distinct MTPS-funded seats A and B BOTH author on it:
 *   - SOLO / watch (Auto ON, the default): seat A and seat B are each driven by a
 *     bot — bot-vs-bot collaboration on one tunnel (two distinct funded painters).
 *   - Take the wheel (Auto OFF): the HUMAN authors seat A ({@link submitHumanPaint}),
 *     pausing the seat-A bot, while the seat-B bot plays on — you-vs-bot on the SAME
 *     tunnel, no reopen. Flipping Auto back resumes the seat-A bot mid-stream.
 * (PvP — two distinct humans over the relay — is a stub for now; see {@link findMatch}.)
 *
 * The paint → co-signed-move path (one paint = one co-signed move = ~1 TPS):
 *   submitHumanPaint (seat A, while you hold the wheel) / the rAF paintFrame (each bot's seat)
 *     → submitPaint(move, seat, painter)        // routes to the one tunnel
 *     → run.tunnel.step(move, seat, ...)         // selfPlay co-signs BOTH seats
 *     → r.verified                                // both signatures check (TPS gate)
 *     → run.moveCount++ + run.actions++ + paint the cell + book the painter
 *     → flushHeartbeat(run, ≤1/s)                // coarse throughput report (the TPS dial)
 * The WorldCanvasProtocol folds each paint into a 32-byte rolling digest, so the
 * co-signed state hash strictly changes on every paint — no no-op is possible.
 * OVERPAINT is legal: re-painting a cell is a full co-signed move whose owner/color
 * updates to the latest painter.
 *
 * Bounded GAMES: the wall runs as discrete games of MOVES_PER_GAME co-signed paints.
 * At each boundary the tunnel cooperatively closes (on-chain: anchoring its transcript
 * root via the SAME backend `/settle` path every finite game uses — stakes return, NO
 * winner; demo: no chain), a fresh tunnel reopens, the canvas is WIPED, the bots re-seed
 * from the origin, and a game counter bumps — continuous "new game, clear canvas" rounds.
 *
 * Opening tries the gas SPONSOR first, so the seats (fresh bot keys with ZERO SUI)
 * open for free, faucet-minting their MTPS stake:
 *   - SPONSORED → on-chain (default): the settler wraps `create_and_fund` in its own
 *     SIP-58 gas; the painters only co-sign.
 *   - SENDER-PAYS fallback: sponsor unreachable AND the opener holds gas.
 *   - DEMO (last resort): if both on-chain paths fail, a synthetic (valid 32-byte)
 *     tunnelId with the SAME local co-signing + heartbeat TPS (no chain, can't crash).
 *
 * Painting never blocks on the chain: paints co-sign the instant the tunnel object
 * exists, and pre-open paints buffer then replay in order.
 *
 * Bots don't paint noise: each seat bot is handed an INTELLIGENCE (mode) and SPEED,
 * plus a fresh non-overlapping world region it walks cell-by-cell — each cell one
 * co-signed move. The only "score" is a per-painter tally of who painted the most
 * cells — DISPLAY ONLY, no money, no winner.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, proof } from "sui-tunnel-ts";
import {
  type WorldCanvasState,
  type WorldCanvasMove,
} from "sui-tunnel-ts/protocol/worldCanvas";
import { createWorldCanvasKit } from "@/agent/games/worldCanvas/kit";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "@/backend/controlPlane";
import { useTelemetry } from "@/telemetry/TelemetryProvider";
import { buildSettleWithRootTx } from "@/games/ticTacToe/app/lib/tunnel";
import { openAndFundSelfPlay, readCreatedAt } from "@/onchain/tunnelTx";
import { settleViaBackend } from "@/backend/settle";
import {
  isMtpsConfigured,
  isMtpsAddressBalance,
  ensureMtpsAddressBalance,
  ensureMtpsStakeCoin,
  MTPS_COIN_TYPE,
} from "@/onchain/mtps";
import {
  loadOrCreateBots,
  getSuiClient,
  type BotIdentity,
} from "@/games/ticTacToe/app/lib/bots";
import {
  makeKeypairSponsoredSignExec,
  withSponsorFallback,
} from "@/onchain/sponsor";
import {
  AGENT_MODES,
  DEFAULT_AGENT_MODE,
  MAX_FOOTPRINT_W,
  MAX_FOOTPRINT_H,
  type AgentModeId,
  type AgentDensity,
  type DesignCell,
} from "./designs";
import { rasterizeTemplate, fitScale, TEMPLATES_BY_ID } from "./templates";
import { mulberry32 } from "./geometry";
import { WC, ZOOM } from "./ui/tokens";

export type { AgentModeId } from "./designs";

/** Cells per chunk edge — MUST match the WorldCanvasProtocol so a paint legal in
 *  the UI is legal in the co-signing tunnel. */
const CHUNK_SIZE = 256;
/** Palette size; a paint's color is in [0, NUM_COLORS). */
const NUM_COLORS = 16;
/** SUI-fallback per-seat stake (MIST) when MTPS env is unset. Collaborative free
 *  mode never shifts balances, so any close is a draw (each seat keeps its stake). */
const STAKE = 1n;
/** MTPS per-seat stake (1 token; 0 decimals, ADR-0023) — the default on-chain path (ADR-0010):
 *  faucet-minted, so painters need ZERO SUI; only gas is sponsored. Mirrors the other games. */
const MTPS_STAKE_PER_SEAT = 1n; // 1 MTPS per seat (MTPS is 0-decimal; ADR-0023)
/** Dashboard game key (groups TPS/tunnels under "world-canvas"). */
const GAME = "world-canvas";
/** Soft cap on retained painted cells; oldest are evicted so an endless wall keeps
 *  constant memory (the render layer does its own viewport culling). */
const MAX_RETAINED_CELLS = 200_000;
/** Recent-activity ring length (newest paints kept for the activity feed). */
const MAX_ACTIVITY = 60;
/** Debounce (ms) after the human's LAST paint before flushing ONE MY-ACTIVITY row that
 *  summarizes the stroke. ~400ms is a natural stroke/gap boundary; cancel-and-reschedule
 *  on each new human paint so a continuous stroke collapses into a single row. Human-only
 *  (bots paint far faster and would flood the feed — their painting stays as TPS). */
const HUMAN_STROKE_DEBOUNCE_MS = 400;
/** Throttle (ms) between a single bot's MY-ACTIVITY "painted N cell(s)" rows. The seat
 *  bots paint far faster than a human stroke, so a LEADING-edge throttle (one timer per
 *  painter address, fires ~1.5s after the first un-flushed paint, then summarizes that
 *  whole window into one row) keeps Auto-mode activity legible without flooding the feed.
 *  Bot-only — the human seat uses HUMAN_STROKE_DEBOUNCE_MS (a debounce) instead. */
const BOT_ACTIVITY_THROTTLE_MS = 1500;
/** The single config constant: co-signed paints in ONE bounded game. At the cap the
 *  tunnel cooperatively closes (on-chain: anchoring its transcript root, like every
 *  finite game's settle; demo: no chain), the canvas wipes, the bots re-seed, a fresh
 *  tunnel reopens, and the game counter bumps — so the wall runs as discrete games
 *  ("New game, clear canvas") rather than one endless stream. BOTH the on-chain and the
 *  demo tunnel bound at this cap; only the on-chain path also settles + anchors a root. */
/** Default + hard MAX co-signed-move cap per game (the lobby slider tops out here). */
export const MOVES_PER_GAME = 50_000;
/** Floor for the configurable cap — below this a game would settle near-instantly and
 *  re-open in a storm, so the lobby slider bottoms out here (not 0). */
export const MIN_MOVES_PER_GAME = 1_000;
/** Clamp a requested per-game cap into the allowed range. */
export function clampMovesPerGame(n: number): number {
  if (!Number.isFinite(n)) return MOVES_PER_GAME;
  return Math.max(MIN_MOVES_PER_GAME, Math.min(MOVES_PER_GAME, Math.round(n)));
}
/** Gap (cells) between adjacent agent regions so their art never touches. */
const REGION_GAP = 14;
/** Auto-follow cadence (ms): while Auto is on, how often the spectator camera re-centers on
 *  seat A's bot. Lazy enough to read as a smooth trailing follow (the canvas eases each step),
 *  not a per-frame jerk. */
const AUTO_FOLLOW_MS = 1_000;
/** World slot size (cells) — sized to the LARGEST mode footprint so any mode fits a
 *  slot on the shared spiral lattice and regions never overlap regardless of mode. */
const SLOT_W = MAX_FOOTPRINT_W + REGION_GAP;
const SLOT_H = MAX_FOOTPRINT_H + REGION_GAP;
/** Seed base for per-region PRNGs (mixed with the region index for varied art). */
const REGION_SEED = 0x9e3779b9;
/** Endless modes (flow / scribble) never finish on their own; relocate once a region
 *  has co-signed this multiple of its footprint area so the bot keeps spreading. Sized
 *  generously so a fast bot fills each region densely and relocates rarely, rather than
 *  hopping slots every second (the per-frame paint loop also continues into the fresh
 *  region in the SAME frame, so a relocate never wastes a frame either). */
const REGION_FILL_FACTOR = 3;
/** Fit box (cells) an Artist agent rasterizes a chosen template into — kept under the
 *  max mode footprint so a template region never overflows its spiral slot. */
const AGENT_TEMPLATE_W = MAX_FOOTPRINT_W - 8;
const AGENT_TEMPLATE_H = MAX_FOOTPRINT_H - 8;

/** Freestyle seat line colors — palette indices, matching the PvP bot (seat A Sui blue,
 *  seat B light purple) so each seat draws ONE distinct continuous line. */
const FREESTYLE_COLOR_A = 13;
const FREESTYLE_COLOR_B = 15;
/** Per-step chance a freestyle walk turns (mirrors worldCanvasPvp.randomMove's 0.35). */
const FREESTYLE_TURN_CHANCE = 0.35;
/** Nominal marker anchor height for a freestyle bot (it draws a line, not a footprint box). */
const FREESTYLE_MARKER_H = 4;
/** Frames between freestyle marker re-syncs, so the on-canvas marker follows the wandering
 *  head a few times/second without per-frame React churn. */
const MARKER_SYNC_EVERY_FRAMES = 24;
/** Placeholder RNG for a template placement (its walk fields are unused). */
const NOOP_RNG = () => 0;

export type Seat = "A" | "B";

/** Display tints: the human seat (A, while you hold the wheel) is Sui blue; the
 *  seat-A bot is mint; the seat-B bot is the party-B purple. Three distinct colors so
 *  the leaderboard + on-canvas markers stay readable. */
const TINT_HUMAN = WC.seatA;
const TINT_BOT_A = "#5fe3a1";
const TINT_BOT_B = WC.seatB;

/** Agent acceleration MULTIPLIER — the headline "tăng tốc" dial. Each tier is an
 *  explicit ×N on the agent's co-signed cells/sec (x1 baseline → x8 burst). */
export type AgentSpeed = "x1" | "x2" | "x4" | "x8";

/** Cells one bot co-signs PER ANIMATION FRAME at each speed tier. The bots paint on a
 *  single ~60fps requestAnimationFrame cadence (NOT a setTimeout interval), so the
 *  display fixes the tick RATE and the Speed multiplier scales the per-frame BATCH —
 *  still an honest ×N on cells/sec (x8 lays 8× the cells/frame of x1). At ~60fps the
 *  default x8 lands a bot near ~480 cells/sec (8 × 60) — fast, continuous scribbling —
 *  while each frame's synchronous co-signing stays tiny (≈0.15ms/cell, measured).
 *  This replaces the old per-bot setTimeout chains, which the canvas's own rAF render
 *  loop starved to a crawl (~30 TPS total) regardless of the 15ms interval. */
const SPEED_FRAME_CELLS: Record<AgentSpeed, number> = {
  x1: 1,
  x2: 2,
  x4: 4,
  x8: 8,
};
/** The acceleration tiers, in ramp order — the source for the Speed pills/menu. */
export const AGENT_SPEEDS: readonly AgentSpeed[] = ["x1", "x2", "x4", "x8"];

/** Per-frame multiplier by a mode's density class — the dense↔sparse TPS spread, kept
 *  gentle so even a sparse mode stays visibly fast. Folds into the per-frame batch. */
const DENSITY_FRAME_FACTOR: Record<AgentDensity, number> = {
  sparse: 0.5,
  medium: 1,
  dense: 1.5,
};
/** Hard ceiling on cells one bot co-signs in a SINGLE FRAME, so even x8×dense×density3
 *  stays bounded (≈24 × 0.15ms ≈ 3.6ms of crypto/frame/bot — well under one 16ms frame,
 *  so the paint loop never blocks the render). Each cell is one verified co-signed move. */
const FRAME_CELL_CAP = 24;
/** User Density lever range (mirrors the human brush-size selector): a TPS multiplier. */
const DENSITY_LEVELS = [1, 2, 3] as const;
const DEFAULT_DENSITY = 1;
/** Cap on relocations a bot may do in one frame, so a pathological near-empty stream
 *  can't spin the frame loop while it keeps finding fresh regions (see paintFrame). */
const MAX_RELOCATES_PER_FRAME = 4;

/**
 * Cells one bot co-signs THIS FRAME: `speed × density(mode) × userDensity`, clamped to
 * `[1, FRAME_CELL_CAP]`. Folding Speed in here (rather than scaling a tick interval) is
 * what puts the bot loop on the render cadence — a fixed ~60fps frame rate with a
 * per-frame batch — so painting is smooth (frame-aligned) AND fast at the same time.
 */
function agentFrameBatch(
  speed: AgentSpeed,
  modeId: AgentModeId,
  userDensity: number,
): number {
  const base =
    SPEED_FRAME_CELLS[speed] *
    DENSITY_FRAME_FACTOR[AGENT_MODES[modeId].density] *
    userDensity;
  return Math.max(1, Math.min(FRAME_CELL_CAP, Math.round(base)));
}

export type WorldCanvasPhase = "idle" | "opening" | "open" | "demo" | "error";

/** A single painted cell retained for rendering (the protocol keeps only a digest). */
export interface PaintedCell {
  cx: bigint;
  cy: bigint;
  x: number;
  y: number;
  color: number;
  /** Which seat laid the most recent paint here. */
  by: Seat;
  /** Monotonic co-signed sequence number of that paint. */
  seq: number;
  /** Display address of the CURRENT painter of this cell (updates on every overpaint). */
  painter: string;
}

/** Running tally for one painter (the human or one seat bot), keyed by display address. */
export interface PainterInfo {
  address: string;
  /** "You" for the human seat, "Bot A" / "Bot B" for the seat bots. */
  label: string;
  isAgent: boolean;
  /** Accent color for leaderboard rows / agent markers. */
  tint: string;
  /** Total cells this painter has co-signed (increments on every paint, incl. overpaint). */
  cells: number;
  /** Co-signed seq of this painter's latest paint (leaderboard tie-break). */
  lastSeq: number;
}

/** One entry in the recent-activity ring. */
export interface ActivityEntry {
  seq: number;
  painter: string;
  label: string;
  cx: bigint;
  cy: bigint;
  x: number;
  y: number;
  color: number;
  /** Wall-clock time of the paint (Date.now()). */
  t: number;
}

/** A live seat bot's location, surfaced so the canvas can mark + jump to it. */
export interface AgentMarker {
  id: string;
  /** "Bot A" / "Bot B". */
  label: string;
  painter: string;
  /** Name of the design currently being drawn (e.g. "Vietnam" / "Scatter"). */
  flagName: string;
  tint: string;
  /** Global-pixel center of the current design (camera jump + marker anchor). */
  gx: number;
  gy: number;
  /** Current design height in cells (lets the marker anchor just above it). */
  h: number;
}

/** A camera-jump request: center this global-pixel point; `seq` bumps per request. An
 *  optional `scale` overrides the camera zoom on arrival (px per cell); omit to keep the
 *  view's default focus zoom. */
export interface CanvasFocus {
  gx: number;
  gy: number;
  seq: number;
  scale?: number;
}

/** On-chain progress surfaced to the canvas HUD (driven by the single tunnel). */
export interface WorldCanvasOnchainStatus {
  phase: WorldCanvasPhase;
  /** The tunnel's id, or a synthetic demo id when running off-chain. */
  tunnelId: string | null;
  /** True once the tunnel opened on-chain (vs. the demo fallback). */
  onchain: boolean;
  /** Total co-signed paints on the tunnel this run (the TPS numerator). */
  movesCoSigned: number;
  /** `create_and_fund` digest of the tunnel (on-chain path only). */
  openDigest: string | null;
  error: string | null;
}

export interface UseWorldCanvasOnchain {
  status: WorldCanvasOnchainStatus;
  /** Live canvas: stable Map identity, mutated in place; re-read on `revision` bumps. */
  paints: ReadonlyMap<string, PaintedCell>;
  /** Bumps (throttled) whenever the canvas changes, so consumers redraw. */
  revision: number;
  /** Current game number — starts at 1, increments at each {@link movesPerGame} boundary
   *  (canvas wipe + fresh tunnel). Drives the "Game N" readout and the canvas reset. */
  game: number;
  /** Co-signed moves on the current tunnel since the last game boundary (0 → movesPerGame). */
  movesThisGame: number;
  /** Per-game co-signed-move cap (the bound at which a game ends and the canvas wipes). */
  movesPerGame: number;
  /** Auto mode: ON (default) = both seats bot-driven (bot vs bot). OFF = you author
   *  seat A ({@link submitHumanPaint}) while the seat-B bot plays on — same tunnel. */
  auto: boolean;
  /** Flip between watch (bots vs bots) and take-the-wheel (you vs the seat-B bot). The
   *  seat-A bot pauses/resumes in place; the tunnel is never reopened. */
  toggleAuto(): void;
  /** Set Auto deterministically (idempotent). The cabinet's take-over calls `setAuto(false)`
   *  to hand seat A to the human; same in-place seat-A pause/resume as {@link toggleAuto}. */
  setAuto(value: boolean): void;
  /** Cabinet hover-freeze: stop the bots co-signing paints in place (the rAF loop keeps
   *  running). Resume with {@link resumeAgents}; the tunnel and game state are untouched. */
  pauseAgents(): void;
  /** Resume bot painting after a {@link pauseAgents} freeze that didn't lead to a take-over. */
  resumeAgents(): void;
  /** Live seat-bot markers — both seats when Auto is on, seat B only when you hold the wheel. */
  agents: AgentMarker[];
  /** Latest camera-jump request; null until first view/jump. */
  focus: CanvasFocus | null;
  /** Per-painter tallies, keyed by display address (stable identity; re-read on `revision`). */
  painters: ReadonlyMap<string, PainterInfo>;
  /** Recent-activity ring, oldest→newest (stable identity; re-read on `revision`). */
  activity: ReadonlyArray<ActivityEntry>;
  /** The human seat's display address (so the UI can label the human's own cells "You"). */
  humanAddress: string;
  /** Current agent SPEED (applied to both seat bots). */
  agentSpeed: AgentSpeed;
  /** Set the agent paint speed; updates both running seat bots. */
  setAgentSpeed(speed: AgentSpeed): void;
  /** Current agent INTELLIGENCE (applied to both seat bots). */
  agentMode: AgentModeId;
  /** Set the agent drawing mode; updates both seat bots (next region). */
  setAgentMode(mode: AgentModeId): void;
  /** Current agent DENSITY lever (1/2/3) — a per-tick batch multiplier (TPS burst). */
  agentDensity: number;
  /** Set the agent density lever; applies live to both seat bots' next tick. */
  setAgentDensity(level: number): void;
  /** Template id an Artist agent stamps at each region, or null to lay the flag rotation. */
  agentTemplate: string | null;
  /** Pick the Artist agent's template (or null for flags); applies at the next region. */
  setAgentTemplate(id: string | null): void;
  /** Paint one cell as seat A — only while you hold the wheel (Auto OFF). One co-signed move. */
  submitHumanPaint(
    cx: bigint,
    cy: bigint,
    x: number,
    y: number,
    color: number,
  ): void;
  /** Cycle the camera to the next live seat bot (the "View" button). */
  viewNextAgent(): void;
  /** Re-center the camera on the live seat bot painting at `painter` (the 📍 button). */
  focusOnAgent(painter: string): void;
  /** PvP over the relay — Find Match between two distinct HUMANS. Stub for now: the
   *  relay matchmaking is not yet wired, so this surfaces a note and no-ops. */
  findMatch(): void;
}

/** Stable cell key for the live canvas map. */
export function cellKey(cx: bigint, cy: bigint, x: number, y: number): string {
  return `${cx}:${cy}:${x}:${y}`;
}

/** Deterministic non-negative 31-bit int from a string — a stable React key for a
 *  dashboard feed row (the TelemetryProvider reassigns its own globally-unique id on
 *  push, so this only needs to be collision-free per row, not globally). */
function feedRowId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return Math.abs(h | 0);
}

/** Compact tunnel id (head…tail of the 0x address) for the feed row's `bot` column. */
function shortTunnelId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/** Floor-divide that works for negative coordinates (chunk of a global pixel). */
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Map a global-pixel cell to a protocol move (chunk index + in-chunk offset). */
function moveAtGlobal(gx: number, gy: number, color: number): WorldCanvasMove {
  const cx = floorDiv(gx, CHUNK_SIZE);
  const cy = floorDiv(gy, CHUNK_SIZE);
  return {
    cx: BigInt(cx),
    cy: BigInt(cy),
    x: gx - cx * CHUNK_SIZE,
    y: gy - cy * CHUNK_SIZE,
    color,
  };
}

/**
 * The i-th lattice point of a square spiral around the origin (right, up, left,
 * down with growing leg lengths). Regions are laid on this spiral so they cluster
 * near the world origin (watchable) yet never overlap.
 */
function spiralSlot(target: number): { col: number; row: number } {
  if (target <= 0) return { col: 0, row: 0 };
  const dirs = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  let x = 0;
  let y = 0;
  let idx = 0;
  let step = 1;
  let dir = 0;
  for (;;) {
    for (let leg = 0; leg < 2; leg++) {
      const [ddx, ddy] = dirs[dir % 4];
      for (let s = 0; s < step; s++) {
        x += ddx;
        y += ddy;
        idx++;
        if (idx === target) return { col: x, row: y };
      }
      dir++;
    }
    step++;
  }
}

/** Mint a throwaway party identity for the self-play tunnel — a new ed25519 key that
 *  needs ZERO SUI (the gas sponsor pays; the keypair only co-signs paints). */
function makeIdentity(): BotIdentity {
  const seed = core.generateKeyPair().secretKey;
  const coreKey = core.keyPairFromSecret(seed);
  const keypair = Ed25519Keypair.fromSecretKey(seed);
  return {
    coreKey,
    keypair,
    address: keypair.getPublicKey().toSuiAddress(),
    publicKey: coreKey.publicKey,
  };
}

/** The single shared 2-party tunnel + its heartbeat/session bookkeeping. Both seats
 *  are DISTINCT funded painters that BOTH author on it. A checkpoint close-and-reopen
 *  swaps this object out (the agents re-read `runRef.current` each tick). */
interface CanvasRun {
  /** The two seats co-signing this tunnel (A funds/opens, both sign every paint). */
  identities: { a: BotIdentity; b: BotIdentity };
  tunnelId: string;
  onchain: boolean;
  createdAt: bigint;
  tunnel: core.OffchainTunnel<WorldCanvasState, WorldCanvasMove> | null;
  /** Paints accepted before the tunnel object exists; replayed in order on ready. */
  buffer: { mv: WorldCanvasMove; by: Seat; painter: string }[];
  ready: boolean;
  closed: boolean;
  session: RegisterSessionResult | null;
  /** Co-signed paints on this tunnel (nonce + the heartbeat numerator). */
  moveCount: number;
  /** Actions since the last heartbeat flush (reset to 0 on send). */
  actions: number;
  lastHeartbeat: number;
  /** Accumulates every co-signed update; its Merkle root is anchored at each checkpoint. */
  transcript: proof.Transcript | null;
  /** moveCount at the last on-chain checkpoint (close-and-reopen anchors the root). */
  lastCheckpoint: number;
  /** True while a checkpoint close is in flight, so paints don't trigger a second. */
  checkpointing: boolean;
  /** Staked token type (MTPS, or undefined = SUI); the checkpoint close needs it. */
  coinType?: string;
}

/** A fresh region/walk handed to a seat bot (initial spawn, relocate, or mode switch). */
interface AgentPlacement {
  /** "template" = an Artist picture region; "freestyle" = a wandering momentum walk. */
  kind: "template" | "freestyle";
  /** Template path only: the region's lazy cell stream (null for a freestyle walk). */
  iter: Iterator<DesignCell> | null;
  regionName: string;
  footprintH: number;
  maxCells: number;
  originGx: number;
  originGy: number;
  centerGx: number;
  centerGy: number;
  walkGx: number;
  walkGy: number;
  walkDx: number;
  walkDy: number;
  rng: () => number;
  color: number;
}

/** A live seat bot. Each bot authors as exactly one seat (A or B) of the single shared
 *  tunnel and either draws an Artist picture region OR walks one continuous freestyle line. */
interface AgentState {
  id: string;
  /** The seat this bot authors as (its distinct funded identity on the tunnel). */
  seat: Seat;
  /** This bot's display painter address (leaderboard + marker identity). */
  painter: string;
  label: string;
  tint: string;
  /** Captured at spawn, live-updatable: paint interval tier + drawing intelligence. */
  speed: AgentSpeed;
  mode: AgentModeId;
  /** Drawing strategy for the current run: an Artist picture region vs a freestyle walk. */
  kind: "template" | "freestyle";
  /** Template path only: the region's lazy cell stream (null while freestyle-walking). */
  iter: Iterator<DesignCell> | null;
  /** Label shown on the marker for the current region / walk (the mode or picture name). */
  regionName: string;
  /** Marker anchor height in cells (region height, or a nominal value for a walk). */
  footprintH: number;
  /** Top-left global-pixel origin: a region's corner, or a freestyle walk's spawn. */
  originGx: number;
  originGy: number;
  /** Global-pixel marker anchor — a region center, or the live freestyle walk head. */
  centerGx: number;
  centerGy: number;
  /** Freestyle momentum walk: global-pixel cursor + heading + per-bot RNG + fixed line
   *  color — a bounded random walk mirroring worldCanvasPvp.randomMove. Unused for templates. */
  walkGx: number;
  walkGy: number;
  walkDx: number;
  walkDy: number;
  rng: () => number;
  color: number;
  /** Cells co-signed in the current region so far (drives the template relocate). */
  painted: number;
  /** Soft cap: relocate a template once `painted` reaches this (Infinity for a walk). */
  maxCells: number;
}

/** Clamp a per-step delta so the freestyle walk stays a tight, legible line (mirrors
 *  worldCanvasPvp's clampStep — no big jumps). */
function clampStep(n: number): number {
  return Math.max(-2, Math.min(2, n));
}

/** Advance a freestyle bot's momentum random walk by ONE cell and return it (origin-relative
 *  so the shared `moveAtGlobal(origin + cell)` paint path is unchanged). Mirrors the inner
 *  loop of worldCanvasPvp.randomMove: occasionally turn, clamp the heading, never stall — a
 *  coherent wandering line continued from the bot's last painted cell. */
function stepFreestyle(st: AgentState): DesignCell {
  const rng = st.rng;
  if (rng() < FREESTYLE_TURN_CHANCE) {
    st.walkDx += Math.floor(rng() * 3) - 1;
    st.walkDy += Math.floor(rng() * 3) - 1;
  }
  st.walkDx = clampStep(st.walkDx);
  st.walkDy = clampStep(st.walkDy);
  if (st.walkDx === 0 && st.walkDy === 0) st.walkDx = 1;
  st.walkGx += st.walkDx;
  st.walkGy += st.walkDy;
  return {
    dx: st.walkGx - st.originGx,
    dy: st.walkGy - st.originGy,
    color: st.color,
  };
}

/** Copy a fresh placement onto a live bot (initial spawn, relocate, or mode-kind switch). */
function applyPlacement(st: AgentState, p: AgentPlacement): void {
  st.kind = p.kind;
  st.iter = p.iter;
  st.regionName = p.regionName;
  st.footprintH = p.footprintH;
  st.maxCells = p.maxCells;
  st.originGx = p.originGx;
  st.originGy = p.originGy;
  st.centerGx = p.centerGx;
  st.centerGy = p.centerGy;
  st.walkGx = p.walkGx;
  st.walkGy = p.walkGy;
  st.walkDx = p.walkDx;
  st.walkDy = p.walkDy;
  st.rng = p.rng;
  st.color = p.color;
  st.painted = 0;
}

const EMPTY_STATUS: WorldCanvasOnchainStatus = {
  phase: "idle",
  tunnelId: null,
  onchain: false,
  movesCoSigned: 0,
  openDigest: null,
  error: null,
};

export function useWorldCanvasOnchain(
  opts: { botColor?: number; movesPerGame?: number } = {},
): UseWorldCanvasOnchain {
  // A stable "You" display identity (never co-signs — the funded seat-A keypair does
  // the signing; this address only TAGS the human's own cells for the "You" label).
  const { report } = useTelemetry();
  const bots = useMemo(() => loadOrCreateBots(), []);
  const client = useMemo(() => getSuiClient(), []);
  const humanAddress = bots.x.address;
  // The toolbar's current paint color — the bots paint in YOUR chosen color too (you set
  // the palette, they follow). A ref so the rAF paintFrame reads it without re-subscribing.
  const botColorRef = useRef(opts.botColor ?? 13);
  botColorRef.current = opts.botColor ?? 13;
  // Per-game co-signed-move cap (the canvas wipes + the tunnel settles at this many paints).
  // User-configurable in the lobby; clamped to [MIN_MOVES_PER_GAME, MOVES_PER_GAME], default
  // MOVES_PER_GAME. A ref so the live cap-check reads the latest without re-subscribing.
  const movesPerGame = clampMovesPerGame(opts.movesPerGame ?? MOVES_PER_GAME);
  const movesPerGameRef = useRef(movesPerGame);
  movesPerGameRef.current = movesPerGame;
  // One protocol instance shared by the tunnel (and its reopens), sourced from the CANONICAL
  // kit (`createWorldCanvasKit` in src/agent) — the single source of truth the agent engine
  // uses too — instead of constructing a protocol here. The kit's defaults (256-cell chunks,
  // 16 colors) match this wall; its per-match cap is irrelevant here (the wall bounds itself
  // via `movesPerGame`, and nothing in the solo path reads `isTerminal`).
  const proto = useMemo(() => createWorldCanvasKit(STAKE).protocol, []);

  const [status, setStatus] = useState<WorldCanvasOnchainStatus>(EMPTY_STATUS);
  const [revision, setRevision] = useState(0);
  const [auto, setAutoState] = useState(true);
  const [agents, setAgents] = useState<AgentMarker[]>([]);
  const [focus, setFocus] = useState<CanvasFocus | null>(null);
  const [agentSpeed, setAgentSpeedState] = useState<AgentSpeed>("x8");
  const [agentMode, setAgentModeState] =
    useState<AgentModeId>(DEFAULT_AGENT_MODE);
  const [agentDensity, setAgentDensityState] =
    useState<number>(DEFAULT_DENSITY);
  const [agentTemplate, setAgentTemplateState] = useState<string | null>(null);
  // The current game number — bumps at each MOVES_PER_GAME boundary (see resetGameState).
  const [game, setGame] = useState(1);

  // The single tunnel (swapped out on each checkpoint reopen) and the two seats.
  const runRef = useRef<CanvasRun | null>(null);
  const identitiesRef = useRef<{ a: BotIdentity; b: BotIdentity } | null>(null);
  // Co-signed paints on the tunnel (the dashboard numerator + the window TPS dial).
  const totalMovesRef = useRef(0);
  // Co-signed paints since the last game boundary (0 → MOVES_PER_GAME); the "Game N · M /
  // cap" readout numerator. Reset in resetGameState; totalMovesRef stays cumulative (TPS).
  const movesThisGameRef = useRef(0);
  // Live canvas data: stable identity, mutated in place; React re-reads on `revision`.
  const paintsRef = useRef<Map<string, PaintedCell>>(new Map());
  // Per-painter tallies + recent-activity ring: same "mutate + bump revision" pattern.
  const paintersRef = useRef<Map<string, PainterInfo>>(new Map());
  const activityRef = useRef<ActivityEntry[]>([]);
  // Human-stroke MY-ACTIVITY summary: cells co-signed since the last flush, the latest
  // cell painted (stroke anchor), the cancel-and-reschedule debounce timer, and a
  // monotonic counter that keys each flushed row uniquely. See submitHumanPaint.
  const humanStrokeCountRef = useRef(0);
  const humanStrokeLastCellRef = useRef<{
    cx: bigint;
    cy: bigint;
    x: number;
    y: number;
  } | null>(null);
  const humanStrokeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const humanStrokeFlushIdRef = useRef(0);
  // Per-bot MY-ACTIVITY summary (Auto mode): cells co-signed by each seat bot since its
  // last flush (keyed by painter address), one leading-edge throttle timer per painter
  // address, and a monotonic counter that keys each flushed row uniquely. Bot-only — the
  // human seat uses the humanStroke* refs above (a debounce, not this throttle).
  const botPaintCountsRef = useRef<Map<string, number>>(new Map());
  const botActivityTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const botActivityFlushIdRef = useRef(0);
  // The two live seat bots + the placement counter.
  const agentStatesRef = useRef<Map<string, AgentState>>(new Map());
  const regionIndexRef = useRef(0);
  const focusSeqRef = useRef(0);
  // Round-robin cursor for the "View" cycle button.
  const viewCursorRef = useRef(0);
  const redrawTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The single requestAnimationFrame loop that drives BOTH seat bots' painting, so their
  // cells land on the render cadence (smooth, frame-aligned) instead of two competing
  // setTimeout chains that the busy canvas rAF loop starves to a crawl.
  const agentRafRef = useRef<number | null>(null);
  // Cabinet hover-freeze flag the rAF loop reads each frame: while paused it keeps scheduling
  // frames but submits no co-signed paints (resumable mid-stream; never closes the tunnel).
  const pausedRef = useRef(false);
  // Frame counter that paces freestyle marker re-syncs (head-follow) off the per-frame path.
  const agentMarkerTickRef = useRef(0);
  // Auto mirrored into a ref so the paint loop + paint sink read it without re-subscribing.
  const autoRef = useRef(true);
  // Current speed/mode for the seat bots, mirrored into refs so the paint loop can read
  // them without re-subscribing.
  const agentSpeedRef = useRef<AgentSpeed>("x8");
  const agentModeRef = useRef<AgentModeId>(DEFAULT_AGENT_MODE);
  const agentDensityRef = useRef<number>(DEFAULT_DENSITY);
  const agentTemplateRef = useRef<string | null>(null);

  // Throttle paint-driven React updates to ~8 Hz. The canvas redraws every frame from
  // refs (stays smooth); only the React panels/HUD + the TPS numerator bump here.
  const REDRAW_THROTTLE_MS = 120;
  const scheduleRedraw = useCallback(() => {
    if (redrawTimerRef.current !== null) return;
    redrawTimerRef.current = setTimeout(() => {
      redrawTimerRef.current = null;
      setRevision((v) => v + 1);
      setStatus((s) =>
        s.movesCoSigned === totalMovesRef.current
          ? s
          : { ...s, movesCoSigned: totalMovesRef.current },
      );
    }, REDRAW_THROTTLE_MS);
  }, []);

  // Mirror an accepted paint into the live canvas, evicting the oldest cell if the
  // retained set grows past its cap (constant memory for an endless wall).
  const paintCell = useCallback(
    (mv: WorldCanvasMove, by: Seat, seq: number, painter: string) => {
      const map = paintsRef.current;
      const key = cellKey(mv.cx, mv.cy, mv.x, mv.y);
      // map.set on an existing key overwrites in place (latest painter wins) —
      // this is the overpaint path: owner + color update, no lock, no new slot.
      map.set(key, {
        cx: mv.cx,
        cy: mv.cy,
        x: mv.x,
        y: mv.y,
        color: mv.color,
        by,
        seq,
        painter,
      });
      if (map.size > MAX_RETAINED_CELLS) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      scheduleRedraw();
    },
    [scheduleRedraw],
  );

  // Ensure a painter exists in the tally (idempotent); refresh label/tint if known.
  const registerPainter = useCallback(
    (address: string, label: string, isAgent: boolean, tint: string) => {
      const m = paintersRef.current;
      const existing = m.get(address);
      if (existing) {
        existing.label = label;
        existing.tint = tint;
        return;
      }
      m.set(address, { address, label, isAgent, tint, cells: 0, lastSeq: 0 });
    },
    [],
  );

  // Book one accepted paint against its painter and append it to the activity ring.
  const recordPaint = useCallback(
    (address: string, mv: WorldCanvasMove, seq: number) => {
      const m = paintersRef.current;
      let p = m.get(address);
      if (!p) {
        const isHuman = address === humanAddress;
        p = {
          address,
          label: isHuman ? "You" : "Painter",
          isAgent: !isHuman,
          tint: isHuman ? TINT_HUMAN : TINT_BOT_B,
          cells: 0,
          lastSeq: 0,
        };
        m.set(address, p);
      }
      p.cells += 1;
      p.lastSeq = seq;
      const feed = activityRef.current;
      feed.push({
        seq,
        painter: address,
        label: p.label,
        cx: mv.cx,
        cy: mv.cy,
        x: mv.x,
        y: mv.y,
        color: mv.color,
        t: Date.now(),
      });
      if (feed.length > MAX_ACTIVITY) feed.shift();
    },
    [humanAddress],
  );

  // Flush one seat bot's accumulated paint count into ONE MY-ACTIVITY row labelled with
  // its painter ("Bot A" / "Bot B"). Fires on the leading-edge throttle timer (see
  // accumulateBotPaint), summarizing the whole ~BOT_ACTIVITY_THROTTLE_MS window. The
  // label is read live from the painters tally so it tracks any relabel. Best-effort: a
  // feed write can never throw back into the paint path.
  const flushBotPaints = useCallback(
    (painter: string) => {
      botActivityTimersRef.current.delete(painter);
      const n = botPaintCountsRef.current.get(painter) ?? 0;
      botPaintCountsRef.current.set(painter, 0);
      if (n === 0) return;
      try {
        const label = paintersRef.current.get(painter)?.label ?? "Bot";
        report.pushLocalTxn({
          id: feedRowId(
            `bot-stroke:${painter}:${botActivityFlushIdRef.current++}`,
          ),
          game: GAME,
          time: new Date().toLocaleTimeString("en-GB"),
          bot: label,
          type: `painted ${n} cell(s)`,
          status: "Success",
          amount: "",
        });
      } catch (e) {
        console.warn("[world-canvas] bot-stroke activity row skipped:", e);
      }
    },
    [report],
  );

  // Book one bot-co-signed cell toward its painter's next MY-ACTIVITY row and arm the
  // leading-edge throttle: the FIRST un-flushed paint per painter schedules a single
  // flush ~BOT_ACTIVITY_THROTTLE_MS out; subsequent paints only bump the count (no
  // reschedule), so at most one row per painter per window — never a flood. Bot-only;
  // the human seat's own row comes from submitHumanPaint's debounce, so coSignPaint must
  // skip the human painter here to avoid doubling up.
  const accumulateBotPaint = useCallback(
    (painter: string) => {
      const counts = botPaintCountsRef.current;
      counts.set(painter, (counts.get(painter) ?? 0) + 1);
      if (!botActivityTimersRef.current.has(painter)) {
        botActivityTimersRef.current.set(
          painter,
          setTimeout(() => flushBotPaints(painter), BOT_ACTIVITY_THROTTLE_MS),
        );
      }
    },
    [flushBotPaints],
  );

  // Submit a tx signed by a bot keypair; assert success (sender-pays fallback only).
  const submit = useCallback(
    async (tx: Transaction, signer: Ed25519Keypair) => {
      const res = await client.signAndExecuteTransaction({
        signer,
        transaction: tx,
        options: { showObjectChanges: true, showEffects: true },
      });
      if (res.effects?.status?.status !== "success") {
        throw new Error(
          `tx ${res.digest} failed: ${res.effects?.status?.error ?? "unknown"}`,
        );
      }
      await client.waitForTransaction({ digest: res.digest });
      return res;
    },
    [client],
  );

  // Coarse throughput report — one call per ~1s window, never per paint. This is the
  // signal the dashboard turns into live TPS (it derives a rate from the action COUNT).
  const flushHeartbeat = useCallback(
    (run: CanvasRun, force: boolean) => {
      const s = run.session;
      if (!s || run.actions === 0) return;
      const now = Date.now();
      const windowMs = now - run.lastHeartbeat;
      if (!force && windowMs < 1000) return;
      const actionsDelta = run.actions;
      run.actions = 0;
      run.lastHeartbeat = now;
      // Same count, locally: feed the per-game TPS chip its real rate when no backend is connected.
      report.recordActions(actionsDelta);
      getControlPlaneClient()
        .sendHeartbeat(s.sessionId, s.statsToken, {
          tunnelId: run.tunnelId,
          nonce: String(run.moveCount),
          actionsDelta,
          windowMs: Math.max(1, windowMs),
        })
        .catch((e) => console.error("[world-canvas] heartbeat failed:", e));
    },
    [report],
  );

  // Co-sign one paint through the tunnel; count only honest, both-signature-VERIFIED
  // steps (the TPS gate). One verified step = one action + one increment of the
  // co-signed total (the window TPS numerator) — for EITHER seat, human- or bot-driven.
  const coSignPaint = useCallback(
    (run: CanvasRun, mv: WorldCanvasMove, by: Seat, painter: string) => {
      if (!run.tunnel || run.closed) return;
      try {
        const r = run.tunnel.step(mv, by, {
          mode: "full",
          timestamp: run.createdAt,
        });
        if (!r.verified) return;
        run.moveCount += 1;
        movesThisGameRef.current += 1;
        run.actions += 1;
        totalMovesRef.current += 1;
        paintCell(mv, by, totalMovesRef.current, painter);
        recordPaint(painter, mv, totalMovesRef.current);
        // Surface bot painting in MY ACTIVITY too (throttled per painter). The human's
        // own paints already get a per-stroke row via submitHumanPaint, so skip the human
        // painter here to avoid a duplicate row.
        if (painter !== humanAddress) accumulateBotPaint(painter);
        flushHeartbeat(run, false);
        // Game boundary at the cap: every MOVES_PER_GAME co-signed paints, end the game —
        // close the tunnel (on-chain: settle + anchor root; demo: no settle), wipe the
        // canvas, re-seed the bots, and reopen a fresh tunnel. BOTH tunnels bound here; the
        // settle is gated inside checkpointRun, so demo bounds without touching the chain.
        if (
          !run.checkpointing &&
          run.moveCount - run.lastCheckpoint >= movesPerGameRef.current
        ) {
          checkpointRef.current?.(run);
        }
      } catch (e) {
        console.warn("[world-canvas] tunnel step skipped:", e);
      }
    },
    [paintCell, recordPaint, flushHeartbeat, accumulateBotPaint, humanAddress],
  );

  // The paint sink: co-sign once the single tunnel exists, else buffer (preserving
  // order) until `startRun` drains it.
  const submitPaint = useCallback(
    (mv: WorldCanvasMove, by: Seat, painter: string) => {
      const run = runRef.current;
      if (!run || run.closed) return;
      if (!run.ready || !run.tunnel) {
        run.buffer.push({ mv, by, painter });
        return;
      }
      coSignPaint(run, mv, by, painter);
    },
    [coSignPaint],
  );

  // Open the single 2-party tunnel: try an on-chain sponsored open, else fall to demo.
  // The selfPlay tunnel is built with the FINAL id (real or demo) so its co-signatures
  // match; buffered paints replay in order once it is live. `reopen` is true for a
  // post-checkpoint reopen (skip the "opening…"/phase resets that would flicker the HUD).
  const startRun = useCallback(
    async (reopen = false) => {
      const identities = identitiesRef.current;
      if (!identities) return;
      registerPainter(humanAddress, "You", false, TINT_HUMAN);

      const run: CanvasRun = {
        identities,
        // Demo id must be a VALID 32-byte hex address: selfPlay feeds it to
        // addressToBytes32, which throws on a non-hex marker. The demo/real
        // distinction is the `onchain` flag, not this string.
        tunnelId: `0x${`${Date.now().toString(16)}${Math.floor(
          Math.random() * 0xffffffff,
        ).toString(16)}`.padStart(64, "0")}`,
        onchain: false,
        createdAt: 0n,
        tunnel: null,
        buffer: [],
        ready: false,
        closed: false,
        session: null,
        moveCount: 0,
        actions: 0,
        lastHeartbeat: Date.now(),
        transcript: null,
        lastCheckpoint: 0,
        checkpointing: false,
        coinType: undefined,
      };
      // Publish the new run synchronously so the seat bots route paints to it (buffered
      // until live) the instant they tick — no gap across a checkpoint reopen.
      runRef.current = run;
      if (!reopen) setStatus({ ...EMPTY_STATUS, phase: "opening" });

      const partyX = {
        address: identities.a.address,
        publicKey: identities.a.publicKey,
      };
      const partyO = {
        address: identities.b.address,
        publicKey: identities.b.publicKey,
      };

      // MTPS mode (ADR-0010, the default): stake FREE faucet-minted MTPS and
      // sponsor the painter's open gas, so it needs ZERO SUI — exactly how the finite
      // games open. A sponsored tx can't reference `tx.gas`, so the stake MUST come from
      // a `stakeCoinId` (not the SUI gas-coin fallback). SUI fallback (MTPS env
      // unset): the painter funds the stakes from its own gas.
      const mtpsOn = isMtpsConfigured;
      const coinType = mtpsOn ? MTPS_COIN_TYPE : undefined;
      const stakePerSeat = mtpsOn ? MTPS_STAKE_PER_SEAT : STAKE;
      run.coinType = coinType;

      const sponsoredSignExec = makeKeypairSponsoredSignExec({
        address: identities.a.address,
        keypair: identities.a.keypair,
        client: client as never,
      });
      const reads = client as unknown as Parameters<
        typeof openAndFundSelfPlay
      >[0]["reads"];

      try {
        // Fund the stake BEFORE the open so concurrent (re)opens of the single tunnel — and
        // React StrictMode's double-mount — never equivocate. ADR-0013: stake from the seat-A
        // identity's MTPS *address balance* (withdrawn inside `create_and_fund`), topping it up
        // off the hot open path (faucet/sweep) only when short — so the open just redeems a ready
        // balance and Sui's own version ordering settles any overlap. Keyed to the ephemeral
        // seat-A identity (a 0-SUI bot key, gas-sponsored), not a connected wallet. SUI fallback
        // (MTPS env unset) has no such balance — the framework splits the stake from the gas coin
        // inside openAndFundSelfPlay.
        let stakeOpt: {
          stakeCoinId?: string;
          stakeFromBalance?: { amount: bigint; coinType: string };
        } = {};
        if (mtpsOn) {
          // Self-play funds BOTH seats from one source → fund for the 2-seat total.
          if (isMtpsAddressBalance) {
            await ensureMtpsAddressBalance({
              client: client as never,
              signExec: sponsoredSignExec,
              owner: identities.a.address,
              need: 2n * stakePerSeat,
            });
            stakeOpt = {
              stakeFromBalance: {
                amount: 2n * stakePerSeat,
                coinType: MTPS_COIN_TYPE,
              },
            };
          } else {
            stakeOpt = {
              stakeCoinId: await ensureMtpsStakeCoin({
                client: client as never,
                owner: identities.a.address,
                need: 2n * stakePerSeat,
              }),
            };
          }
        }

        // ONE create_and_fund opens the tunnel AND funds BOTH distinct seats' stakes in a
        // single signature (the shared, proven self-play helper). MTPS: gas-sponsored, staked
        // from the address balance (or a coin). SUI fallback: sponsored first, then sender-pays
        // (the seat-A key paying its own gas).
        const openedTunnelId = mtpsOn
          ? await openAndFundSelfPlay({
              reads,
              signExec: sponsoredSignExec,
              partyA: partyX,
              partyB: partyO,
              aAmount: stakePerSeat,
              bAmount: stakePerSeat,
              coinType,
              ...stakeOpt,
            })
          : await withSponsorFallback(
              () =>
                openAndFundSelfPlay({
                  reads,
                  signExec: sponsoredSignExec,
                  partyA: partyX,
                  partyB: partyO,
                  aAmount: stakePerSeat,
                  bAmount: stakePerSeat,
                }),
              () =>
                openAndFundSelfPlay({
                  reads,
                  signExec: (tx) => submit(tx, identities.a.keypair),
                  partyA: partyX,
                  partyB: partyO,
                  aAmount: stakePerSeat,
                  bAmount: stakePerSeat,
                }),
              "world-canvas open/fund",
            );

        run.tunnelId = openedTunnelId;
        run.onchain = true;
        run.createdAt = await readCreatedAt(reads, openedTunnelId);
        // `openDigest` historically carried the create_and_fund digest; the shared helper
        // returns the tunnel id directly (the digest stays internal), so surface that —
        // the field is only an "opened on-chain" HUD handle, never a feed-row key.
        if (!reopen) setStatus((s) => ({ ...s, openDigest: openedTunnelId }));
      } catch (e) {
        console.warn(
          "[world-canvas] on-chain open failed — running off-chain demo:",
          e,
        );
      }

      // If the run was torn down while opening (unmount/checkpoint), don't bring it up.
      if (run.closed) return;

      // Build the local co-signing tunnel with the final id. selfPlay holds BOTH seats'
      // keypairs, so each paint co-signs both distinct funded parties locally.
      const tunnel = core.OffchainTunnel.selfPlay<
        WorldCanvasState,
        WorldCanvasMove
      >(
        proto,
        run.tunnelId,
        identities.a.coreKey,
        identities.b.coreKey,
        identities.a.address,
        identities.b.address,
        // Match the on-chain stake so the cooperative-close balances reconcile.
        { a: stakePerSeat, b: stakePerSeat },
      );
      run.tunnel = tunnel;
      run.lastHeartbeat = Date.now();
      // Accumulate every co-signed update so a checkpoint can anchor the Merkle root.
      const transcript = new proof.Transcript(run.tunnelId);
      tunnel.onUpdate = (u) => transcript.append(u);
      run.transcript = transcript;
      run.lastCheckpoint = run.moveCount;

      // Register the tunnel for stats tracking. Best-effort (never blocks painting).
      getControlPlaneClient()
        .registerSession({
          userAddress: identities.a.address,
          game: GAME,
          tunnels: [
            {
              tunnelId: run.tunnelId,
              partyA: identities.a.address,
              partyB: identities.b.address,
            },
          ],
        })
        .then((s) => {
          run.session = s;
        })
        .catch((e) =>
          console.error("[world-canvas] registerSession failed:", e),
        );

      // Surface the open in the dashboard exactly like every other game: bump the tunnel
      // counters, mark both seats active, and push a MY-ACTIVITY row under "world-canvas".
      // A post-checkpoint reopen is an honest fresh open (the prior tunnel closes at the
      // settle site), so the open/close counters net out. Synchronous panel writes — never
      // the paint path.
      report.bumpCounters({ tunnelsOpened: 1 });
      report.setActive(2);
      report.pushLocalTxn({
        id: feedRowId(run.tunnelId),
        game: GAME,
        time: new Date().toLocaleTimeString("en-GB"),
        bot: shortTunnelId(run.tunnelId),
        type: "Start",
        status: "Success",
        amount: "",
      });
      // Also surface the open in LIVE TRANSACTIONS (snapshot.txns) under this game's tab,
      // mirroring the "Start" row every other game's on-chain feed uses. BOTH feeds get it:
      // MY ACTIVITY (above) and LIVE TRANSACTIONS (here).
      report.pushTxn({
        id: feedRowId(run.tunnelId),
        game: GAME,
        time: new Date().toLocaleTimeString("en-GB"),
        bot: shortTunnelId(run.tunnelId),
        type: "Start",
        status: "Success",
        amount: "",
      });

      // Tunnel is live: drain any paints buffered during the open, then continue.
      run.ready = true;
      const buffered = run.buffer;
      run.buffer = [];
      for (const { mv, by, painter } of buffered)
        coSignPaint(run, mv, by, painter);

      if (!reopen) {
        setStatus((s) => ({
          ...s,
          phase: run.onchain ? "open" : "demo",
          tunnelId: run.tunnelId,
          onchain: run.onchain,
          movesCoSigned: totalMovesRef.current,
        }));
      }
    },
    [client, proto, submit, coSignPaint, registerPainter, humanAddress, report],
  );

  // End the current game at the cap: cooperatively close the tunnel, reopen a fresh one,
  // WIPE the canvas + re-seed the bots (resetGameState), and bump the game counter — so
  // the wall runs as discrete games. The reopen is synchronous up to startRun's first
  // await (paints route to the new tunnel with no gap, buffered until live), so the
  // boundary is instant. BOTH tunnels bound here; the on-chain path ALSO anchors the
  // retired tunnel's transcript root via the SAME backend `/settle` path every finite
  // game uses (stakes return, NO winner) + pushes the "settled" feed rows. The demo
  // tunnel bounds the game WITHOUT touching the chain. resetGameState is reached via a
  // ref because it's defined later (it needs nextPlacement / syncAgentMarkers).
  const checkpointRef = useRef<((run: CanvasRun) => void) | null>(null);
  const resetGameRef = useRef<(() => void) | null>(null);
  const checkpointRun = useCallback(
    async (run: CanvasRun) => {
      if (run.checkpointing || run.closed || !run.tunnel || !run.transcript)
        return;
      run.checkpointing = true;
      const { tunnel, transcript } = run;
      // On-chain games anchor the retired tunnel's transcript root; build that settlement
      // BEFORE retiring the tunnel. A build failure is transient — abort the boundary and
      // retry at the next cap, leaving the tunnel running. The demo tunnel never anchors,
      // so it skips this and always bounds the game.
      let settlement: core.CoSignedSettlementWithRoot | null = null;
      if (run.onchain) {
        try {
          settlement = tunnel.buildSettlementWithRoot(
            run.createdAt,
            transcript.root(),
            0n,
          );
        } catch (e) {
          console.warn("[world-canvas] checkpoint build skipped:", e);
          run.checkpointing = false;
          run.lastCheckpoint = run.moveCount;
          return;
        }
      }
      // Retire the old tunnel and reopen immediately so paints keep flowing, then wipe the
      // canvas + re-seed the bots for the new game. On-chain: anchor the closed tunnel's
      // root in the background below. Demo stops at the boundary (no chain).
      run.closed = true;
      void startRun(true);
      resetGameRef.current?.();
      if (!run.onchain || !settlement) return;
      const sponsoredClose = makeKeypairSponsoredSignExec({
        address: run.identities.a.address,
        keypair: run.identities.a.keypair,
        client: client as never,
      });
      try {
        await settleViaBackend({
          tunnelId: run.tunnelId,
          settlement,
          transcript: transcript.rawEntries(),
          label: "world-canvas",
          fallbackClose: async () => {
            const { digest } = await sponsoredClose(
              buildSettleWithRootTx(run.tunnelId, settlement, run.coinType),
            );
            await client.waitForTransaction({ digest });
            return digest;
          },
        });
        // Anchored: close the prior tunnel in the dashboard like every other game — bump the
        // closed/settlement counters and push a MY-ACTIVITY "End" row. We DON'T setActive(0)
        // here: the reopen (startRun above) already re-marked both seats active, so the wall
        // keeps running. (Guarded inside this try so it can never throw into the settle path.)
        report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
        report.pushLocalTxn({
          id: feedRowId(`${run.tunnelId}:${run.moveCount}`),
          game: GAME,
          time: new Date().toLocaleTimeString("en-GB"),
          bot: shortTunnelId(run.tunnelId),
          type: "End",
          status: "Success",
          amount: "closed",
        });
        // Mirror the close into LIVE TRANSACTIONS (snapshot.txns) as an "End" row, the
        // on-chain-feed counterpart of the MY-ACTIVITY "End" row above. BOTH feeds get it.
        report.pushTxn({
          id: feedRowId(`${run.tunnelId}:${run.moveCount}`),
          game: GAME,
          time: new Date().toLocaleTimeString("en-GB"),
          bot: shortTunnelId(run.tunnelId),
          type: "End",
          status: "Success",
          amount: "closed",
        });
      } catch (e) {
        console.warn("[world-canvas] checkpoint settle failed:", e);
      }
    },
    [client, startRun, report],
  );
  checkpointRef.current = checkpointRun;

  // Flush the accumulated human-stroke count into ONE MY-ACTIVITY row labelled "You".
  // Fires ~HUMAN_STROKE_DEBOUNCE_MS after the human's last paint (the debounce timer).
  // Best-effort: guarded so a feed write can never throw back into the paint path.
  const flushHumanStroke = useCallback(() => {
    humanStrokeTimerRef.current = null;
    const n = humanStrokeCountRef.current;
    humanStrokeCountRef.current = 0;
    if (n === 0) return;
    try {
      report.pushLocalTxn({
        id: feedRowId(`human-stroke:${humanStrokeFlushIdRef.current++}`),
        game: GAME,
        time: new Date().toLocaleTimeString("en-GB"),
        bot: "You",
        type: `painted ${n} cell(s)`,
        status: "Success",
        amount: "",
      });
    } catch (e) {
      console.warn("[world-canvas] human-stroke activity row skipped:", e);
    }
  }, [report]);

  // Public: the human paints seat A on the single tunnel — ONLY while holding the wheel
  // (Auto OFF). When Auto is ON the seat-A bot owns the seat, so human paints are ignored
  // (watch mode), exactly like chicken-cross ignores your steering on autopilot.
  const submitHumanPaint = useCallback(
    (cx: bigint, cy: bigint, x: number, y: number, color: number) => {
      if (autoRef.current) return;
      submitPaint({ cx, cy, x, y, color }, "A", humanAddress);
      // Summarize this stroke in MY-ACTIVITY (human-only — bots stay as TPS). Tally the
      // cell, remember it as the stroke anchor, and cancel-and-reschedule the debounce so
      // a continuous stroke flushes one "painted N cell(s)" row at its trailing gap.
      humanStrokeCountRef.current += 1;
      humanStrokeLastCellRef.current = { cx, cy, x, y };
      if (humanStrokeTimerRef.current !== null) {
        clearTimeout(humanStrokeTimerRef.current);
      }
      humanStrokeTimerRef.current = setTimeout(
        flushHumanStroke,
        HUMAN_STROKE_DEBOUNCE_MS,
      );
    },
    [submitPaint, humanAddress, flushHumanStroke],
  );

  // Seed the next region/walk for a seat bot. Artist is the deliberate "draw a picture"
  // intelligence and keeps its bounded region (a chosen template, else the flag rotation);
  // EVERY OTHER intelligence is a FREESTYLE momentum walk that wanders the open canvas from
  // a distinct per-seat spawn, drawing one continuous single-color line (no footprint box).
  const nextPlacement = useCallback(
    (modeId: AgentModeId, seat: Seat): AgentPlacement => {
      const i = regionIndexRef.current++;
      const { col, row } = spiralSlot(i);

      if (modeId === "artist") {
        // Artist + chosen template: stamp the rasterized template's cells in reveal order.
        // The template is fit into a box under the max mode footprint, so its region drops on
        // the shared slot lattice and never overlaps a neighbour. Each cell is one co-signed
        // move; with no template it falls through to the flag rotation below.
        const tplId = agentTemplateRef.current;
        const tpl = tplId ? TEMPLATES_BY_ID[tplId] : undefined;
        if (tpl) {
          const scale = fitScale(
            tpl.aspect,
            AGENT_TEMPLATE_W,
            AGENT_TEMPLATE_H,
          );
          const rast = rasterizeTemplate(tpl, scale);
          const fw = Math.max(1, rast.width);
          const fh = Math.max(1, rast.height);
          const originGx = Math.round(col * SLOT_W - fw / 2);
          const originGy = Math.round(row * SLOT_H - fh / 2);
          return {
            kind: "template",
            iter: rast.cells[Symbol.iterator]() as Iterator<DesignCell>,
            regionName: tpl.name,
            footprintH: fh,
            maxCells: Math.max(1, rast.cells.length),
            originGx,
            originGy,
            centerGx: originGx + fw / 2,
            centerGy: originGy + fh / 2,
            walkGx: originGx,
            walkGy: originGy,
            walkDx: 1,
            walkDy: 0,
            rng: NOOP_RNG,
            color: 0,
          };
        }
        const mode = AGENT_MODES.artist;
        const fw = mode.footprint.width;
        const fh = mode.footprint.height;
        const iter = mode.strokes({
          width: fw,
          height: fh,
          rng: mulberry32(REGION_SEED ^ Math.imul(i + 1, 2654435761)),
          numColors: NUM_COLORS,
          index: i,
        });
        const originGx = Math.round(col * SLOT_W - fw / 2);
        const originGy = Math.round(row * SLOT_H - fh / 2);
        return {
          kind: "template",
          iter,
          regionName: mode.label,
          footprintH: fh,
          maxCells: Math.round(fw * fh * REGION_FILL_FACTOR),
          originGx,
          originGy,
          centerGx: originGx + fw / 2,
          centerGy: originGy + fh / 2,
          walkGx: originGx,
          walkGy: originGy,
          walkDx: 1,
          walkDy: 0,
          rng: NOOP_RNG,
          color: 0,
        };
      }

      // Freestyle: a bounded momentum random walk (mirroring worldCanvasPvp.randomMove). Spawn
      // at a distinct slot center and walk forever from the last painted cell — no per-region
      // cap (maxCells = ∞ ⇒ it never relocates), so the line wanders freely across the canvas.
      const rng = mulberry32(REGION_SEED ^ Math.imul(i + 1, 2654435761));
      const spawnGx = col * SLOT_W;
      const spawnGy = row * SLOT_H;
      return {
        kind: "freestyle",
        iter: null,
        regionName: AGENT_MODES[modeId].label,
        footprintH: FREESTYLE_MARKER_H,
        maxCells: Number.POSITIVE_INFINITY,
        originGx: spawnGx,
        originGy: spawnGy,
        centerGx: spawnGx,
        centerGy: spawnGy,
        walkGx: spawnGx,
        walkGy: spawnGy,
        walkDx: rng() < 0.5 ? 1 : -1,
        walkDy: Math.floor(rng() * 3) - 1,
        rng,
        color: seat === "A" ? FREESTYLE_COLOR_A : FREESTYLE_COLOR_B,
      };
    },
    [],
  );

  // Publish the live seat-bot markers from the internal agent states. Seat B always
  // shows; seat A shows only while Auto is on (when you hold the wheel, seat A is yours,
  // so its bot is paused and has no marker).
  const syncAgentMarkers = useCallback(() => {
    setAgents(
      [...agentStatesRef.current.values()]
        .filter((s) => s.seat === "B" || autoRef.current)
        .map((s) => ({
          id: s.id,
          label: s.label,
          painter: s.painter,
          flagName: s.regionName,
          tint: s.tint,
          gx: s.centerGx,
          gy: s.centerGy,
          h: s.footprintH,
        })),
    );
  }, []);

  // Wipe the world for a fresh game at a MOVES_PER_GAME boundary: clear the canvas cells,
  // the leaderboard, and the activity ring; re-seed BOTH bots from the spiral origin
  // (region 0/1) so the new game starts clean; reset the per-game move counter; and bump
  // the game counter. Called right AFTER checkpointRun reopens the fresh tunnel — and it
  // runs with no concurrent paintFrame writes (the old run is `closed`, the new one not
  // yet `ready`), so iterating the bots here is race-free. The human painter is
  // re-registered (startRun just added it, then this clear would have dropped it) so "You"
  // survives the wipe; totalMovesRef stays cumulative (the global TPS dial is unaffected).
  const resetGameState = useCallback(() => {
    paintsRef.current.clear();
    paintersRef.current.clear();
    activityRef.current.length = 0;
    registerPainter(humanAddress, "You", false, TINT_HUMAN);
    // Re-seed both bots from the origin: spiral slots restart at 0 so the new game's art
    // begins centered, not wherever the prior game's relocations had wandered to.
    regionIndexRef.current = 0;
    for (const st of agentStatesRef.current.values()) {
      registerPainter(st.painter, st.label, true, st.tint);
      applyPlacement(st, nextPlacement(st.mode, st.seat));
    }
    syncAgentMarkers();
    movesThisGameRef.current = 0;
    setGame((g) => g + 1);
    setRevision((v) => v + 1);
  }, [registerPainter, humanAddress, nextPlacement, syncAgentMarkers]);
  resetGameRef.current = resetGameState;

  // The single paint frame for BOTH seat bots, driven by requestAnimationFrame (~60fps)
  // so painting rides the render cadence — smooth and frame-aligned, never bursty, and
  // bounded by the refresh rate so it can't run away. Each active bot pulls a clamped
  // per-frame BATCH and co-signs each cell (one verified step = one action = one TPS).
  // A FREESTYLE bot walks one continuous line (stepFreestyle, never exhausted); an Artist
  // picture pulls from its region stream and relocates to a fresh slot on end/cap, KEEPING
  // PAINTING from the fresh region in the SAME frame (bounded per frame so it can't spin).
  // The seat-A bot paints only while Auto is ON — when you hold the wheel it idles and your
  // submitHumanPaint drives seat A instead; the seat-B bot always paints. Speed/mode/density
  // are read live each frame (refs), so the Speed pills + Density lever take effect at once.
  const paintFrame = useCallback(
    function frame() {
      const run = runRef.current;
      // Cabinet hover-freeze: keep the loop alive so it resumes mid-stream, but submit no
      // paints while paused. Purely a co-sign freeze — the tunnel and game state are untouched.
      if (pausedRef.current) {
        agentRafRef.current = requestAnimationFrame(frame);
        return;
      }
      let markersDirty = false;
      if (run && !run.closed && run.ready && run.tunnel) {
        for (const st of agentStatesRef.current.values()) {
          const seatActive = st.seat === "B" || autoRef.current;
          if (!seatActive) continue;
          const batch = agentFrameBatch(
            st.speed,
            st.mode,
            agentDensityRef.current,
          );
          let relocates = 0;
          let painted = 0;
          while (painted < batch) {
            let cell: DesignCell | null = null;
            if (st.kind === "freestyle") {
              // Endless walk: always the next cell of the continuous line (never relocates).
              cell = stepFreestyle(st);
            } else if (st.painted < st.maxCells && st.iter) {
              const nx = st.iter.next();
              if (!nx.done) cell = nx.value;
            }
            if (cell === null) {
              // Artist stream exhausted / region cap reached → relocate the picture to a
              // fresh slot and keep painting THIS frame (freestyle never reaches here).
              // Bounded per frame so a pathological near-empty stream can't spin.
              if (relocates >= MAX_RELOCATES_PER_FRAME) break;
              relocates += 1;
              applyPlacement(st, nextPlacement(st.mode, st.seat));
              markersDirty = true;
              continue;
            }
            st.painted += 1;
            submitPaint(
              moveAtGlobal(
                st.originGx + cell.dx,
                st.originGy + cell.dy,
                // The bots paint in YOUR currently-selected color (the toolbar drives the
                // whole canvas's palette), not the design mode's own color.
                botColorRef.current,
              ),
              st.seat,
              st.painter,
            );
            // Freestyle: track the wandering head so View/marker jumps land on the live line.
            if (st.kind === "freestyle") {
              st.centerGx = st.walkGx;
              st.centerGy = st.walkGy;
            }
            painted += 1;
          }
        }
      }
      // Re-sync markers when an Artist picture relocated, and periodically so a freestyle
      // marker follows its wandering head a few times/second (off the per-frame React path).
      agentMarkerTickRef.current += 1;
      if (agentMarkerTickRef.current >= MARKER_SYNC_EVERY_FRAMES) {
        agentMarkerTickRef.current = 0;
        markersDirty = true;
      }
      if (markersDirty) syncAgentMarkers();
      agentRafRef.current = requestAnimationFrame(frame);
    },
    [nextPlacement, syncAgentMarkers, submitPaint],
  );

  // Bring up one seat bot: register it and give it a starting region. The shared rAF
  // paintFrame loop (started on mount) drives its painting. `seat`/`painter` are its
  // distinct funded identity + display address. Both seat bots run for the window's life
  // (the seat-A one idles while you hold the wheel — see paintFrame — but is never torn
  // down).
  const startSeatBot = useCallback(
    (params: { seat: Seat; painter: string; label: string; tint: string }) => {
      registerPainter(params.painter, params.label, true, params.tint);
      const speed = agentSpeedRef.current;
      const mode = agentModeRef.current;
      const place = nextPlacement(mode, params.seat);
      const id = `bot_${params.seat}_${Date.now()}`;
      const st: AgentState = {
        id,
        seat: params.seat,
        painter: params.painter,
        label: params.label,
        tint: params.tint,
        speed,
        mode,
        kind: place.kind,
        iter: place.iter,
        regionName: place.regionName,
        footprintH: place.footprintH,
        maxCells: place.maxCells,
        originGx: place.originGx,
        originGy: place.originGy,
        centerGx: place.centerGx,
        centerGy: place.centerGy,
        walkGx: place.walkGx,
        walkGy: place.walkGy,
        walkDx: place.walkDx,
        walkDy: place.walkDy,
        rng: place.rng,
        color: place.color,
        painted: 0,
      };
      agentStatesRef.current.set(id, st);
    },
    [registerPainter, nextPlacement],
  );

  // Public: set Auto deterministically. ON = both seats bot-driven (watch, bot vs bot). OFF =
  // the seat-A bot idles and you author seat A vs the seat-B bot — on the SAME tunnel, no reopen.
  // Idempotent (a no-op when already at `value`), so the cabinet's `setAuto(false)` take-over is
  // safe to call twice. The seat-A marker appears/disappears with the flip.
  const setAuto = useCallback(
    (value: boolean) => {
      if (autoRef.current === value) return;
      autoRef.current = value;
      setAutoState(value);
      syncAgentMarkers();
    },
    [syncAgentMarkers],
  );

  // Public: flip Auto (the in-canvas toggle). Reads the live ref, so it stays correct after a
  // cabinet take-over has forced Auto off.
  const toggleAuto = useCallback(() => {
    setAuto(!autoRef.current);
  }, [setAuto]);

  // Public (cabinet seam): freeze the bot rAF paint loop in place on hover. The loop keeps
  // scheduling frames but submits no co-signed paints until resumeAgents(); the tunnel stays
  // open and the game is untouched, so painting resumes mid-stream when the pointer leaves.
  const pauseAgents = useCallback(() => {
    pausedRef.current = true;
  }, []);

  const resumeAgents = useCallback(() => {
    pausedRef.current = false;
  }, []);

  // Public: set the agent paint speed — for both seat bots (the self-rescheduling timer
  // picks up the new interval on its next tick).
  const setAgentSpeed = useCallback((speed: AgentSpeed) => {
    agentSpeedRef.current = speed;
    setAgentSpeedState(speed);
    for (const st of agentStatesRef.current.values()) st.speed = speed;
  }, []);

  // Public: set the agent drawing intelligence — for both seat bots. A freestyle walk never
  // relocates, so a switch ACROSS the Artist boundary (freestyle ↔ picture) re-seeds the bot
  // now; switches within a kind take effect at the next region (Artist) or just relabel.
  const setAgentMode = useCallback(
    (mode: AgentModeId) => {
      agentModeRef.current = mode;
      setAgentModeState(mode);
      const nextKind = mode === "artist" ? "template" : "freestyle";
      for (const st of agentStatesRef.current.values()) {
        st.mode = mode;
        if (st.kind !== nextKind)
          applyPlacement(st, nextPlacement(mode, st.seat));
      }
      syncAgentMarkers();
    },
    [nextPlacement, syncAgentMarkers],
  );

  // Public: set the global Density lever (1/2/3) — a per-tick batch multiplier read
  // live by both seat bots' next tick, so the TPS burst changes immediately.
  const setAgentDensity = useCallback((level: number) => {
    const clamped = Math.max(
      1,
      Math.min(DENSITY_LEVELS.length, Math.round(level)),
    );
    agentDensityRef.current = clamped;
    setAgentDensityState(clamped);
  }, []);

  // Public: choose the Artist agent's template (or null for the flag rotation). Read
  // live by `nextPlacement`, so each seat bot switches at its next region.
  const setAgentTemplate = useCallback((id: string | null) => {
    agentTemplateRef.current = id;
    setAgentTemplateState(id);
  }, []);

  // Public: re-center the camera on the live seat bot painting at `painter` (📍). Jumps at the
  // WIDEST zoom (ZOOM.min) — same as the auto-follow cam — so you actually SEE the bot and its
  // art, not nose-to-the-pixels at the default focus zoom (which framed a tiny spot you couldn't
  // find as the bot wandered off).
  const focusOnAgent = useCallback((painter: string) => {
    for (const st of agentStatesRef.current.values()) {
      if (st.seat === "A" && !autoRef.current) continue; // paused seat-A bot has no marker
      if (st.painter === painter) {
        setFocus({
          gx: st.centerGx,
          gy: st.centerGy,
          seq: ++focusSeqRef.current,
          scale: ZOOM.min,
        });
        return;
      }
    }
  }, []);

  // Auto-follow (spectator cam): while Auto is on, lazily ease the camera to seat A's bot so
  // you WATCH it paint instead of staring at a blank wall while it draws off-screen — the
  // arena's other games auto-frame their bots the same way. Re-centers on a timer (the bot's
  // center moves as it walks) at the WIDEST zoom (ZOOM.min), so you see the whole picture
  // forming rather than nose-to-the-pixels — never zooming in. Stops the instant you take the
  // wheel (Auto off), handing camera + zoom control back to you.
  useEffect(() => {
    if (!auto) return;
    const followSeatA = () => {
      for (const st of agentStatesRef.current.values()) {
        if (st.seat === "A") {
          setFocus({
            gx: st.centerGx,
            gy: st.centerGy,
            seq: ++focusSeqRef.current,
            scale: ZOOM.min,
          });
          return;
        }
      }
    };
    followSeatA();
    const id = setInterval(followSeatA, AUTO_FOLLOW_MS);
    return () => clearInterval(id);
  }, [auto]);

  // Public: cycle the camera through the live seat bots ("View" button).
  const viewNextAgent = useCallback(() => {
    const states = [...agentStatesRef.current.values()].filter(
      (s) => s.seat === "B" || autoRef.current,
    );
    if (states.length === 0) return;
    const idx = viewCursorRef.current % states.length;
    viewCursorRef.current = idx + 1;
    const st = states[idx];
    setFocus({ gx: st.centerGx, gy: st.centerGy, seq: ++focusSeqRef.current });
  }, []);

  // Public: PvP Find Match (two distinct humans over the relay). Not yet wired — the
  // relay matchmaking handshake is the next milestone; for now this is a documented
  // stub so the UI can surface the lane without faking a second human.
  const findMatch = useCallback(() => {
    console.info(
      "[world-canvas] PvP find-match over the relay is coming soon; " +
        "use Auto OFF to take the wheel against the seat-B bot for now.",
    );
  }, []);

  // Open the single tunnel on mount with two distinct funded seat bots; tear it down on
  // unmount. Default Auto ON ⇒ both bots paint immediately (live TPS from the first
  // frame). React StrictMode's double-mount is guarded by `identitiesRef` + the
  // `runRef.current` check, so only one tunnel is ever opened; each open also pre-selects
  // its stake coin (see startRun), so a stray concurrent open can't equivocate the faucet.
  useEffect(() => {
    if (!identitiesRef.current) {
      identitiesRef.current = { a: makeIdentity(), b: makeIdentity() };
    }
    if (!runRef.current) {
      const identities = identitiesRef.current;
      // ONE create_and_fund funds BOTH seats; selfPlay co-signs both. No winner, no
      // stake shift — collaborative free/draw.
      void startRun(false);
      // Two distinct funded seat bots paint the one tunnel (seat A idles when you hold
      // the wheel — see paintFrame). Display painters differ from `humanAddress` so the
      // seat-A bot's strokes render (the human's own seat-A cells render from the live
      // pointer path instead).
      startSeatBot({
        seat: "A",
        painter: identities.a.address,
        label: "Bot A",
        tint: TINT_BOT_A,
      });
      startSeatBot({
        seat: "B",
        painter: identities.b.address,
        label: "Bot B",
        tint: TINT_BOT_B,
      });
      syncAgentMarkers();
      // Start the single rAF loop that paints BOTH bots on the render cadence.
      if (agentRafRef.current === null) {
        agentRafRef.current = requestAnimationFrame(paintFrame);
      }
    }
    return () => {
      if (agentRafRef.current !== null) {
        cancelAnimationFrame(agentRafRef.current);
        agentRafRef.current = null;
      }
      agentStatesRef.current.clear();
      if (redrawTimerRef.current !== null) {
        clearTimeout(redrawTimerRef.current);
        redrawTimerRef.current = null;
      }
      if (humanStrokeTimerRef.current !== null) {
        clearTimeout(humanStrokeTimerRef.current);
        humanStrokeTimerRef.current = null;
      }
      for (const t of botActivityTimersRef.current.values()) clearTimeout(t);
      botActivityTimersRef.current.clear();
      const run = runRef.current;
      if (run) {
        flushHeartbeat(run, true);
        run.closed = true;
      }
      runRef.current = null;
    };
  }, [startRun, startSeatBot, syncAgentMarkers, flushHeartbeat, paintFrame]);

  return {
    status,
    paints: paintsRef.current,
    revision,
    game,
    movesThisGame: movesThisGameRef.current,
    movesPerGame: movesPerGameRef.current,
    auto,
    toggleAuto,
    setAuto,
    pauseAgents,
    resumeAgents,
    agents,
    focus,
    painters: paintersRef.current,
    activity: activityRef.current,
    humanAddress,
    agentSpeed,
    setAgentSpeed,
    agentMode,
    setAgentMode,
    agentDensity,
    setAgentDensity,
    agentTemplate,
    setAgentTemplate,
    submitHumanPaint,
    viewNextAgent,
    focusOnAgent,
    findMatch,
  };
}
