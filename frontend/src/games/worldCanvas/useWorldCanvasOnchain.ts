/**
 * useWorldCanvasOnchain — runs "The World is Your Canvas" OVER an OffchainTunnel
 * so every painted cell becomes real co-signed throughput (TPS on the dashboard
 * under "world-canvas"). It mirrors the proven pixel-duel on-chain path
 * ({@link makeKeypairSponsoredSignExec} + {@link withSponsorFallback} +
 * `core.OffchainTunnel.selfPlay`), but for a COLLABORATIVE, APPEND-ONLY paint
 * stream with no turns, no winner, and no settle — the wall just paints forever.
 *
 * The paint → co-signed-tx path (one paint = one co-signed move = ~1 TPS):
 *   submitHumanPaint / agent tick
 *     → submitPaint(move, seat, painter)  // human is seat A, agents seat B
 *     → run.tunnel.step(move, seat,...)   // selfPlay co-signs BOTH parties
 *     → r.verified                         // both signatures check (honest TPS gate)
 *     → run.moveCount++ + paint the cell into the live canvas + book the painter
 *     → flushHeartbeat (≤1/s)             // coarse throughput report to the control plane
 * The WorldCanvasProtocol folds each paint into a 32-byte rolling digest, so the
 * co-signed state hash strictly changes on every paint — no no-op is possible.
 * Re-painting an existing cell is a fully legal, co-signed move (the digest still
 * folds in the painter byte + coordinate): OVERPAINT is allowed and the cell's
 * owner/color simply updates to the latest painter.
 *
 * Opening tries the gas SPONSOR first, so the bots need ZERO SUI by default:
 *   - SPONSORED → on-chain (default): the backend settler wraps bot X's
 *     `create_and_fund` in its OWN SIP-58 gas; bot X only co-signs. A real tunnel
 *     opens and every paint co-signs under its id.
 *   - SENDER-PAYS fallback: if the sponsor endpoint is unreachable AND the bots
 *     happen to hold gas, bot X pays its own `create_and_fund` gas.
 *   - DEMO (last resort): if BOTH on-chain paths fail, a synthetic (but valid
 *     32-byte) demo tunnelId, the SAME local co-signing + heartbeat TPS (no chain,
 *     can't crash). There is no settle to skip — the wall is endless.
 *
 * Painting never blocks on the chain: paints co-sign the instant the tunnel
 * object exists, and any pre-open paints are buffered then replayed in order.
 *
 * Agents don't paint noise: each "Agent AI" bot is handed a flag design (the
 * Vietnam flag by default) and a fresh, non-overlapping world region, then walks
 * the design cell-by-cell — each cell one co-signed move — before moving to a new
 * region for the next flag. The hook also tracks per-cell ownership, per-painter
 * tallies, and a recent-activity ring so the HUD can render owners, players, and
 * a leaderboard.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core } from "sui-tunnel-ts";
import {
  WorldCanvasProtocol,
  type WorldCanvasState,
  type WorldCanvasMove,
} from "sui-tunnel-ts/protocol/worldCanvas";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "@/backend/controlPlane";
import {
  buildCreateAndFundTx,
  parseTunnelId,
} from "@/games/ticTacToe/app/lib/tunnel";
import { loadOrCreateBots, getSuiClient } from "@/games/ticTacToe/app/lib/bots";
import {
  makeKeypairSponsoredSignExec,
  withSponsorFallback,
} from "@/onchain/sponsor";
import {
  designForFlagIndex,
  MAX_DESIGN_WIDTH,
  MAX_DESIGN_HEIGHT,
  type PixelDesign,
} from "./designs";
import { WC } from "./ui/tokens";

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
/** How often each spawned agent lays one co-signed paint (one flag cell per tick). */
const AGENT_PAINT_INTERVAL_MS = 70;
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
  /** Name of the flag currently being drawn (e.g. "Vietnam"). */
  flagName: string;
  tint: string;
  /** Global-pixel center of the current flag (camera jump + marker anchor). */
  gx: number;
  gy: number;
  /** Current flag height in cells (lets the marker anchor just above the flag). */
  h: number;
}

/** A camera-jump request: center this global-pixel point; `seq` bumps per request. */
export interface CanvasFocus {
  gx: number;
  gy: number;
  seq: number;
}

/** On-chain progress surfaced to the canvas HUD. */
export interface WorldCanvasOnchainStatus {
  phase: WorldCanvasPhase;
  /** Real on-chain tunnel id, or a synthetic demo id when running off-chain. */
  tunnelId: string | null;
  /** True once a real tunnel was opened on-chain (vs. the demo fallback). */
  onchain: boolean;
  /** Co-signed paints appended this run (the TPS numerator). */
  movesCoSigned: number;
  /** `create_and_fund` digest (on-chain path only). */
  openDigest: string | null;
  error: string | null;
}

export interface UseWorldCanvasOnchain {
  status: WorldCanvasOnchainStatus;
  /** Live canvas: stable Map identity, mutated in place; re-read on `revision` bumps. */
  paints: ReadonlyMap<string, PaintedCell>;
  /** Bumps (rAF-throttled) whenever the canvas changes, so consumers redraw. */
  revision: number;
  /** Number of autonomous agents currently painting. */
  agentCount: number;
  /** Live agent locations (markers + the "knows where it's drawing" label). */
  agents: AgentMarker[];
  /** Latest camera-jump request (set when an agent spawns); null until first spawn. */
  focus: CanvasFocus | null;
  /** Per-painter tallies, keyed by address (stable identity; re-read on `revision`). */
  painters: ReadonlyMap<string, PainterInfo>;
  /** Recent-activity ring, oldest→newest (stable identity; re-read on `revision`). */
  activity: ReadonlyArray<ActivityEntry>;
  /** The human's address (so the UI can label the human's own cells "You"). */
  humanAddress: string;
  /** Paint one cell as the human (seat A) → one co-signed move. */
  submitHumanPaint(
    cx: bigint,
    cy: bigint,
    x: number,
    y: number,
    color: number,
  ): void;
  /** Spawn ONE agent that draws flags (seat B) forever, each cell co-signed. */
  spawnAgent(): void;
  /** Stop every agent (the human can keep painting; history is retained). */
  stopAgents(): void;
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

/** A throwaway 32-byte hex identity for an agent — display/leaderboard only (the
 *  on-chain co-signing identity is always party B). */
function randomAgentAddress(): string {
  let h = "";
  for (let i = 0; i < 64; i++) h += Math.floor(Math.random() * 16).toString(16);
  return `0x${h}`;
}

/** Per-run tunnel + heartbeat/session bookkeeping (one per opened wall). */
interface CanvasRun {
  tunnelId: string;
  onchain: boolean;
  createdAt: bigint;
  tunnel: core.OffchainTunnel<WorldCanvasState, WorldCanvasMove> | null;
  /** Paints accepted before the tunnel object exists; replayed in order on ready. */
  buffer: { mv: WorldCanvasMove; by: Seat; painter: string }[];
  ready: boolean;
  closed: boolean;
  session: RegisterSessionResult | null;
  moveCount: number;
  actions: number;
  lastHeartbeat: number;
}

/** A live agent walking one flag design across a world region. */
interface AgentState {
  id: string;
  num: number;
  painter: string;
  label: string;
  tint: string;
  design: PixelDesign;
  /** Top-left global-pixel origin of the current flag. */
  originGx: number;
  originGy: number;
  /** Global-pixel center of the current flag (camera/marker anchor). */
  centerGx: number;
  centerGy: number;
  /** Index of the next design cell to paint. */
  cursor: number;
  timer: ReturnType<typeof setInterval>;
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
  // One protocol instance shared by the co-signing tunnel and the agents' RNG.
  const proto = useMemo(
    () => new WorldCanvasProtocol({ chunkSize: CHUNK_SIZE, numColors: NUM_COLORS }),
    [],
  );

  const [status, setStatus] = useState<WorldCanvasOnchainStatus>(EMPTY_STATUS);
  const [revision, setRevision] = useState(0);
  const [agentCount, setAgentCount] = useState(0);
  const [agents, setAgents] = useState<AgentMarker[]>([]);
  const [focus, setFocus] = useState<CanvasFocus | null>(null);

  const runRef = useRef<CanvasRun | null>(null);
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
  const rafRef = useRef<number | null>(null);

  // Coalesce many per-paint canvas mutations into one redraw per animation frame.
  const scheduleRedraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setRevision((v) => v + 1);
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

  // Coarse throughput report — one call per ~1s window, never per paint.
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

  // Co-sign one paint through the tunnel; count only honest, both-signature-VERIFIED
  // steps (the TPS gate), paint the cell, book the painter, and bump the counters.
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
        paintCell(mv, by, run.moveCount, painter);
        recordPaint(painter, mv, run.moveCount);
        flushHeartbeat(run, false);
        setStatus((s) => ({ ...s, movesCoSigned: run.moveCount }));
      } catch (e) {
        console.warn("[world-canvas] tunnel step skipped:", e);
      }
    },
    [paintCell, recordPaint, flushHeartbeat],
  );

  // The paint sink: co-sign once the tunnel exists, else buffer (preserving order)
  // until `startRun` drains it.
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

  // Begin a run: try an on-chain sponsored open, else fall to demo. The selfPlay
  // tunnel is built with the FINAL id (real or demo) so its co-signatures match;
  // buffered paints replay in order once it is live.
  const startRun = useCallback(async () => {
    // The human shows up on the leaderboard as "You" the moment they paint.
    registerPainter(humanAddress, "You", false, WC.seatA);

    const run: CanvasRun = {
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
    runRef.current = run;
    setStatus({ ...EMPTY_STATUS, phase: "opening" });

    const partyX = { address: bots.x.address, publicKey: bots.x.publicKey };
    const partyO = { address: bots.o.address, publicKey: bots.o.publicKey };

    // Open a REAL tunnel by default via the gas SPONSOR (bots need 0 SUI).
    // `withSponsorFallback` retries sender-pays if the sponsor is unreachable AND
    // the bots hold gas; if BOTH throw, the catch routes to the demo fallback.
    try {
      const sponsoredSignExec = makeKeypairSponsoredSignExec({
        address: bots.x.address,
        keypair: bots.x.keypair,
        client: client as never,
      });
      const { digest: createDigest } = await withSponsorFallback(
        () => sponsoredSignExec(buildCreateAndFundTx(partyX, partyO, STAKE)),
        () => submit(buildCreateAndFundTx(partyX, partyO, STAKE), bots.x.keypair),
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
        setStatus((s) => ({ ...s, openDigest: createDigest }));
      }
    } catch (e) {
      console.warn(
        "[world-canvas] on-chain open failed — running off-chain demo:",
        e,
      );
    }

    // If the run was torn down while opening (unmount/reset), don't bring up a tunnel.
    if (run.closed) return;

    // Build the local co-signing tunnel with the final id. selfPlay holds BOTH
    // bot keypairs, so a human seat-A paint and an agent seat-B paint both co-sign.
    const tunnel = core.OffchainTunnel.selfPlay<WorldCanvasState, WorldCanvasMove>(
      proto,
      run.tunnelId,
      bots.x.coreKey,
      bots.o.coreKey,
      bots.x.address,
      bots.o.address,
      { a: STAKE, b: STAKE },
    );
    run.tunnel = tunnel;
    run.lastHeartbeat = Date.now();

    // Register the tunnel for stats tracking. Best-effort (never blocks painting).
    getControlPlaneClient()
      .registerSession({
        userAddress: bots.x.address,
        game: GAME,
        tunnels: [
          {
            tunnelId: run.tunnelId,
            partyA: bots.x.address,
            partyB: bots.o.address,
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

    setStatus((s) => ({
      ...s,
      phase: run.onchain ? "open" : "demo",
      tunnelId: run.tunnelId,
      onchain: run.onchain,
      movesCoSigned: run.moveCount,
    }));
  }, [bots, client, proto, submit, coSignPaint, registerPainter, humanAddress]);

  // Public: the human paints seat A; one cell = one co-signed move.
  const submitHumanPaint = useCallback(
    (cx: bigint, cy: bigint, x: number, y: number, color: number) => {
      submitPaint({ cx, cy, x, y, color }, "A", humanAddress);
    },
    [submitPaint, humanAddress],
  );

  // Allocate the next flag's design + a fresh, non-overlapping world region.
  const nextFlagPlacement = useCallback(() => {
    const i = regionIndexRef.current++;
    const design = designForFlagIndex(i);
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

  // Public: spawn ONE agent that DRAWS FLAGS (seat B) forever. It walks its flag
  // design one cell per tick (each a co-signed move), then jumps to a fresh region
  // for the next flag. Spawning centers the camera on the new agent's flag.
  const spawnAgent = useCallback(() => {
    const num = ++agentNumRef.current;
    const id = `agent_${num}_${Date.now()}`;
    const painter = randomAgentAddress();
    const label = `Agent #${num}`;
    const tint = AGENT_TINTS[(num - 1) % AGENT_TINTS.length];
    registerPainter(painter, label, true, tint);

    const place = nextFlagPlacement();
    const timer = setInterval(() => {
      const run = runRef.current;
      if (!run || run.closed || !run.ready || !run.tunnel) return;
      const st = agentStatesRef.current.get(id);
      if (!st) return;
      if (st.cursor >= st.design.cells.length) {
        // Flag finished — relocate to a fresh region and start the next flag.
        const next = nextFlagPlacement();
        st.design = next.design;
        st.originGx = next.originGx;
        st.originGy = next.originGy;
        st.centerGx = next.centerGx;
        st.centerGy = next.centerGy;
        st.cursor = 0;
        syncAgentMarkers();
        return;
      }
      const cell = st.design.cells[st.cursor++];
      const mv = moveAtGlobal(st.originGx + cell.dx, st.originGy + cell.dy, cell.color);
      submitPaint(mv, "B", st.painter);
    }, AGENT_PAINT_INTERVAL_MS);

    agentStatesRef.current.set(id, {
      id,
      num,
      painter,
      label,
      tint,
      design: place.design,
      originGx: place.originGx,
      originGy: place.originGy,
      centerGx: place.centerGx,
      centerGy: place.centerGy,
      cursor: 0,
      timer,
    });
    syncAgentMarkers();
    setAgentCount(agentStatesRef.current.size);
    // Jump the camera to the new agent's flag so the user watches it draw.
    setFocus({ gx: place.centerGx, gy: place.centerGy, seq: ++focusSeqRef.current });
  }, [registerPainter, nextFlagPlacement, syncAgentMarkers, submitPaint]);

  // Public: stop every agent (the human can keep painting; tallies are retained).
  const stopAgents = useCallback(() => {
    for (const s of agentStatesRef.current.values()) clearInterval(s.timer);
    agentStatesRef.current.clear();
    setAgents([]);
    setAgentCount(0);
  }, []);

  // Open the wall on mount; tear everything down on unmount.
  useEffect(() => {
    if (!runRef.current) void startRun();
    return () => {
      for (const s of agentStatesRef.current.values()) clearInterval(s.timer);
      agentStatesRef.current.clear();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      const run = runRef.current;
      if (run) {
        flushHeartbeat(run, true);
        run.closed = true;
      }
      runRef.current = null;
    };
  }, [startRun, flushHeartbeat]);

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
    submitHumanPaint,
    spawnAgent,
    stopAgents,
  };
}
