/**
 * useWorldCanvasOnchain — runs "The World is Your Canvas" over a HUB-AND-SPOKE set
 * of OffchainTunnels so every painted cell becomes real co-signed throughput (TPS
 * on the dashboard under "world-canvas"). It mirrors the proven pixel-duel on-chain
 * path ({@link makeKeypairSponsoredSignExec} + {@link withSponsorFallback} +
 * `core.OffchainTunnel.selfPlay`), but for a COLLABORATIVE, APPEND-ONLY paint
 * stream with no turns, no winner, and no settle — the wall just paints forever.
 *
 * ONE TUNNEL PER PAINTER. The arena tunnel is strictly 2-party, so each painter
 * owns a private self-play tunnel (its own A+B keypairs):
 *   - the HUMAN holds one tunnel (the persistent bot X/O pair); the human paints
 *     seat A on it.
 *   - EACH spawned Agent-AI opens its OWN tunnel (two freshly-minted keypairs) and
 *     paints seat B on it.
 * N agents ⇒ N+1 tunnels ⇒ more independent co-signing pairs ⇒ more TPS. Each
 * tunnel keeps its OWN action counter + throttled `flushHeartbeat`; the dashboard
 * readouts (PIXELS CO-SIGNED / TPS / ACTIVE AGENTS) AGGREGATE across tunnels with
 * no double-counting — per the docs, one action is booked per `r.verified` step
 * per tunnel.
 *
 * The paint → co-signed-tx path (one paint = one co-signed move = ~1 TPS):
 *   submitHumanPaint / agent tick
 *     → submitPaint(runKey, move, seat, painter)   // routes to that painter's run
 *     → run.tunnel.step(move, seat, ...)           // selfPlay co-signs BOTH parties
 *     → r.verified                                  // both signatures check (TPS gate)
 *     → run.moveCount++ + paint the cell + book the painter + bump the global total
 *     → flushHeartbeat(run, ≤1/s)                  // coarse throughput report per tunnel
 * The WorldCanvasProtocol folds each paint into a 32-byte rolling digest, so a
 * tunnel's co-signed state hash strictly changes on every paint — no no-op is
 * possible. Re-painting an existing cell is a fully legal, co-signed move: OVERPAINT
 * is allowed and the cell's owner/color simply updates to the latest painter.
 *
 * Opening tries the gas SPONSOR first, so every painter (incl. fresh agent keys with
 * ZERO SUI) opens for free:
 *   - SPONSORED → on-chain (default): the backend settler wraps the painter's
 *     `create_and_fund` in its OWN SIP-58 gas; the painter only co-signs.
 *   - SENDER-PAYS fallback: if the sponsor is unreachable AND the painter holds gas.
 *   - DEMO (last resort): if BOTH on-chain paths fail, a synthetic (but valid
 *     32-byte) demo tunnelId, the SAME local co-signing + heartbeat TPS (no chain,
 *     can't crash). There is no settle to skip — the wall is endless.
 *
 * Painting never blocks on the chain: paints co-sign the instant a tunnel object
 * exists, and any pre-open paints are buffered then replayed in order.
 *
 * Agents don't paint noise: each "Agent AI" bot is handed an INTELLIGENCE (Artist =
 * flag designs / Scatter = random pixels / Filler = a region growing outward) and a
 * SPEED (per-cell paint interval), plus a fresh, non-overlapping world region. It
 * walks its design cell-by-cell — each cell one co-signed move — before moving to a
 * new region. Speed/mode controls apply to newly spawned agents and live ones. The
 * hook also tracks per-cell ownership, per-painter tallies, and a recent-activity
 * ring so the HUD can render owners, players, and a leaderboard.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core } from "sui-tunnel-ts";
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
  parseTunnelId,
} from "@/games/ticTacToe/app/lib/tunnel";
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
  designForMode,
  MAX_DESIGN_WIDTH,
  MAX_DESIGN_HEIGHT,
  type AgentMode,
  type PixelDesign,
} from "./designs";
import { WC } from "./ui/tokens";

export type { AgentMode } from "./designs";

/** Cells per chunk edge — MUST match the WorldCanvasProtocol so a paint legal in
 *  the UI is legal in the co-signing tunnel. */
const CHUNK_SIZE = 256;
/** Palette size; a paint's color is in [0, NUM_COLORS). */
const NUM_COLORS = 16;
/** Tunnel stake — 1 MIST each, matching the on-chain `create_and_fund`. Collaborative
 *  free mode never shifts balances, so the close (if any) is always a draw. */
const STAKE = 1n;
/** Dashboard game key (groups TPS/tunnels under "world-canvas"). */
const GAME = "world-canvas";
/** Soft cap on retained painted cells; oldest are evicted so an endless wall keeps
 *  constant memory (the render layer does its own viewport culling). */
const MAX_RETAINED_CELLS = 200_000;
/** Recent-activity ring length (newest paints kept for the activity feed). */
const MAX_ACTIVITY = 60;
/** Gap (cells) between adjacent flag regions so flags never touch. */
const REGION_GAP = 14;
/** World slot size (cells) — sized to the largest design so any flag fits a slot. */
const SLOT_W = MAX_DESIGN_WIDTH + REGION_GAP;
const SLOT_H = MAX_DESIGN_HEIGHT + REGION_GAP;
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

/** Agent painting SPEED — the per-cell paint interval (ms). */
export type AgentSpeed = "slow" | "normal" | "fast";

/** ms between an agent's co-signed paints, per speed tier. */
const AGENT_SPEED_INTERVALS: Record<AgentSpeed, number> = {
  slow: 240,
  normal: 120,
  fast: 50,
};

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
  /** Number of autonomous agents currently painting (= number of agent tunnels). */
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
  agentMode: AgentMode;
  /** Set the agent drawing mode; updates new spawns AND running agents (next region). */
  setAgentMode(mode: AgentMode): void;
  /** Paint one cell as the human (seat A) → one co-signed move on the human tunnel. */
  submitHumanPaint(
    cx: bigint,
    cy: bigint,
    x: number,
    y: number,
    color: number,
  ): void;
  /** Spawn ONE agent on its OWN new tunnel; it paints (seat B) forever, each cell co-signed. */
  spawnAgent(): void;
  /** Stop every agent, tearing down each agent's tunnel (the human keeps painting). */
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

/** Per-painter tunnel + heartbeat/session bookkeeping (ONE per opened painter). */
interface CanvasRun {
  /** Map key = the painter's public address (human or agent). */
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
}

/** A live agent walking one design across a world region, on its own tunnel. */
interface AgentState {
  id: string;
  num: number;
  /** This agent's painter address (= its tunnel's seat-B address). */
  painter: string;
  label: string;
  tint: string;
  /** Captured at spawn, live-updatable: paint interval tier + drawing intelligence. */
  speed: AgentSpeed;
  mode: AgentMode;
  design: PixelDesign;
  /** Top-left global-pixel origin of the current design. */
  originGx: number;
  originGy: number;
  /** Global-pixel center of the current design (camera/marker anchor). */
  centerGx: number;
  centerGy: number;
  /** Index of the next design cell to paint. */
  cursor: number;
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
  const [agentSpeed, setAgentSpeedState] = useState<AgentSpeed>("normal");
  const [agentMode, setAgentModeState] = useState<AgentMode>("artist");

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
  const agentSpeedRef = useRef<AgentSpeed>("normal");
  const agentModeRef = useRef<AgentMode>("artist");

  // Coalesce many per-paint canvas mutations into one redraw per animation frame,
  // and push the latest aggregate paint count into the HUD at most once per frame.
  const scheduleRedraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setRevision((v) => v + 1);
      setStatus((s) =>
        s.movesCoSigned === totalMovesRef.current
          ? s
          : { ...s, movesCoSigned: totalMovesRef.current },
      );
    });
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

  // Open ONE painter's tunnel: try an on-chain sponsored open, else fall to demo. The
  // selfPlay tunnel is built with the FINAL id (real or demo) so its co-signatures
  // match; buffered paints replay in order once it is live. Only the HUMAN tunnel
  // drives the HUD status chip; agent tunnels open quietly in the background.
  const startRun = useCallback(
    async (
      key: string,
      identities: { a: BotIdentity; b: BotIdentity },
      isHuman: boolean,
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
      };
      runsRef.current.set(key, run);
      if (isHuman) setStatus({ ...EMPTY_STATUS, phase: "opening" });

      const partyX = {
        address: identities.a.address,
        publicKey: identities.a.publicKey,
      };
      const partyO = {
        address: identities.b.address,
        publicKey: identities.b.publicKey,
      };

      // Open a REAL tunnel by default via the gas SPONSOR (the painter needs 0 SUI).
      // `withSponsorFallback` retries sender-pays if the sponsor is unreachable AND
      // the painter holds gas; if BOTH throw, the catch routes to the demo fallback.
      try {
        const sponsoredSignExec = makeKeypairSponsoredSignExec({
          address: identities.a.address,
          keypair: identities.a.keypair,
          client: client as never,
        });
        const { digest: createDigest } = await withSponsorFallback(
          () => sponsoredSignExec(buildCreateAndFundTx(partyX, partyO, STAKE)),
          () =>
            submit(buildCreateAndFundTx(partyX, partyO, STAKE), identities.a.keypair),
          "world-canvas open/fund",
        );
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
      } catch (e) {
        console.warn(
          "[world-canvas] on-chain open failed — running off-chain demo:",
          e,
        );
      }

      // If the run was torn down while opening (unmount/stop), don't bring up a tunnel.
      if (run.closed) return;

      // Build the local co-signing tunnel with the final id. selfPlay holds BOTH this
      // painter's keypairs, so each of its paints co-signs both seats locally.
      const tunnel = core.OffchainTunnel.selfPlay<WorldCanvasState, WorldCanvasMove>(
        proto,
        run.tunnelId,
        identities.a.coreKey,
        identities.b.coreKey,
        identities.a.address,
        identities.b.address,
        { a: STAKE, b: STAKE },
      );
      run.tunnel = tunnel;
      run.lastHeartbeat = Date.now();

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

      if (isHuman) {
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

  // Public: the human paints seat A on the HUMAN tunnel; one cell = one co-signed move.
  const submitHumanPaint = useCallback(
    (cx: bigint, cy: bigint, x: number, y: number, color: number) => {
      submitPaint(humanAddress, { cx, cy, x, y, color }, "A", humanAddress);
    },
    [submitPaint, humanAddress],
  );

  // Allocate the next design (per the given mode) + a fresh, non-overlapping region.
  const nextPlacement = useCallback((mode: AgentMode) => {
    const i = regionIndexRef.current++;
    const design = designForMode(mode, i);
    const { col, row } = spiralSlot(i);
    const originGx = Math.round(col * SLOT_W - design.width / 2);
    const originGy = Math.round(row * SLOT_H - design.height / 2);
    return {
      design,
      originGx,
      originGy,
      centerGx: originGx + design.width / 2,
      centerGy: originGy + design.height / 2,
    };
  }, []);

  // Publish the live agent locations (markers) from the internal agent states.
  const syncAgentMarkers = useCallback(() => {
    setAgents(
      [...agentStatesRef.current.values()].map((s) => ({
        id: s.id,
        label: s.label,
        painter: s.painter,
        flagName: s.design.name,
        tint: s.tint,
        gx: s.centerGx,
        gy: s.centerGy,
        h: s.design.height,
      })),
    );
  }, []);

  // One paint tick for an agent, then self-reschedule at its CURRENT speed (so a live
  // speed change takes effect on the next tick). Reads the agent's live `mode` when it
  // finishes a region, so a live mode change applies to the agent's next region.
  const tickAgent = useCallback(
    function tick(id: string) {
      const st = agentStatesRef.current.get(id);
      if (!st) return; // agent stopped/removed → the timer chain ends here
      const run = runsRef.current.get(st.painter);
      if (run && !run.closed && run.ready && run.tunnel) {
        if (st.cursor >= st.design.cells.length) {
          // Design finished — relocate to a fresh region and start the next one.
          const next = nextPlacement(st.mode);
          st.design = next.design;
          st.originGx = next.originGx;
          st.originGy = next.originGy;
          st.centerGx = next.centerGx;
          st.centerGy = next.centerGy;
          st.cursor = 0;
          syncAgentMarkers();
        } else {
          const cell = st.design.cells[st.cursor++];
          const mv = moveAtGlobal(
            st.originGx + cell.dx,
            st.originGy + cell.dy,
            cell.color,
          );
          submitPaint(st.painter, mv, "B", st.painter);
        }
      }
      st.timer = setTimeout(() => tick(id), AGENT_SPEED_INTERVALS[st.speed]);
    },
    [nextPlacement, syncAgentMarkers, submitPaint],
  );

  // Public: spawn ONE agent on its OWN new self-play tunnel. It walks its design one
  // cell per tick (each a co-signed move on its tunnel), then jumps to a fresh region
  // for the next one. Spawning opens the tunnel and centers the camera on the agent.
  const spawnAgent = useCallback(() => {
    const num = ++agentNumRef.current;
    const id = `agent_${num}_${Date.now()}`;
    const identities = { a: makeIdentity(), b: makeIdentity() };
    // The agent co-signs its paints as seat B of its OWN tunnel; that address is its
    // public painter identity on the wall.
    const painter = identities.b.address;
    const label = `Agent #${num}`;
    const tint = AGENT_TINTS[(num - 1) % AGENT_TINTS.length];
    registerPainter(painter, label, true, tint);

    // Open this agent's OWN tunnel (sponsored, demo fallback). Paints buffer until it
    // is live, exactly like the human's wall.
    void startRun(painter, identities, false);

    const speed = agentSpeedRef.current;
    const mode = agentModeRef.current;
    const place = nextPlacement(mode);

    agentStatesRef.current.set(id, {
      id,
      num,
      painter,
      label,
      tint,
      speed,
      mode,
      design: place.design,
      originGx: place.originGx,
      originGy: place.originGy,
      centerGx: place.centerGx,
      centerGy: place.centerGy,
      cursor: 0,
      timer: setTimeout(() => tickAgent(id), AGENT_SPEED_INTERVALS[speed]),
    });
    syncAgentMarkers();
    setAgentCount(agentStatesRef.current.size);
    // Jump the camera to the new agent's region so the user watches it draw.
    setFocus({ gx: place.centerGx, gy: place.centerGy, seq: ++focusSeqRef.current });
  }, [registerPainter, startRun, nextPlacement, syncAgentMarkers, tickAgent]);

  // Public: stop every agent — clear its timer AND tear down its tunnel (force-flush
  // its tail heartbeat, mark closed, drop the run). The human tunnel is untouched, so
  // the human keeps painting; painter tallies are retained for the leaderboard.
  const stopAgents = useCallback(() => {
    for (const st of agentStatesRef.current.values()) {
      clearTimeout(st.timer);
      const run = runsRef.current.get(st.painter);
      if (run) {
        flushHeartbeat(run, true);
        run.closed = true;
        runsRef.current.delete(st.painter);
      }
    }
    agentStatesRef.current.clear();
    setAgents([]);
    setAgentCount(0);
  }, [flushHeartbeat]);

  // Public: set the agent paint speed — for new spawns AND every running agent (the
  // self-rescheduling timer picks up the new interval on its next tick).
  const setAgentSpeed = useCallback((speed: AgentSpeed) => {
    agentSpeedRef.current = speed;
    setAgentSpeedState(speed);
    for (const st of agentStatesRef.current.values()) st.speed = speed;
  }, []);

  // Public: set the agent drawing intelligence — for new spawns AND every running
  // agent (each switches at its next region, so the current design finishes cleanly).
  const setAgentMode = useCallback((mode: AgentMode) => {
    agentModeRef.current = mode;
    setAgentModeState(mode);
    for (const st of agentStatesRef.current.values()) st.mode = mode;
  }, []);

  // Public: re-center the camera on the live agent painting at `painter` (📍 button).
  const focusOnAgent = useCallback((painter: string) => {
    for (const st of agentStatesRef.current.values()) {
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

  // Public: cycle the camera through active agents ("View Agent" button).
  const viewNextAgent = useCallback(() => {
    const states = [...agentStatesRef.current.values()];
    if (states.length === 0) return;
    const idx = viewCursorRef.current % states.length;
    viewCursorRef.current = idx + 1;
    const st = states[idx];
    setFocus({ gx: st.centerGx, gy: st.centerGy, seq: ++focusSeqRef.current });
  }, []);

  // Open the HUMAN wall on mount; tear every tunnel (human + agents) down on unmount.
  useEffect(() => {
    if (!runsRef.current.has(humanAddress)) {
      void startRun(humanAddress, { a: bots.x, b: bots.o }, true);
    }
    return () => {
      for (const s of agentStatesRef.current.values()) clearTimeout(s.timer);
      agentStatesRef.current.clear();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      for (const run of runsRef.current.values()) {
        flushHeartbeat(run, true);
        run.closed = true;
      }
      runsRef.current.clear();
    };
  }, [startRun, flushHeartbeat, humanAddress, bots]);

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
    submitHumanPaint,
    spawnAgent,
    stopAgents,
    focusOnAgent,
    viewNextAgent,
  };
}
