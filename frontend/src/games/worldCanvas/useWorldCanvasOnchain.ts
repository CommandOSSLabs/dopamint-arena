/**
 * useWorldCanvasOnchain — runs "The World is Your Canvas" as a COLLABORATIVE,
 * APPEND-ONLY paint stream over strictly-2-party OffchainTunnels, so every painted
 * cell becomes a real co-signed move (TPS on the dashboard under "world-canvas").
 * It mirrors the proven battleship vs-bot on-chain path
 * ({@link makeKeypairSponsoredSignExec} + {@link withSponsorFallback} +
 * `core.OffchainTunnel.selfPlay`), transposed from a finite duel to an endless,
 * winner-less wall: no turns, no winner, no stake shift — balances lock at open and
 * return in full at every cooperative close (free/draw).
 *
 * TWO DISTINCT FUNDED PAINTERS PER TUNNEL — the corrected arena shape. A tunnel's
 * party_a != party_b are two separate DOPAMINT-funded seats, and BOTH author on it:
 *   - the HUMAN wall is ONE shared tunnel {a: bots.x, b: bots.o}. Seat A is the
 *     human (submitHumanPaint); seat B is bots.o — a DISTINCT funded bot (the
 *     "Wall Bot") that co-paints the SAME tunnel. create_and_fund funds both seats.
 *   - each Self-play SPAWN opens ONE fresh shared tunnel painted by TWO distinct
 *     funded bots — seat A + seat B — both authoring (bot-vs-bot collaboration).
 * More spawns ⇒ more shared tunnels ⇒ more independent co-signing pairs ⇒ more TPS.
 * Each tunnel keeps its OWN action counter + throttled `flushHeartbeat`; the
 * dashboard readouts AGGREGATE across tunnels with no double-counting — one action
 * is booked per `r.verified` step per tunnel.
 *
 * The paint → co-signed-move path (one paint = one co-signed move = ~1 TPS):
 *   submitHumanPaint (seat A) / a bot's tickAgent (its seat)
 *     → submitPaint(runKey, move, seat, painter)   // routes to the shared run
 *     → run.tunnel.step(move, seat, ...)           // selfPlay co-signs BOTH seats
 *     → r.verified                                  // both signatures check (TPS gate)
 *     → run.moveCount++ + paint the cell + book the painter + bump the global total
 *     → flushHeartbeat(run, ≤1/s)                  // coarse throughput report per tunnel
 * The WorldCanvasProtocol folds each paint into a 32-byte rolling digest, so the
 * co-signed state hash strictly changes on every paint — no no-op is possible.
 * OVERPAINT is legal: re-painting a cell is a full co-signed move whose owner/color
 * updates to the latest painter.
 *
 * Periodic on-chain CHECKPOINT: every CHECKPOINT_EVERY co-signed paints a real
 * tunnel cooperatively closes (anchoring its transcript root via
 * close_cooperative_with_root — the same free/draw settle every game uses; stakes
 * return, NO winner) and a fresh tunnel reopens so painting never stops.
 *
 * Opening tries the gas SPONSOR first, so every seat (incl. fresh bot keys with ZERO
 * SUI) opens for free, faucet-minting its DOPAMINT stake:
 *   - SPONSORED → on-chain (default): the settler wraps `create_and_fund` in its own
 *     SIP-58 gas; the painters only co-sign.
 *   - SENDER-PAYS fallback: sponsor unreachable AND the opener holds gas.
 *   - DEMO (last resort): if both on-chain paths fail, a synthetic (valid 32-byte)
 *     tunnelId with the SAME local co-signing + heartbeat TPS (no chain, can't crash).
 *
 * Painting never blocks on the chain: paints co-sign the instant the tunnel object
 * exists, and pre-open paints buffer then replay in order.
 *
 * Bots don't paint noise: each is handed an INTELLIGENCE (mode) and SPEED, plus a
 * fresh non-overlapping world region it walks cell-by-cell — each cell one co-signed
 * move. The only "score" is a per-painter tally of who painted the most cells —
 * DISPLAY ONLY, no money, no winner. The hook tracks per-cell ownership, per-painter
 * tallies, and a recent-activity ring for the HUD/leaderboard.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, proof } from "sui-tunnel-ts";
import {
  WorldCanvasProtocol,
  type WorldCanvasState,
  type WorldCanvasMove,
} from "sui-tunnel-ts/protocol/worldCanvas";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "@/backend/controlPlane";
import {
  buildCreateAndFundTx,
  buildSettleWithRootTx,
  parseTunnelId,
} from "@/games/ticTacToe/app/lib/tunnel";
import { settleViaBackend } from "@/backend/settle";
import {
  isDopamintConfigured,
  ensureDopamintStakeCoin,
  DOPAMINT_COIN_TYPE,
} from "@/onchain/dopamint";
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
import { WC } from "./ui/tokens";

export type { AgentModeId } from "./designs";

/** Cells per chunk edge — MUST match the WorldCanvasProtocol so a paint legal in
 *  the UI is legal in the co-signing tunnel. */
const CHUNK_SIZE = 256;
/** Palette size; a paint's color is in [0, NUM_COLORS). */
const NUM_COLORS = 16;
/** SUI-fallback per-seat stake (MIST) when DOPAMINT env is unset. Collaborative free
 *  mode never shifts balances, so any close is a draw (each seat keeps its stake). */
const STAKE = 1n;
/** DOPAMINT per-seat stake (1 token, 9 decimals) — the default on-chain path (ADR-0010):
 *  faucet-minted, so painters need ZERO SUI; only gas is sponsored. Mirrors the other games. */
const DOPAMINT_STAKE_PER_SEAT = 1_000_000_000n;
/** Dashboard game key (groups TPS/tunnels under "world-canvas"). */
const GAME = "world-canvas";
/** Soft cap on retained painted cells; oldest are evicted so an endless wall keeps
 *  constant memory (the render layer does its own viewport culling). */
const MAX_RETAINED_CELLS = 200_000;
/** Recent-activity ring length (newest paints kept for the activity feed). */
const MAX_ACTIVITY = 60;
/** Co-signed paints per tunnel between on-chain checkpoints. At each boundary the
 *  tunnel cooperatively closes (anchoring its transcript root on-chain, like every
 *  finite game's settle) and a fresh tunnel reopens so painting never stops. Only
 *  real (on-chain) tunnels checkpoint; demo tunnels skip it (no chain). */
const CHECKPOINT_EVERY = 600;
/** Gap (cells) between adjacent agent regions so their art never touches. */
const REGION_GAP = 14;
/** World slot size (cells) — sized to the LARGEST mode footprint so any mode fits a
 *  slot on the shared spiral lattice and regions never overlap regardless of mode. */
const SLOT_W = MAX_FOOTPRINT_W + REGION_GAP;
const SLOT_H = MAX_FOOTPRINT_H + REGION_GAP;
/** Seed base for per-region PRNGs (mixed with the region index for varied art). */
const REGION_SEED = 0x9e3779b9;
/** Endless modes (flow / scribble) never finish on their own; relocate once a region
 *  has co-signed this multiple of its footprint area so the bot keeps spreading. */
const REGION_FILL_FACTOR = 1.3;
/** Fit box (cells) an Artist agent rasterizes a chosen template into — kept under the
 *  max mode footprint so a template region never overflows its spiral slot. */
const AGENT_TEMPLATE_W = MAX_FOOTPRINT_W - 8;
const AGENT_TEMPLATE_H = MAX_FOOTPRINT_H - 8;
/** Per-agent accent colors (leaderboard rows + on-canvas markers), cycled by number. */
const AGENT_TINTS = [
  "#CF6EE4",
  "#5fe3a1",
  "#f2c94c",
  "#ff8fb0",
  "#4DA2FF",
  "#ffae5d",
] as const;

export type Seat = "A" | "B";

// Serialize on-chain opens across ALL painters (human + agents) and React StrictMode's
// double-mount. Each open faucet-mints from the SHARED DOPAMINT object; minting from it
// concurrently makes validators reject the losers as equivocation ("object already
// locked"). Off-chain co-signing (the TPS) stays fully parallel — only the rare open
// tx is queued. Module-global so it spans hook re-instantiations.
let onchainOpenChain: Promise<unknown> = Promise.resolve();
function serializeOnchainOpen<T>(fn: () => Promise<T>): Promise<T> {
  const run = onchainOpenChain.catch(() => {}).then(fn);
  onchainOpenChain = run.catch(() => {});
  return run;
}

/** Agent acceleration MULTIPLIER — the headline "tăng tốc" dial. Each tier is an
 *  explicit ×N on the agent's co-signed cells/sec (x1 baseline → x8 burst). */
export type AgentSpeed = "x1" | "x2" | "x4" | "x8";

/** ms between an agent's co-signed paint TICKS, per multiplier. Pure 1/N scaling of
 *  the base tick interval, so the named ×N is literally the cells/sec multiplier:
 *  per-agent TPS = batch × 1000/interval, batch is speed-independent (see agentBatch).
 *  x1 = base (~8 ticks/s), x8 = 8× (~66 ticks/s) — a clear burst. */
const AGENT_SPEED_INTERVALS: Record<AgentSpeed, number> = {
  x1: 120,
  x2: 60,
  x4: 30,
  x8: 15,
};
/** The acceleration tiers, in ramp order — the source for the Speed pills/menu. */
export const AGENT_SPEEDS: readonly AgentSpeed[] = ["x1", "x2", "x4", "x8"];

/** Base cells co-signed per tick, by a mode's density class — the dense↔sparse TPS
 *  spread. Scaled by the speed tier and the user Density lever, then clamped. */
const DENSITY_BATCH: Record<AgentDensity, number> = {
  sparse: 1,
  medium: 3,
  dense: 6,
};
/** Hard ceiling on cells co-signed in a single tick, so even dense×3 stays bounded
 *  (paints still rAF-coalesce + evict). Each batched cell is one independent verified
 *  co-signed move — booked once, never double-counted. */
const BATCH_CAP = 12;
/** User Density lever range (mirrors the human brush-size selector): a TPS multiplier. */
const DENSITY_LEVELS = [1, 2, 3] as const;
const DEFAULT_DENSITY = 1;

/**
 * Cells an agent co-signs THIS tick: `density(mode) × userDensity`, clamped to
 * `[1, BATCH_CAP]`. Speed is deliberately NOT a factor here — the Speed multiplier
 * scales the TICK RATE (interval) instead, so x1/x2/x4/x8 stays an honest ×N on
 * cells/sec rather than compounding with batch. Dense modes (flow / wash / grid)
 * burst; sparse modes (stipple / calligraphy) sip — the Intelligence pill is the
 * per-tick TPS dial, Density the per-tick multiplier, Speed the tick-rate multiplier.
 */
function agentBatch(modeId: AgentModeId, userDensity: number): number {
  const base = DENSITY_BATCH[AGENT_MODES[modeId].density] * userDensity;
  return Math.max(1, Math.min(BATCH_CAP, Math.round(base)));
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
  /** Address of the CURRENT painter of this cell (updates on every overpaint). */
  painter: string;
}

/** Running tally for one painter (the human or one agent), keyed by address. */
export interface PainterInfo {
  address: string;
  /** "You" for the human, "Agent #n" for a bot. */
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

/** A live agent's location, surfaced so the canvas can mark + jump to it. */
export interface AgentMarker {
  id: string;
  /** "Agent #n". */
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

/** A camera-jump request: center this global-pixel point; `seq` bumps per request. */
export interface CanvasFocus {
  gx: number;
  gy: number;
  seq: number;
}

/** On-chain progress surfaced to the canvas HUD (driven by the HUMAN's tunnel; the
 *  `movesCoSigned` count is the AGGREGATE across every painter's tunnel). */
export interface WorldCanvasOnchainStatus {
  phase: WorldCanvasPhase;
  /** The human tunnel's id, or a synthetic demo id when running off-chain. */
  tunnelId: string | null;
  /** True once the human tunnel opened on-chain (vs. the demo fallback). */
  onchain: boolean;
  /** Total co-signed paints across ALL tunnels this run (the TPS numerator). */
  movesCoSigned: number;
  /** `create_and_fund` digest of the human tunnel (on-chain path only). */
  openDigest: string | null;
  error: string | null;
}

export interface UseWorldCanvasOnchain {
  status: WorldCanvasOnchainStatus;
  /** Live canvas: stable Map identity, mutated in place; re-read on `revision` bumps. */
  paints: ReadonlyMap<string, PaintedCell>;
  /** Bumps (rAF-throttled) whenever the canvas changes, so consumers redraw. */
  revision: number;
  /** Number of SPAWNED autonomous bots currently painting — each Self-play spawn opens
   *  one shared tunnel and adds two (seat A + seat B). Excludes the human wall's
   *  permanent seat-B co-author ("Wall Bot"), which is always present, not spawn/stop. */
  agentCount: number;
  /** Live agent locations (markers + the "knows where it's drawing" label). */
  agents: AgentMarker[];
  /** Latest camera-jump request; null until first spawn / view. */
  focus: CanvasFocus | null;
  /** Per-painter tallies, keyed by address (stable identity; re-read on `revision`). */
  painters: ReadonlyMap<string, PainterInfo>;
  /** Recent-activity ring, oldest→newest (stable identity; re-read on `revision`). */
  activity: ReadonlyArray<ActivityEntry>;
  /** The human's address (so the UI can label the human's own cells "You"). */
  humanAddress: string;
  /** Current agent SPEED (applied to newly spawned + live agents). */
  agentSpeed: AgentSpeed;
  /** Set the agent paint speed; updates new spawns AND running agents. */
  setAgentSpeed(speed: AgentSpeed): void;
  /** Current agent INTELLIGENCE (applied to newly spawned + live agents). */
  agentMode: AgentModeId;
  /** Set the agent drawing mode; updates new spawns AND running agents (next region). */
  setAgentMode(mode: AgentModeId): void;
  /** Current agent DENSITY lever (1/2/3) — a per-tick batch multiplier (TPS burst). */
  agentDensity: number;
  /** Set the agent density lever; applies live to every running agent's next tick. */
  setAgentDensity(level: number): void;
  /** Template id an Artist agent stamps at each region, or null to lay the flag rotation. */
  agentTemplate: string | null;
  /** Pick the Artist agent's template (or null for flags); applies at the next region. */
  setAgentTemplate(id: string | null): void;
  /** Paint one cell as the human (seat A) → one co-signed move on the human tunnel. */
  submitHumanPaint(
    cx: bigint,
    cy: bigint,
    x: number,
    y: number,
    color: number,
  ): void;
  /** Spawn a fresh SHARED tunnel painted by TWO distinct funded bots (seat A + seat B),
   *  both authoring forever — every cell a co-signed move. */
  spawnAgent(): void;
  /** Stop every SPAWNED bot-vs-bot tunnel; the human wall + its seat-B co-author keep painting. */
  stopAgents(): void;
  /** Re-center the camera on the live agent painting at `painter` (the 📍 button). */
  focusOnAgent(painter: string): void;
  /** Cycle the camera to the next active agent (the "View Agent" button). */
  viewNextAgent(): void;
}

/** Stable cell key for the live canvas map. */
export function cellKey(cx: bigint, cy: bigint, x: number, y: number): string {
  return `${cx}:${cy}:${x}:${y}`;
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
 * down with growing leg lengths). Flag regions are laid on this spiral so they
 * cluster near the world origin (watchable) yet never overlap.
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

/** Mint a throwaway party identity for a fresh self-play tunnel — a new ed25519 key
 *  that needs ZERO SUI (the gas sponsor pays; the keypair only co-signs paints). */
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

/** One shared 2-party tunnel + its heartbeat/session bookkeeping. Both seats are
 *  DISTINCT funded painters that BOTH author on it (no dead co-signer). */
interface CanvasRun {
  /** runsRef key: the human wall = humanAddress (= seat-A address); a spawned
   *  bot-vs-bot tunnel = its seat-A address. */
  key: string;
  isHuman: boolean;
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
  /** Co-signed paints on THIS tunnel (nonce + this tunnel's heartbeat numerator). */
  moveCount: number;
  /** Actions since this tunnel's last heartbeat flush (reset to 0 on send). */
  actions: number;
  lastHeartbeat: number;
  /** Accumulates every co-signed update; its Merkle root is anchored at each checkpoint. */
  transcript: proof.Transcript | null;
  /** moveCount at the last on-chain checkpoint (close-and-reopen anchors the root). */
  lastCheckpoint: number;
  /** True while a checkpoint close is in flight, so paints don't trigger a second. */
  checkpointing: boolean;
  /** Staked token type (DOPAMINT, or undefined = SUI); the checkpoint close needs it. */
  coinType?: string;
}

/** A live bot streaming one mode's strokes across a world region as ONE seat of a
 *  shared 2-party tunnel. Two AgentStates (seat A + seat B) can author on one runKey. */
interface AgentState {
  id: string;
  num: number;
  /** Which SHARED tunnel/CanvasRun (a runsRef key) this bot co-signs its paints on. */
  runKey: string;
  /** The seat this bot authors as on `runKey` (its distinct funded identity). */
  seat: Seat;
  /** This bot's OWN funded painter address (the seat-`seat` identity on `runKey`). */
  painter: string;
  /** True for the human wall's permanent seat-B co-author ("Wall Bot"): it shares the
   *  human tunnel, so stopAgents leaves it running and it's hidden from the spawn/stop
   *  agent count + on-canvas markers (it's intrinsic to the wall, not a spawn). */
  onHumanWall: boolean;
  label: string;
  tint: string;
  /** Captured at spawn, live-updatable: paint interval tier + drawing intelligence. */
  speed: AgentSpeed;
  mode: AgentModeId;
  /** Lazy cell stream for the CURRENT region (the mode's stroke generator). */
  iter: Iterator<DesignCell>;
  /** Label shown on the marker for the current region (the mode's name). */
  regionName: string;
  /** Current region footprint height in cells (anchors the marker above the art). */
  footprintH: number;
  /** Top-left global-pixel origin of the current region. */
  originGx: number;
  originGy: number;
  /** Global-pixel center of the current region (camera/marker anchor). */
  centerGx: number;
  centerGy: number;
  /** Cells co-signed in the current region so far (drives the endless-mode relocate). */
  painted: number;
  /** Soft cap: relocate once `painted` reaches this (bounds endless modes per region). */
  maxCells: number;
  /** Self-rescheduling paint timer (a setTimeout chain, so speed can change live). */
  timer: ReturnType<typeof setTimeout>;
}

const EMPTY_STATUS: WorldCanvasOnchainStatus = {
  phase: "idle",
  tunnelId: null,
  onchain: false,
  movesCoSigned: 0,
  openDigest: null,
  error: null,
};

export function useWorldCanvasOnchain(): UseWorldCanvasOnchain {
  const bots = useMemo(() => loadOrCreateBots(), []);
  const client = useMemo(() => getSuiClient(), []);
  const humanAddress = bots.x.address;
  // One protocol instance shared by every co-signing tunnel.
  const proto = useMemo(
    () => new WorldCanvasProtocol({ chunkSize: CHUNK_SIZE, numColors: NUM_COLORS }),
    [],
  );

  const [status, setStatus] = useState<WorldCanvasOnchainStatus>(EMPTY_STATUS);
  const [revision, setRevision] = useState(0);
  const [agentCount, setAgentCount] = useState(0);
  const [agents, setAgents] = useState<AgentMarker[]>([]);
  const [focus, setFocus] = useState<CanvasFocus | null>(null);
  const [agentSpeed, setAgentSpeedState] = useState<AgentSpeed>("x1");
  const [agentMode, setAgentModeState] = useState<AgentModeId>(DEFAULT_AGENT_MODE);
  const [agentDensity, setAgentDensityState] = useState<number>(DEFAULT_DENSITY);
  const [agentTemplate, setAgentTemplateState] = useState<string | null>(null);

  // One tunnel per painter, keyed by painter address (human + each agent).
  const runsRef = useRef<Map<string, CanvasRun>>(new Map());
  // Aggregate co-signed paints across ALL tunnels (the dashboard numerator).
  const totalMovesRef = useRef(0);
  // Live canvas data: stable identity, mutated in place; React re-reads on `revision`.
  const paintsRef = useRef<Map<string, PaintedCell>>(new Map());
  // Per-painter tallies + recent-activity ring: same "mutate + bump revision" pattern.
  const paintersRef = useRef<Map<string, PainterInfo>>(new Map());
  const activityRef = useRef<ActivityEntry[]>([]);
  // Live agents and the placement/numbering counters.
  const agentStatesRef = useRef<Map<string, AgentState>>(new Map());
  const regionIndexRef = useRef(0);
  const agentNumRef = useRef(0);
  const focusSeqRef = useRef(0);
  // Round-robin cursor for the "View Agent" cycle button.
  const viewCursorRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  // Current speed/mode for new spawns, mirrored into refs so the paint loop can read
  // them without re-subscribing.
  const agentSpeedRef = useRef<AgentSpeed>("x1");
  const agentModeRef = useRef<AgentModeId>(DEFAULT_AGENT_MODE);
  // The Density lever is global (a TPS dial), read live by the paint loop.
  const agentDensityRef = useRef<number>(DEFAULT_DENSITY);
  // Artist agents' chosen template (null = the built-in flag rotation), read live by
  // nextPlacement so a template switch lands on each agent's next region.
  const agentTemplateRef = useRef<string | null>(null);

  // Throttle paint-driven React updates to ~8 Hz. The canvas redraws every frame from
  // refs (stays smooth); only the React panels/HUD bump here — a per-frame bump
  // re-rendered that subtree 60×/s and was the main lag source.
  const REDRAW_THROTTLE_MS = 120;
  const scheduleRedraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.setTimeout(() => {
      rafRef.current = null;
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
  // `seq` is the GLOBAL aggregate sequence so activity entries stay strictly ordered
  // across tunnels (the ring is keyed by it).
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
          tint: isHuman ? WC.seatA : WC.seatB,
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

  // Coarse PER-TUNNEL throughput report — one call per ~1s window, never per paint.
  // Each tunnel flushes independently, so counts never double-report across tunnels.
  const flushHeartbeat = useCallback((run: CanvasRun, force: boolean) => {
    const s = run.session;
    if (!s || run.actions === 0) return;
    const now = Date.now();
    const windowMs = now - run.lastHeartbeat;
    if (!force && windowMs < 1000) return;
    const actionsDelta = run.actions;
    run.actions = 0;
    run.lastHeartbeat = now;
    getControlPlaneClient()
      .sendHeartbeat(s.sessionId, s.statsToken, {
        tunnelId: run.tunnelId,
        nonce: String(run.moveCount),
        actionsDelta,
        windowMs: Math.max(1, windowMs),
      })
      .catch((e) => console.error("[world-canvas] heartbeat failed:", e));
  }, []);

  // Co-sign one paint through a painter's tunnel; count only honest, both-signature-
  // VERIFIED steps (the TPS gate). One verified step = one action on THIS tunnel and
  // one increment of the GLOBAL aggregate — never double-counted.
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
        run.actions += 1;
        totalMovesRef.current += 1;
        paintCell(mv, by, totalMovesRef.current, painter);
        recordPaint(painter, mv, totalMovesRef.current);
        flushHeartbeat(run, false);
        // On a real tunnel, anchor the transcript root on-chain every CHECKPOINT_EVERY
        // co-signed paints (cooperative close-and-reopen). Demo tunnels never do this.
        if (
          run.onchain &&
          !run.checkpointing &&
          run.moveCount - run.lastCheckpoint >= CHECKPOINT_EVERY
        ) {
          checkpointRef.current?.(run);
        }
      } catch (e) {
        console.warn("[world-canvas] tunnel step skipped:", e);
      }
    },
    [paintCell, recordPaint, flushHeartbeat],
  );

  // The paint sink: route to the painter's run and co-sign once its tunnel exists,
  // else buffer (preserving order) until `startRun` drains it.
  const submitPaint = useCallback(
    (runKey: string, mv: WorldCanvasMove, by: Seat, painter: string) => {
      const run = runsRef.current.get(runKey);
      if (!run || run.closed) return;
      if (!run.ready || !run.tunnel) {
        run.buffer.push({ mv, by, painter });
        return;
      }
      coSignPaint(run, mv, by, painter);
    },
    [coSignPaint],
  );

  // Open ONE shared 2-party tunnel: try an on-chain sponsored open, else fall to demo.
  // The selfPlay tunnel is built with the FINAL id (real or demo) so its co-signatures
  // match; buffered paints replay in order once it is live. Only the HUMAN tunnel
  // drives the HUD status chip; spawned tunnels open quietly in the background.
  const startRun = useCallback(
    async (
      key: string,
      identities: { a: BotIdentity; b: BotIdentity },
      isHuman: boolean,
      // True when reopening after a checkpoint close: the HUD is already live, so skip
      // the "opening…"/phase resets that would otherwise flicker the human's chip.
      reopen = false,
    ) => {
      if (isHuman) registerPainter(key, "You", false, WC.seatA);

      const run: CanvasRun = {
        key,
        isHuman,
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
      runsRef.current.set(key, run);
      if (isHuman && !reopen) setStatus({ ...EMPTY_STATUS, phase: "opening" });

      const partyX = {
        address: identities.a.address,
        publicKey: identities.a.publicKey,
      };
      const partyO = {
        address: identities.b.address,
        publicKey: identities.b.publicKey,
      };

      // DOPAMINT mode (ADR-0010, the default): stake FREE faucet-minted DOPAMINT and
      // sponsor the painter's open gas, so it needs ZERO SUI — exactly how the finite
      // games (tic-tac-toe, battleship, …) open. A sponsored tx can't reference `tx.gas`,
      // so the stake MUST come from a `stakeCoinId` (not the SUI gas-coin fallback).
      // SUI fallback (DOPAMINT env unset): the painter funds the stakes from its own gas.
      const dopamintOn = isDopamintConfigured;
      const coinType = dopamintOn ? DOPAMINT_COIN_TYPE : undefined;
      const stakePerSeat = dopamintOn ? DOPAMINT_STAKE_PER_SEAT : STAKE;
      run.coinType = coinType;

      try {
        await serializeOnchainOpen(async () => {
        const sponsoredSignExec = makeKeypairSponsoredSignExec({
          address: identities.a.address,
          keypair: identities.a.keypair,
          client: client as never,
        });
        let createDigest: string;
        if (dopamintOn) {
          // Self-play funds BOTH seats from one coin → faucet/select for the 2-seat total.
          const stakeCoinId = await ensureDopamintStakeCoin({
            client: client as never,
            signExec: sponsoredSignExec,
            owner: identities.a.address,
            need: 2n * stakePerSeat,
          });
          ({ digest: createDigest } = await sponsoredSignExec(
            buildCreateAndFundTx(partyX, partyO, stakePerSeat, {
              coinType,
              stakeCoinId,
            }),
          ));
        } else {
          ({ digest: createDigest } = await withSponsorFallback(
            () => sponsoredSignExec(buildCreateAndFundTx(partyX, partyO, stakePerSeat)),
            () =>
              submit(
                buildCreateAndFundTx(partyX, partyO, stakePerSeat),
                identities.a.keypair,
              ),
            "world-canvas open/fund",
          ));
        }
        const createTxb = await client.getTransactionBlock({
          digest: createDigest,
          options: { showObjectChanges: true },
        });
        const realId = parseTunnelId(createTxb.objectChanges);
        if (realId) {
          run.tunnelId = realId;
          run.onchain = true;
          const obj = await client.getObject({
            id: realId,
            options: { showContent: true },
          });
          const fields = (
            obj.data?.content as { fields?: Record<string, unknown> } | undefined
          )?.fields;
          run.createdAt = BigInt((fields?.created_at as string | undefined) ?? 0);
          if (isHuman) setStatus((s) => ({ ...s, openDigest: createDigest }));
        }
        });
      } catch (e) {
        console.warn(
          "[world-canvas] on-chain open failed — running off-chain demo:",
          e,
        );
      }

      // If the run was torn down while opening (unmount/stop), don't bring up a tunnel.
      if (run.closed) return;

      // Build the local co-signing tunnel with the final id. selfPlay holds BOTH seats'
      // keypairs, so each paint co-signs both distinct funded parties locally.
      const tunnel = core.OffchainTunnel.selfPlay<WorldCanvasState, WorldCanvasMove>(
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

      // Register THIS tunnel for stats tracking. Best-effort (never blocks painting).
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
        .catch((e) => console.error("[world-canvas] registerSession failed:", e));

      // Tunnel is live: drain any paints buffered during the open, then continue.
      run.ready = true;
      const buffered = run.buffer;
      run.buffer = [];
      for (const { mv, by, painter } of buffered) coSignPaint(run, mv, by, painter);

      if (isHuman && !reopen) {
        setStatus((s) => ({
          ...s,
          phase: run.onchain ? "open" : "demo",
          tunnelId: run.tunnelId,
          onchain: run.onchain,
          movesCoSigned: totalMovesRef.current,
        }));
      }
    },
    [client, proto, submit, coSignPaint, registerPainter],
  );

  // Checkpoint a tunnel on-chain: cooperatively close it (anchoring its transcript
  // root via the SAME backend `/settle` path every finite game uses), then reopen a
  // fresh tunnel for the painter so painting continues seamlessly. The reopen is
  // synchronous up to its `runsRef.set`, so paints route to the new tunnel with no
  // gap (buffered until it is live). On-chain only; demo runs never reach here.
  const checkpointRef = useRef<((run: CanvasRun) => void) | null>(null);
  const checkpointRun = useCallback(
    async (run: CanvasRun) => {
      if (
        run.checkpointing ||
        run.closed ||
        !run.onchain ||
        !run.tunnel ||
        !run.transcript
      )
        return;
      run.checkpointing = true;
      const { tunnel, transcript } = run;
      let settlement: core.CoSignedSettlementWithRoot;
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
      // Retire the old tunnel and reopen immediately so paints keep flowing, then
      // anchor the closed tunnel's root on-chain in the background.
      run.closed = true;
      void startRun(run.key, run.identities, run.isHuman, true);
      const sponsoredClose = makeKeypairSponsoredSignExec({
        address: run.identities.a.address,
        keypair: run.identities.a.keypair,
        client: client as never,
      });
      try {
        await settleViaBackend({
          tunnelId: run.tunnelId,
          settlement,
          transcript: transcript.toRecord().entries,
          label: "world-canvas",
          fallbackClose: async () => {
            const { digest } = await sponsoredClose(
              buildSettleWithRootTx(run.tunnelId, settlement, run.coinType),
            );
            await client.waitForTransaction({ digest });
            return digest;
          },
        });
      } catch (e) {
        console.warn("[world-canvas] checkpoint settle failed:", e);
      }
    },
    [client, startRun],
  );
  checkpointRef.current = checkpointRun;

  // Public: the human paints seat A on the HUMAN tunnel; one cell = one co-signed move.
  const submitHumanPaint = useCallback(
    (cx: bigint, cy: bigint, x: number, y: number, color: number) => {
      submitPaint(humanAddress, { cx, cy, x, y, color }, "A", humanAddress);
    },
    [submitPaint, humanAddress],
  );

  // Allocate the next region for an agent: a fresh stroke stream (per the given mode)
  // on a non-overlapping spiral slot, sized from the mode's own footprint. Each region
  // is seeded by its index so its art is varied yet reproducible.
  const nextPlacement = useCallback((modeId: AgentModeId) => {
    const i = regionIndexRef.current++;

    // Artist mode with a chosen template: stamp the rasterized template's cells (in
    // reveal order) instead of the flag rotation. The template is fit into a box under
    // the max mode footprint, so its region still drops on the shared slot lattice and
    // never overlaps a neighbour. Each cell is still one co-signed move.
    const tplId = modeId === "artist" ? agentTemplateRef.current : null;
    const tpl = tplId ? TEMPLATES_BY_ID[tplId] : undefined;
    if (tpl) {
      const scale = fitScale(tpl.aspect, AGENT_TEMPLATE_W, AGENT_TEMPLATE_H);
      const rast = rasterizeTemplate(tpl, scale);
      const fw = Math.max(1, rast.width);
      const fh = Math.max(1, rast.height);
      const { col, row } = spiralSlot(i);
      const originGx = Math.round(col * SLOT_W - fw / 2);
      const originGy = Math.round(row * SLOT_H - fh / 2);
      return {
        iter: rast.cells[Symbol.iterator]() as Iterator<DesignCell>,
        regionName: tpl.name,
        footprintH: fh,
        maxCells: Math.max(1, rast.cells.length),
        originGx,
        originGy,
        centerGx: originGx + fw / 2,
        centerGy: originGy + fh / 2,
      };
    }

    const mode = AGENT_MODES[modeId];
    const fw = mode.footprint.width;
    const fh = mode.footprint.height;
    const iter = mode.strokes({
      width: fw,
      height: fh,
      rng: mulberry32(REGION_SEED ^ Math.imul(i + 1, 2654435761)),
      numColors: NUM_COLORS,
      index: i,
    });
    const { col, row } = spiralSlot(i);
    const originGx = Math.round(col * SLOT_W - fw / 2);
    const originGy = Math.round(row * SLOT_H - fh / 2);
    return {
      iter,
      regionName: mode.label,
      footprintH: fh,
      maxCells: Math.round(fw * fh * REGION_FILL_FACTOR),
      originGx,
      originGy,
      centerGx: originGx + fw / 2,
      centerGy: originGy + fh / 2,
    };
  }, []);

  // Publish the live SPAWNED-bot locations (markers) from the internal agent states.
  // The human wall's seat-B co-author is intrinsic to the wall (not a spawn), so it's
  // excluded here — its co-painting still shows via the cells it lays + the leaderboard.
  const syncAgentMarkers = useCallback(() => {
    setAgents(
      [...agentStatesRef.current.values()]
        .filter((s) => !s.onHumanWall)
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

  // One paint tick for an agent: pull a clamped BATCH of cells from its mode's stream
  // and co-sign each (one verified step = one action = one TPS, never double-counted).
  // The batch size is `density(mode) × Density-lever`; the Speed multiplier scales the
  // tick RATE (reschedule interval) instead, so x1/x2/x4/x8 is an honest ×N on cells/sec.
  // Dense modes burst and sparse modes sip at the same Speed. When the stream ends
  // (finite mode) or the region
  // cap is hit (endless mode), relocate to a fresh region and read the live `mode`/footprint
  // there — so a live mode change applies cleanly on the agent's next region. Then it
  // self-reschedules at its CURRENT speed (a live speed change lands on the next tick).
  const tickAgent = useCallback(
    function tick(id: string) {
      const st = agentStatesRef.current.get(id);
      if (!st) return; // agent stopped/removed → the timer chain ends here
      const run = runsRef.current.get(st.runKey);
      if (run && !run.closed && run.ready && run.tunnel) {
        const batch = agentBatch(st.mode, agentDensityRef.current);
        for (let k = 0; k < batch; k++) {
          let cell: DesignCell | null = null;
          if (st.painted < st.maxCells) {
            const nx = st.iter.next();
            if (!nx.done) cell = nx.value;
          }
          if (cell === null) {
            // Stream exhausted (finite) or region cap reached (endless) → relocate.
            const next = nextPlacement(st.mode);
            st.iter = next.iter;
            st.regionName = next.regionName;
            st.footprintH = next.footprintH;
            st.maxCells = next.maxCells;
            st.originGx = next.originGx;
            st.originGy = next.originGy;
            st.centerGx = next.centerGx;
            st.centerGy = next.centerGy;
            st.painted = 0;
            if (!st.onHumanWall) syncAgentMarkers(); // hidden bot ⇒ no marker to move
            break; // the fresh region starts painting on the next tick
          }
          st.painted += 1;
          const mv = moveAtGlobal(
            st.originGx + cell.dx,
            st.originGy + cell.dy,
            cell.color,
          );
          submitPaint(st.runKey, mv, st.seat, st.painter);
        }
      }
      st.timer = setTimeout(() => tick(id), AGENT_SPEED_INTERVALS[st.speed]);
    },
    [nextPlacement, syncAgentMarkers, submitPaint],
  );

  // Bring up ONE autonomous painting bot on a SHARED tunnel: register it, give it a
  // starting region, and start its self-rescheduling paint timer. `runKey` selects which
  // tunnel/CanvasRun it co-signs on, `seat`/`painter` the distinct funded identity it
  // authors as — so two bots (seat A + seat B) can both author on one tunnel. The
  // `onHumanWall` bot is the human wall's permanent seat-B co-author (hidden from the
  // spawn/stop count + markers; the run itself is opened by the human's startRun).
  const startPaintingBot = useCallback(
    (params: {
      runKey: string;
      seat: Seat;
      painter: string;
      onHumanWall: boolean;
    }): AgentState => {
      let num: number;
      let label: string;
      let tint: string;
      if (params.onHumanWall) {
        num = 0;
        label = "Wall Bot"; // the human wall's permanent party-B co-author
        tint = WC.seatB; // party-B tint, matching the human wall's seat B
      } else {
        num = ++agentNumRef.current;
        label = `Agent #${num}`;
        tint = AGENT_TINTS[(num - 1) % AGENT_TINTS.length];
      }
      registerPainter(params.painter, label, true, tint);

      const speed = agentSpeedRef.current;
      const mode = agentModeRef.current;
      const place = nextPlacement(mode);
      const id = `bot_${num}_${params.seat}_${Date.now()}`;
      const st: AgentState = {
        id,
        num,
        runKey: params.runKey,
        seat: params.seat,
        painter: params.painter,
        onHumanWall: params.onHumanWall,
        label,
        tint,
        speed,
        mode,
        iter: place.iter,
        regionName: place.regionName,
        footprintH: place.footprintH,
        maxCells: place.maxCells,
        originGx: place.originGx,
        originGy: place.originGy,
        centerGx: place.centerGx,
        centerGy: place.centerGy,
        painted: 0,
        timer: setTimeout(() => tickAgent(id), AGENT_SPEED_INTERVALS[speed]),
      };
      agentStatesRef.current.set(id, st);
      return st;
    },
    [registerPainter, nextPlacement, tickAgent],
  );

  // Count only SPAWNED bots — the human wall's permanent seat-B co-author is always
  // present, so it's not part of the spawn/stop population the toolbar drives.
  const spawnedBotCount = useCallback(() => {
    let n = 0;
    for (const s of agentStatesRef.current.values()) if (!s.onHumanWall) n++;
    return n;
  }, []);

  // Public: spawn a fresh SHARED tunnel painted by TWO distinct funded bots — seat A and
  // seat B, both authoring (the battleship vs-bot pattern, transposed to the wall). Seat
  // A funds/opens the tunnel; both seats co-sign every paint. Each bot walks its design
  // one cell per tick (each a co-signed move on the shared tunnel) and relocates per
  // region. Spawning opens the tunnel and centers the camera on the seat-A region.
  const spawnAgent = useCallback(() => {
    const identities = { a: makeIdentity(), b: makeIdentity() };
    const runKey = identities.a.address; // seat-A address keys the shared run
    // Open the shared tunnel (sponsored, demo fallback). create_and_fund funds BOTH
    // seats; paints buffer until it is live, exactly like the human's wall.
    void startRun(runKey, identities, false);

    const seatA = startPaintingBot({
      runKey,
      seat: "A",
      painter: identities.a.address,
      onHumanWall: false,
    });
    startPaintingBot({
      runKey,
      seat: "B",
      painter: identities.b.address,
      onHumanWall: false,
    });

    syncAgentMarkers();
    setAgentCount(spawnedBotCount());
    // Jump the camera to the new tunnel's seat-A region so the user watches it draw.
    setFocus({
      gx: seatA.centerGx,
      gy: seatA.centerGy,
      seq: ++focusSeqRef.current,
    });
  }, [startRun, startPaintingBot, syncAgentMarkers, spawnedBotCount]);

  // Public: stop every SPAWNED bot — clear its timer AND tear down its shared tunnel
  // (force-flush the tail heartbeat, mark closed, drop the run; two bots share one
  // tunnel, so close each run exactly once). The human wall and its seat-B co-author are
  // untouched, so the human keeps painting; painter tallies are retained for the board.
  const stopAgents = useCallback(() => {
    const closedRuns = new Set<string>();
    const removeIds: string[] = [];
    for (const st of agentStatesRef.current.values()) {
      if (st.onHumanWall) continue; // the human wall's co-author stays
      clearTimeout(st.timer);
      removeIds.push(st.id);
      if (!closedRuns.has(st.runKey)) {
        closedRuns.add(st.runKey);
        const run = runsRef.current.get(st.runKey);
        if (run) {
          flushHeartbeat(run, true);
          run.closed = true;
          runsRef.current.delete(st.runKey);
        }
      }
    }
    for (const id of removeIds) agentStatesRef.current.delete(id);
    syncAgentMarkers();
    setAgentCount(spawnedBotCount());
  }, [flushHeartbeat, syncAgentMarkers, spawnedBotCount]);

  // Public: set the agent paint speed — for new spawns AND every running agent (the
  // self-rescheduling timer picks up the new interval on its next tick).
  const setAgentSpeed = useCallback((speed: AgentSpeed) => {
    agentSpeedRef.current = speed;
    setAgentSpeedState(speed);
    for (const st of agentStatesRef.current.values()) st.speed = speed;
  }, []);

  // Public: set the agent drawing intelligence — for new spawns AND every running
  // agent (each switches at its next region, so the current stream finishes cleanly).
  const setAgentMode = useCallback((mode: AgentModeId) => {
    agentModeRef.current = mode;
    setAgentModeState(mode);
    for (const st of agentStatesRef.current.values()) st.mode = mode;
  }, []);

  // Public: set the global Density lever (1/2/3) — a per-tick batch multiplier read
  // live by every running agent's next tick, so the TPS burst changes immediately.
  const setAgentDensity = useCallback((level: number) => {
    const clamped = Math.max(1, Math.min(DENSITY_LEVELS.length, Math.round(level)));
    agentDensityRef.current = clamped;
    setAgentDensityState(clamped);
  }, []);

  // Public: choose the Artist agent's template (or null for the flag rotation). Read
  // live by `nextPlacement`, so every running Artist agent switches at its next region.
  const setAgentTemplate = useCallback((id: string | null) => {
    agentTemplateRef.current = id;
    setAgentTemplateState(id);
  }, []);

  // Public: re-center the camera on the live spawned bot painting at `painter` (📍).
  const focusOnAgent = useCallback((painter: string) => {
    for (const st of agentStatesRef.current.values()) {
      if (st.onHumanWall) continue; // the wall co-author has no marker to focus
      if (st.painter === painter) {
        setFocus({
          gx: st.centerGx,
          gy: st.centerGy,
          seq: ++focusSeqRef.current,
        });
        return;
      }
    }
  }, []);

  // Public: cycle the camera through active SPAWNED bots ("View Agent" button).
  const viewNextAgent = useCallback(() => {
    const states = [...agentStatesRef.current.values()].filter(
      (s) => !s.onHumanWall,
    );
    if (states.length === 0) return;
    const idx = viewCursorRef.current % states.length;
    viewCursorRef.current = idx + 1;
    const st = states[idx];
    setFocus({ gx: st.centerGx, gy: st.centerGy, seq: ++focusSeqRef.current });
  }, []);

  // Open the HUMAN wall on mount; tear every tunnel (human + spawned) down on unmount.
  useEffect(() => {
    if (!runsRef.current.has(humanAddress)) {
      // The human wall is a real, strictly-2-party arena tunnel: seat A is the human
      // (submitHumanPaint), seat B is bots.o — a DISTINCT DOPAMINT-funded bot that
      // co-paints the SAME tunnel. create_and_fund funds both seats; every paint is
      // co-signed by both. No winner, no stake shift — collaborative free/draw.
      void startRun(humanAddress, { a: bots.x, b: bots.o }, true);
      startPaintingBot({
        runKey: humanAddress,
        seat: "B",
        painter: bots.o.address,
        onHumanWall: true,
      });
    }
    return () => {
      for (const s of agentStatesRef.current.values()) clearTimeout(s.timer);
      agentStatesRef.current.clear();
      if (rafRef.current !== null) clearTimeout(rafRef.current);
      for (const run of runsRef.current.values()) {
        flushHeartbeat(run, true);
        run.closed = true;
      }
      runsRef.current.clear();
    };
  }, [startRun, flushHeartbeat, humanAddress, bots, startPaintingBot]);

  return {
    status,
    paints: paintsRef.current,
    revision,
    agentCount,
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
    spawnAgent,
    stopAgents,
    focusOnAgent,
    viewNextAgent,
  };
}
