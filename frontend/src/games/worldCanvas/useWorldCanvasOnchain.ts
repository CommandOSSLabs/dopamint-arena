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
 *     → submitPaint(move, seat)          // human is seat A, agents seat B
 *     → run.tunnel.step(move, seat,...)  // selfPlay co-signs BOTH parties
 *     → r.verified                        // both signatures check (honest TPS gate)
 *     → run.moveCount++ + paint the cell into the live canvas
 *     → flushHeartbeat (≤1/s)            // coarse throughput report to the control plane
 * The WorldCanvasProtocol folds each paint into a 32-byte rolling digest, so the
 * co-signed state hash strictly changes on every paint — no no-op is possible.
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
/** How often each spawned agent lays one co-signed paint. */
const AGENT_PAINT_INTERVAL_MS = 120;
/** Soft cap on retained painted cells; oldest are evicted so an endless wall keeps
 *  constant memory (the render layer does its own viewport culling). */
const MAX_RETAINED_CELLS = 200_000;

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
  /** Paint one cell as the human (seat A) → one co-signed move. */
  submitHumanPaint(
    cx: bigint,
    cy: bigint,
    x: number,
    y: number,
    color: number,
  ): void;
  /** Spawn ONE agent that paints random cells (seat B) forever, each co-signed. */
  spawnAgent(): void;
  /** Stop every agent (the human can keep painting). */
  stopAgents(): void;
}

/** Stable cell key for the live canvas map. */
export function cellKey(cx: bigint, cy: bigint, x: number, y: number): string {
  return `${cx}:${cy}:${x}:${y}`;
}

/** Per-run tunnel + heartbeat/session bookkeeping (one per opened wall). */
interface CanvasRun {
  tunnelId: string;
  onchain: boolean;
  createdAt: bigint;
  tunnel: core.OffchainTunnel<WorldCanvasState, WorldCanvasMove> | null;
  /** Paints accepted before the tunnel object exists; replayed in order on ready. */
  buffer: { mv: WorldCanvasMove; by: Seat }[];
  ready: boolean;
  closed: boolean;
  session: RegisterSessionResult | null;
  moveCount: number;
  actions: number;
  lastHeartbeat: number;
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
  // One protocol instance shared by the co-signing tunnel and the agents' RNG.
  const proto = useMemo(
    () => new WorldCanvasProtocol({ chunkSize: CHUNK_SIZE, numColors: NUM_COLORS }),
    [],
  );

  const [status, setStatus] = useState<WorldCanvasOnchainStatus>(EMPTY_STATUS);
  const [revision, setRevision] = useState(0);
  const [agentCount, setAgentCount] = useState(0);

  const runRef = useRef<CanvasRun | null>(null);
  // Live canvas data: stable identity, mutated in place; React re-reads on `revision`.
  const paintsRef = useRef<Map<string, PaintedCell>>(new Map());
  const agentTimersRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set());
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
    (mv: WorldCanvasMove, by: Seat, seq: number) => {
      const map = paintsRef.current;
      const key = cellKey(mv.cx, mv.cy, mv.x, mv.y);
      map.set(key, { cx: mv.cx, cy: mv.cy, x: mv.x, y: mv.y, color: mv.color, by, seq });
      if (map.size > MAX_RETAINED_CELLS) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      scheduleRedraw();
    },
    [scheduleRedraw],
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
  // steps (the TPS gate), paint the cell, and bump the throughput counters.
  const coSignPaint = useCallback(
    (run: CanvasRun, mv: WorldCanvasMove, by: Seat) => {
      if (!run.tunnel || run.closed) return;
      try {
        const r = run.tunnel.step(mv, by, {
          mode: "full",
          timestamp: run.createdAt,
        });
        if (!r.verified) return;
        run.moveCount += 1;
        run.actions += 1;
        paintCell(mv, by, run.moveCount);
        flushHeartbeat(run, false);
        setStatus((s) => ({ ...s, movesCoSigned: run.moveCount }));
      } catch (e) {
        console.warn("[world-canvas] tunnel step skipped:", e);
      }
    },
    [paintCell, flushHeartbeat],
  );

  // The paint sink: co-sign once the tunnel exists, else buffer (preserving order)
  // until `startRun` drains it.
  const submitPaint = useCallback(
    (mv: WorldCanvasMove, by: Seat) => {
      const run = runRef.current;
      if (!run || run.closed) return;
      if (!run.ready || !run.tunnel) {
        run.buffer.push({ mv, by });
        return;
      }
      coSignPaint(run, mv, by);
    },
    [coSignPaint],
  );

  // Begin a run: try an on-chain sponsored open, else fall to demo. The selfPlay
  // tunnel is built with the FINAL id (real or demo) so its co-signatures match;
  // buffered paints replay in order once it is live.
  const startRun = useCallback(async () => {
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
    for (const { mv, by } of buffered) coSignPaint(run, mv, by);

    setStatus((s) => ({
      ...s,
      phase: run.onchain ? "open" : "demo",
      tunnelId: run.tunnelId,
      onchain: run.onchain,
      movesCoSigned: run.moveCount,
    }));
  }, [bots, client, proto, submit, coSignPaint]);

  // Public: the human paints seat A; one cell = one co-signed move.
  const submitHumanPaint = useCallback(
    (cx: bigint, cy: bigint, x: number, y: number, color: number) => {
      submitPaint({ cx, cy, x, y, color }, "A");
    },
    [submitPaint],
  );

  // Public: spawn ONE agent that paints random cells (seat B) forever. Each tick is
  // one co-signed move + heartbeat → endless TPS. Multiple calls = more agents.
  const spawnAgent = useCallback(() => {
    const timer = setInterval(() => {
      const run = runRef.current;
      if (!run || run.closed || !run.ready || !run.tunnel) return;
      const mv = proto.randomMove(run.tunnel.state, "B", Math.random);
      if (mv) submitPaint(mv, "B");
    }, AGENT_PAINT_INTERVAL_MS);
    agentTimersRef.current.add(timer);
    setAgentCount(agentTimersRef.current.size);
  }, [proto, submitPaint]);

  // Public: stop every agent (the human can keep painting).
  const stopAgents = useCallback(() => {
    for (const t of agentTimersRef.current) clearInterval(t);
    agentTimersRef.current.clear();
    setAgentCount(0);
  }, []);

  // Open the wall on mount; tear everything down on unmount.
  useEffect(() => {
    if (!runRef.current) void startRun();
    return () => {
      for (const t of agentTimersRef.current) clearInterval(t);
      agentTimersRef.current.clear();
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
    submitHumanPaint,
    spawnAgent,
    stopAgents,
  };
}
