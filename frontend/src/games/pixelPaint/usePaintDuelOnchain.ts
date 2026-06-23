/**
 * usePaintDuelOnchain — runs a Pixel Duel OVER an OffchainTunnel so the wall
 * generates real co-signed throughput (TPS on the dashboard under "pixel-duel")
 * and, when the bots hold gas, an on-chain settle digest. Drives BOTH modes:
 *   - auto (Watch Bots): both seats bot-driven, the whole wall self-plays.
 *   - vs-bot (Play vs Bot, `auto:false`): seat A is YOU, seat B a bot — your
 *     human paints AND the bot's ticks both co-sign through the same tunnel.
 *
 * It wraps {@link usePaintDuel} UNCHANGED for all gameplay — fog, blind bot
 * planning, cooldown, scoring, reveal — and adds ONLY the tunnel layer via the
 * hook's `onMove` sink: every accepted paint (whoever made it) is co-signed
 * through `core.OffchainTunnel.selfPlay` under its seat and appended to a
 * transcript. selfPlay co-signs BOTH parties with bot keypairs, so a human's
 * seat-A move is mirrored to the tunnel as party A — the local duel state still
 * drives the fog UI; the tunnel is a parallel co-signing ledger. The control
 * plane is registered once per run and fed a throttled heartbeat (≤1/s, forced
 * on settle), exactly like TicTacToe's `useBotGame`.
 *
 * TWO paths, decided by whether the local bots hold gas:
 *   - FUNDED → on-chain: open+fund a real tunnel (bot X signs `create_and_fund`),
 *     co-sign every move under the real tunnelId, then settle via the backend
 *     settler (falling back to a bot-keypair `close_cooperative_with_root`),
 *     yielding a real Sui `txDigest`.
 *   - NO GAS / open fails → off-chain DEMO: a synthetic demo tunnelId, the SAME
 *     local co-signing + heartbeat TPS (no chain, can't crash), and no settle.
 *
 * The duel never blocks on the chain: moves co-sign locally the instant the
 * tunnel object exists, and any pre-open moves are buffered then replayed in
 * order so nothing is lost during the few seconds `create_and_fund` takes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, proof, bytesToHex } from "sui-tunnel-ts";
import {
  PixelPaintProtocol,
  type PixelPaintState,
  type PixelPaintMove,
} from "sui-tunnel-ts/protocol/pixelPaint";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "@/backend/controlPlane";
import { coSignedToSettleRequest } from "@/backend/settleRequest";
import {
  buildCreateAndFundTx,
  buildSettleWithRootTx,
  parseTunnelId,
} from "@/games/ticTacToe/app/lib/tunnel";
import {
  loadOrCreateBots,
  getSuiClient,
  botBalances,
} from "@/games/ticTacToe/app/lib/bots";
import {
  usePaintDuel,
  type DuelDifficulty,
  type DuelSpeed,
  type UsePaintDuel,
} from "./usePaintDuel";

// Canvas/protocol config — MUST match usePaintDuel's so a move legal in the duel
// is legal in the co-signing tunnel. Legality keys on size/cap/overwriteLimit/mode
// only (never balances/stake), so the tunnel can run leaner 1-MIST stakes while the
// duel UI keeps its display balances; the two stay move-for-move in sync.
const BOARD = { width: 96, height: 56 };
const CAP = 2400;
const OVERWRITE_LIMIT = 3;
/** Tunnel stake/stakes — 1 MIST each, matching the on-chain `create_and_fund`. */
const STAKE = 1n;
/** Dashboard game key for this arena (groups TPS/tunnels under "pixel-duel"). */
const GAME = "pixel-duel";
/** A bot needs at least this much gas to safely open+fund AND settle a tunnel;
 *  below it we run the off-chain demo instead (no open, no settle). ~0.02 SUI. */
const MIN_PLAY_MIST = 20_000_000n;

export type OnchainPhase =
  | "idle"
  | "opening"
  | "open"
  | "settling"
  | "settled"
  | "demo"
  | "error";

/** On-chain progress surfaced to the Watch-Bots view's status chip. */
export interface PaintDuelOnchainStatus {
  phase: OnchainPhase;
  /** Real on-chain tunnel id, or a synthetic demo id when running off-chain. */
  tunnelId: string | null;
  /** True once a real tunnel was opened on-chain (vs. the demo fallback). */
  onchain: boolean;
  /** Co-signed updates appended to the transcript so far this run. */
  movesCoSigned: number;
  /** `create_and_fund` digest (on-chain path only). */
  openDigest: string | null;
  /** Cooperative-close digest once settled (on-chain path only). */
  settleDigest: string | null;
  /** 0x-prefixed transcript Merkle root anchored at close. */
  rootHex: string | null;
  error: string | null;
}

export interface UsePaintDuelOnchain {
  duel: UsePaintDuel;
  status: PaintDuelOnchainStatus;
}

export interface UsePaintDuelOnchainOptions {
  difficulty?: DuelDifficulty;
  speed?: DuelSpeed;
  seed?: number;
  /** Spectator self-play (both seats bot-driven) when true; vs-bot (seat A is the
   *  human) when false. Defaults true so Watch-Bots callers stay unchanged. */
  auto?: boolean;
}

/** Per-run tunnel + transcript + heartbeat/session bookkeeping (one per duel). */
interface DuelRun {
  tunnelId: string;
  onchain: boolean;
  createdAt: bigint;
  tunnel: core.OffchainTunnel<PixelPaintState, PixelPaintMove> | null;
  transcript: proof.Transcript | null;
  /** Moves accepted before the tunnel object exists; replayed in order on ready. */
  buffer: { mv: PixelPaintMove; by: "A" | "B" }[];
  ready: boolean;
  /** A reveal arrived before the tunnel finished opening — settle once ready. */
  endRequested: boolean;
  settled: boolean;
  session: RegisterSessionResult | null;
  moveCount: number;
  actions: number;
  lastHeartbeat: number;
}

const EMPTY_STATUS: PaintDuelOnchainStatus = {
  phase: "idle",
  tunnelId: null,
  onchain: false,
  movesCoSigned: 0,
  openDigest: null,
  settleDigest: null,
  rootHex: null,
  error: null,
};

export function usePaintDuelOnchain(
  options: UsePaintDuelOnchainOptions = {},
): UsePaintDuelOnchain {
  const bots = useMemo(() => loadOrCreateBots(), []);
  const client = useMemo(() => getSuiClient(), []);
  // One protocol instance for the co-signing tunnel; matches the duel's legality.
  const proto = useMemo(
    () =>
      new PixelPaintProtocol({
        ...BOARD,
        cap: CAP,
        overwriteLimit: OVERWRITE_LIMIT,
        stake: STAKE,
        mode: "war",
      }),
    [],
  );

  const [status, setStatus] = useState<PaintDuelOnchainStatus>(EMPTY_STATUS);
  const runRef = useRef<DuelRun | null>(null);

  // Submit a tx signed by a bot keypair; assert success and return the result.
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

  // Coarse throughput report — one call per ~1s window, never per move. Forced
  // once at settle so the run's last actions land even inside the throttle window.
  const flushHeartbeat = useCallback((run: DuelRun, force: boolean) => {
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
      .catch((e) => console.error("[pixel-duel] heartbeat failed:", e));
  }, []);

  // Co-sign one accepted move through the tunnel; append it to the transcript and
  // bump the throughput counters. Best-effort: a divergence/terminal throw can't
  // crash the duel (the duel owns its own state; the tunnel is a co-signing ledger).
  const stepTunnel = useCallback(
    (run: DuelRun, mv: PixelPaintMove, by: "A" | "B") => {
      if (!run.tunnel) return;
      try {
        const r = run.tunnel.step(mv, by, {
          mode: "full",
          timestamp: run.createdAt,
        });
        // Count only honest, both-signature-VERIFIED steps (the TPS heartbeat
        // contract — "honest effective TPS", same gate as useBotGame).
        if (!r.verified) return;
        run.moveCount += 1;
        run.actions += 1;
        flushHeartbeat(run, false);
        setStatus((s) => ({ ...s, movesCoSigned: run.moveCount }));
      } catch (e) {
        console.warn("[pixel-duel] tunnel step skipped:", e);
      }
    },
    [flushHeartbeat],
  );

  // The move sink handed to usePaintDuel: co-sign once the tunnel exists, else
  // buffer (preserving order) until `startRun` drains it.
  const onMove = useCallback(
    (mv: PixelPaintMove, by: "A" | "B") => {
      const run = runRef.current;
      if (!run || run.settled) return;
      if (!run.ready || !run.tunnel) {
        run.buffer.push({ mv, by });
        return;
      }
      stepTunnel(run, mv, by);
    },
    [stepTunnel],
  );

  // Drive all gameplay through the unchanged duel hook in the requested mode
  // (auto spectator or vs-bot). The `onMove` sink fires for every accepted paint —
  // the human's seat-A place AND every bot tick — so both modes feed the tunnel.
  const duel = usePaintDuel({
    auto: options.auto ?? true,
    difficulty: options.difficulty ?? "normal",
    speed: options.speed,
    seed: options.seed,
    onMove,
  });

  // Build the dual-signed root settlement and route it through the backend settler,
  // falling back to a direct bot-keypair close. Demo runs skip the chain entirely.
  const settleRun = useCallback(
    async (run: DuelRun) => {
      flushHeartbeat(run, true);
      if (!run.onchain || !run.tunnel || !run.transcript) {
        setStatus((s) => ({
          ...s,
          phase: "demo",
          movesCoSigned: run.moveCount,
        }));
        return;
      }
      setStatus((s) => ({ ...s, phase: "settling" }));
      try {
        const root = run.transcript.root();
        const settlement = run.tunnel.buildSettlementWithRoot(
          run.createdAt,
          root,
          0n,
        );
        let settleDigest = "";
        try {
          const result = await getControlPlaneClient().settle(
            run.tunnelId,
            coSignedToSettleRequest(
              settlement,
              run.transcript.toRecord().entries,
            ),
          );
          settleDigest = result.txDigest;
        } catch (e) {
          console.warn(
            "[pixel-duel] backend settle failed, falling back to bot submit:",
            e,
          );
          const closeRes = await submit(
            buildSettleWithRootTx(run.tunnelId, settlement),
            bots.x.keypair,
          );
          settleDigest = closeRes.digest;
        }
        setStatus((s) => ({
          ...s,
          phase: "settled",
          settleDigest,
          rootHex: `0x${bytesToHex(root)}`,
          movesCoSigned: run.moveCount,
        }));
      } catch (e) {
        setStatus((s) => ({
          ...s,
          phase: "error",
          error: e instanceof Error ? e.message : String(e),
        }));
      }
    },
    [bots, submit, flushHeartbeat],
  );

  // Begin a run: try an on-chain open (if the bots hold gas), else fall to demo.
  // The selfPlay tunnel is built with the FINAL id (real or demo) so its
  // signatures match whatever we may later settle; buffered moves replay in order.
  const startRun = useCallback(async () => {
    const run: DuelRun = {
      // Demo id must be a VALID 32-byte hex address: OffchainTunnel.selfPlay feeds
      // it to addressToBytes32, which throws on a non-hex marker like "demo-paint"
      // (that crash left the chip stuck at "opening…" with no register/heartbeat).
      // The demo/real distinction is the `onchain` flag below, not this string.
      tunnelId: `0x${`${Date.now().toString(16)}${Math.floor(
        Math.random() * 0xffffffff,
      ).toString(16)}`.padStart(64, "0")}`,
      onchain: false,
      createdAt: 0n,
      tunnel: null,
      transcript: null,
      buffer: [],
      ready: false,
      endRequested: false,
      settled: false,
      session: null,
      moveCount: 0,
      actions: 0,
      lastHeartbeat: Date.now(),
    };
    runRef.current = run;
    setStatus({ ...EMPTY_STATUS, phase: "opening" });

    const partyX = { address: bots.x.address, publicKey: bots.x.publicKey };
    const partyO = { address: bots.o.address, publicKey: bots.o.publicKey };

    // Decide on-chain vs demo by the bots' gas; open+fund a real tunnel if funded.
    try {
      const bal = await botBalances(client, bots);
      if (bal.x >= MIN_PLAY_MIST && bal.o >= MIN_PLAY_MIST) {
        const createRes = await submit(
          buildCreateAndFundTx(partyX, partyO, STAKE),
          bots.x.keypair,
        );
        const realId = parseTunnelId(createRes.objectChanges);
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
          setStatus((s) => ({ ...s, openDigest: createRes.digest }));
        }
      }
    } catch (e) {
      console.warn(
        "[pixel-duel] on-chain open failed — running off-chain demo:",
        e,
      );
    }

    // Build the local co-signing tunnel with the final id; wire the transcript.
    const tunnel = core.OffchainTunnel.selfPlay<PixelPaintState, PixelPaintMove>(
      proto,
      run.tunnelId,
      bots.x.coreKey,
      bots.o.coreKey,
      bots.x.address,
      bots.o.address,
      { a: STAKE, b: STAKE },
    );
    const transcript = new proof.Transcript(run.tunnelId);
    tunnel.onUpdate = (u) => transcript.append(u);
    run.tunnel = tunnel;
    run.transcript = transcript;
    run.lastHeartbeat = Date.now();

    // Register the tunnel for stats tracking. Best-effort (never blocks play).
    getControlPlaneClient()
      .registerSession({
        userAddress: bots.x.address,
        game: GAME,
        tunnels: [
          { tunnelId: run.tunnelId, partyA: bots.x.address, partyB: bots.o.address },
        ],
      })
      .then((s) => {
        run.session = s;
      })
      .catch((e) => console.error("[pixel-duel] registerSession failed:", e));

    // Tunnel is live: drain any moves that arrived during the open, then continue.
    run.ready = true;
    const buffered = run.buffer;
    run.buffer = [];
    for (const { mv, by } of buffered) stepTunnel(run, mv, by);

    setStatus((s) => ({
      ...s,
      phase: run.onchain ? "open" : "demo",
      tunnelId: run.tunnelId,
      onchain: run.onchain,
      movesCoSigned: run.moveCount,
    }));

    // A reveal raced ahead of the open — settle now that the tunnel is ready.
    if (run.endRequested) await settleRun(run);
  }, [bots, client, proto, submit, stepTunnel, settleRun]);

  // Abandon the current run without settling (used when the duel is reset mid-play
  // so the next run opens a fresh tunnel rather than co-signing into a stale one).
  const resetRun = useCallback(() => {
    const run = runRef.current;
    if (run) run.settled = true;
    runRef.current = null;
    setStatus(EMPTY_STATUS);
  }, []);

  // Lifecycle: open a tunnel when play begins, settle when the duel reveals. Keyed
  // off the duel's phase — auto starts at "playing"; vs-bot runs the memorize
  // flash first, so the tunnel opens once the human's play phase begins. No moves
  // occur during memorize (human is look-only, bot paused), so nothing is missed.
  useEffect(() => {
    if (duel.phase === "playing") {
      if (!runRef.current) void startRun();
    } else if (duel.phase === "revealed") {
      const run = runRef.current;
      if (run && !run.settled) {
        if (run.ready) {
          run.settled = true;
          void settleRun(run);
        } else {
          run.endRequested = true; // settle once startRun finishes opening
        }
      }
    }
  }, [duel.phase, startRun, settleRun]);

  // Wrap reset so a New Duel also rolls the tunnel over to a fresh run.
  const wrappedDuel = useMemo<UsePaintDuel>(
    () => ({
      ...duel,
      reset: () => {
        resetRun();
        duel.reset();
      },
    }),
    [duel, resetRun],
  );

  return { duel: wrappedDuel, status };
}
