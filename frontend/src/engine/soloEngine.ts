/**
 * Worker-side SELF-PLAY (bot-vs-bot) session — the solo-lane sibling of {@link PvpEngine}, ported
 * from `games/_shared/soloSessionHook.ts`'s `SoloBotSession`. One funded tunnel hosts MANY duels;
 * the per-duel loop is pure crypto (`OffchainTunnel.selfPlay`, this process holds both ephemeral
 * keypairs), so the ONLY I/O is the one-signature open+fund and the one cooperative close — both
 * routed through the {@link MainBridge} exactly like PvP. That makes self-play fit the worker the
 * same way PvP does (design: frontend-tunnel-client-worker).
 *
 * Reuses the engine/ infra: the bridge, the device-tier-capped per-window worker, and the same
 * coalesced-snapshot machinery as PvpEngine (dirty + 16 ms flush + visibility pause). Resume is
 * stubbed for now (self-play records aren't persisted yet — see TODO on {@link reset}).
 */
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import type { Protocol } from "sui-tunnel-ts/protocol/Protocol";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "@/backend/controlPlane";
import { coSignedToSettleBody } from "@/backend/settleRequest";
import { isMtpsConfigured } from "@/onchain/mtps";
import { elog, emark } from "./debug";
import type {
  ConnStatus,
  EngineConfig,
  EngineStatus,
  GameId,
  MainBridge,
  MatchSnapshot,
  SoloGameSpec,
  SoloStepOutcome,
  SoloTakeIntent,
} from "./engineApi";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySoloSpec = SoloGameSpec<any, any, any, any, any>;
type AnyTunnel = OffchainTunnel<any, any>;

/** Autopilot throughput loop (shared with the legacy solo hook): co-sign up to MAX_STEPS_PER_FRAME
 *  ticks per FRAME_BUDGET_MS, then yield one frame — a fixed ~20% CPU duty so TPS is high yet cool. */
const FRAME_BUDGET_MS = 10;
const MAX_STEPS_PER_FRAME = 8;
/** Default beat between finished duels when a spec omits `rematchMs`. */
const DEFAULT_REMATCH_MS = 600;

/** DEFAULT large per-seat bank funded on-chain (vs the small per-duel stake): 500 MTPS
 *  (0-decimal whole tokens). One bank survives 500 per-duel swaps (each 1 MTPS) before
 *  re-funding. A spec may override via `SoloGameSpec.lockedPerSeat` (e.g. poker, whose
 *  bank IS its chip buy-in). */
const LOCKED_PER_SEAT = 500n;
const SUI_PER_SEAT = 500n;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export class SoloEngine {
  /** Comlink proxy whose methods RPC to main; required for open+fund and the close fallback. */
  private bridge: MainBridge | null = null;
  /** Comlink proxy; `flush` invokes it with each coalesced snapshot. */
  private onSnapshot: ((snap: MatchSnapshot) => void) | null = null;

  private config: EngineConfig | null = null;
  private spec: AnySoloSpec | null = null;
  private tunnel: AnyTunnel | null = null;
  private protocol: Protocol<any, any> | null = null;
  private bots: unknown = null;
  private transcript: Transcript | null = null;

  private status: EngineStatus = "idle";
  private connStatus: ConnStatus = "closed";
  private auto = true;
  private error: string | null = null;
  private tunnelId = "";
  /** Per-DUEL stake (number, for the snapshot); the funded bank is separate. */
  private stake = 0;
  private result: unknown = null;

  // Running tally across the multi-duel session (idempotent via lastScoredGames).
  private score = { you: 0, foe: 0 };
  private lastScoredGames = -1;
  // When auto is off, the player queues a seat-A intent; the advance loop consumes it once.
  private pendingIntent: unknown = undefined;
  // Guards advance re-entry; only one loop runs at a time.
  private advancing = false;
  // Bumped on reset / each new findSoloMatch so an in-flight open/loop abandons ship.
  private gen = 0;

  // Control-plane TPS heartbeat (ADR-0002): the backend derives live TPS from action COUNTS, never
  // a rate. Registered once per session; each co-signed update bumps the counters, flushed ~1/s.
  private session: RegisterSessionResult | null = null;
  private moveCount = 0;
  private actions = 0;
  private lastHeartbeat = 0;

  constructor(
    private readonly getSpec: (gameId: GameId) => AnySoloSpec | undefined,
  ) { }

  // --- Setup (mirrors PvpEngine; wired once at spawn by engine.worker.ts) -------------------

  init(config: EngineConfig): void {
    this.config = config;
  }

  attachBridge(bridge: MainBridge): void {
    this.bridge = bridge;
  }

  subscribe(onSnapshot: (snap: MatchSnapshot) => void): void {
    this.onSnapshot = onSnapshot;
  }

  /** Queue the take-over seat's next intent; the running advance loop consumes it once. */
  submitInput(input: unknown): void {
    this.pendingIntent = input;
  }

  /** Toggle autopilot for the player's seat. Turning it on mid-session re-kicks the loop. */
  setAuto(on: boolean): void {
    this.auto = on;
    this.pendingIntent = undefined;
    this.emit();
    if (this.auto && this.status === "playing") void this.advance();
  }

  private requireBridge(): MainBridge {
    if (!this.bridge) throw new Error("engine bridge not attached");
    return this.bridge;
  }

  private fail(e: unknown): void {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }

  // --- Snapshot coalescing (identical machinery to PvpEngine; no rAF in a worker) -----------
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Pause: two INDEPENDENT drivers gate BOTH the snapshot flush and the advance loop ---------
  // The tab being hidden (`tabVisible`, via setVisibility) and the cabinet hover-freeze
  // (`cabinetActive`, via setPaused) each pause on their own. The loop runs and snapshots flush only
  // when BOTH say "active"; tracking them separately stops one driver from un-pausing while the
  // other still wants paused. Crucially the loop check (not just the flush) reads `active`, so a
  // hidden tab / hovered cabinet STOPS the self-play co-signing instead of draining the funded bank
  // at full CPU off-screen — the flush-only pause was the original leak.
  private tabVisible = true;
  private cabinetActive = true;

  /** True only when neither pause driver is engaged: the loop may run and snapshots may flush. */
  private get active(): boolean {
    return this.tabVisible && this.cabinetActive;
  }

  private emit(): void {
    this.dirty = true;
    if (!this.active || this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 16);
  }

  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const tunnel = this.tunnel;
    const spec = this.spec;
    const view = tunnel && spec ? spec.deriveView(tunnel.state) : null;
    const snap: MatchSnapshot = {
      status: this.status,
      role: null,
      auto: this.auto,
      stake: this.stake,
      view,
      winner: tunnel ? (tunnel.state.inner?.winner ?? null) : null,
      opponentWallet: null,
      tunnelId: this.tunnelId || null,
      connStatus: this.connStatus,
      error: this.error,
      score: this.score,
      gamesPlayed: tunnel ? tunnel.state.gamesPlayed : 0,
      result: this.result,
    };
    this.onSnapshot?.(snap);
  }

  /**
   * Re-evaluate the two pause drivers after either flips. On RESUME (both active) flush any pending
   * snapshot and re-kick the advance loop; on PAUSE cancel the flush timer (the loop bails on its
   * own at the top of its next iteration via the `active` check). Idempotent.
   */
  private applyPauseState(): void {
    if (this.active) {
      if (this.dirty) this.flush();
      if (this.status === "playing") void this.advance();
    } else if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Tab/document-visibility driver (tab hidden ⇒ pause). Independent of {@link setPaused}. */
  setVisibility(visible: boolean): void {
    this.tabVisible = visible;
    this.applyPauseState();
  }

  /** Cabinet hover-freeze driver (hovered ⇒ pause). Independent of {@link setVisibility}. */
  setPaused(paused: boolean): void {
    this.cabinetActive = !paused;
    this.applyPauseState();
  }

  /**
   * On-demand cooperative cash-out: close the tunnel NOW at the current co-signed state via the SAME
   * {@link settle} path the advance loop runs at session-over (bank exhausted), but player-triggered
   * mid-session. Stops the advance loop first (gen bump) so nothing co-signs during the close.
   * Idempotent: a no-op unless a match is actively playing, so a second call while settling/settled
   * (or before funding completes) does nothing.
   */
  settleSolo(): void {
    if (this.status !== "playing") return;
    this.gen += 1; // make the in-flight advance loop bail before its next co-sign
    this.advancing = false;
    void this.settle();
  }

  async reset(): Promise<void> {
    // Bumping gen first makes any in-flight open/advance bail at its next checkpoint. TODO(resume):
    // a self-play tunnel opened just before reset is orphaned (its bank is the player's own bots'),
    // since solo opens aren't bulk-cancellable like PvP's; acceptable until solo resume lands.
    this.gen += 1;
    this.advancing = false;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.dirty = false;
    this.tunnel = null;
    this.protocol = null;
    this.bots = null;
    this.transcript = null;
    this.session = null;
    this.score = { you: 0, foe: 0 };
    this.lastScoredGames = -1;
    this.pendingIntent = undefined;
    this.tunnelId = "";
    this.stake = 0;
    this.result = null;
    this.auto = true;
    this.connStatus = "closed";
    this.error = null;
    this.status = "idle";
    this.emit();
  }

  /**
   * Open + fund BOTH ephemeral seats (one bridge signature), build the self-play tunnel, register
   * the control-plane session, and kick the multi-duel advance loop. `setup` optionally overrides
   * the per-duel stake (a number, or `{ stake }`), floored at the spec's stake.
   */
  async findSoloMatch(gameId: GameId, setup?: unknown): Promise<void> {
    const config = this.config;
    const spec = this.getSpec(gameId);
    if (!config || !spec) {
      this.fail(new Error(`solo engine not ready for game '${gameId}'`));
      return;
    }
    this.spec = spec;
    const myGen = ++this.gen;
    try {
      this.error = null;
      this.result = null;
      this.score = { you: 0, foe: 0 };
      this.lastScoredGames = -1;
      this.pendingIntent = undefined;
      const tMatch = emark("solo", `findSoloMatch ${gameId}`);
      this.status = "funding";
      this.connStatus = "open";

      const stakePerGame = resolveStake(setup, spec.stake);
      this.stake = Number(stakePerGame);
      this.emit();

      // A game whose on-chain balance IS its in-game stack (poker's chip buy-in) overrides the
      // default 1-MTPS bank so the funded seats equal the protocol's starting balances.
      const lockedPerSeat = spec.lockedPerSeat ?? LOCKED_PER_SEAT;
      const fundedPerSeat = isMtpsConfigured ? lockedPerSeat : SUI_PER_SEAT;
      const a = createParticipant(`${spec.game}-a`);
      const b = createParticipant(`${spec.game}-b`);

      const bridge = this.requireBridge();
      const tFund = emark("solo", `openSelfPlay ${gameId}`);
      const { tunnelId } = await bridge.openSelfPlay({
        partyA: { address: a.address, publicKey: a.keyPair.publicKey },
        partyB: { address: b.address, publicKey: b.keyPair.publicKey },
        aAmount: fundedPerSeat,
        bAmount: fundedPerSeat,
        label: spec.game,
      });
      tFund();
      // Torn down (reset/new match) during the open: the tunnel is orphaned — just bail.
      if (this.gen !== myGen) return;

      const protocol = spec.makeProtocol(tunnelId, stakePerGame);
      const bots = spec.makeBots(stakePerGame);
      const tunnel: AnyTunnel = OffchainTunnel.selfPlay(
        protocol,
        tunnelId,
        a.keyPair,
        b.keyPair,
        a.address,
        b.address,
        { a: fundedPerSeat, b: fundedPerSeat },
      );
      // Record every co-signed update so the close anchors the transcript root on-chain and the
      // backend can archive the proof. One update = one action for the TPS count (ADR-0002).
      const transcript = new Transcript(tunnelId);
      tunnel.onUpdate = (u) => {
        transcript.append(u);
        this.moveCount += 1;
        this.actions += 1;
        this.flushHeartbeat(false);
      };

      this.tunnel = tunnel;
      this.protocol = protocol;
      this.bots = bots;
      this.transcript = transcript;
      this.tunnelId = tunnelId;

      // Register for control-plane TPS stats (best-effort: the backend is never in the per-move
      // loop, so a failed register must not block play).
      this.session = null;
      this.moveCount = 0;
      this.actions = 0;
      this.lastHeartbeat = Date.now();
      void getControlPlaneClient()
        .registerSession({
          userAddress: a.address,
          game: spec.game,
          tunnels: [{ tunnelId, partyA: a.address, partyB: b.address }],
        })
        .then((s) => {
          this.session = s;
        })
        .catch((e) => elog("solo", "registerSession failed", e));

      tMatch();
      this.status = "playing";
      this.emit();
      void this.advance();
    } catch (e) {
      if (this.gen !== myGen) return;
      this.fail(e);
    }
  }

  /**
   * Drive the multi-duel session. AUTOPILOT batches co-signed ticks under a per-frame time budget;
   * MANUAL co-signs one legible tick per `manualStepMs` when set (so a fuse stays reactable), else
   * batches too. Across boundaries: on game-over either rematch on the same tunnel (autopilot) or
   * stop and leave the result; on session-over (bank exhausted) settle cooperatively.
   */
  private advance = async (): Promise<void> => {
    if (this.advancing) return;
    this.advancing = true;
    const myGen = this.gen;
    const tunnel = this.tunnel;
    const protocol = this.protocol;
    const bots = this.bots;
    const spec = this.spec;
    const take: SoloTakeIntent<unknown> = () => {
      const i = this.pendingIntent;
      this.pendingIntent = undefined;
      return i;
    };
    let sessionOver = false;
    try {
      while (tunnel && protocol && bots && spec) {
        // Paused (tab hidden or cabinet hover-freeze): stop co-signing here; `applyPauseState`
        // re-kicks the loop on resume. This is the bank-drain fix — pausing the LOOP, not just flush.
        if (!this.active) return;
        const manual = !this.auto;
        // A reaction game (manualStepMs set) co-signs ONE manual tick per frame so the fuse stays
        // legible; everything else batches as many ticks as fit the frame budget, then yields once.
        const oneShot = manual && spec.manualStepMs != null;
        let boundary: SoloStepOutcome = "stepped";
        if (oneShot) {
          boundary = spec.stepWith(protocol, tunnel, bots, take);
        } else {
          const deadline = performance.now() + FRAME_BUDGET_MS;
          for (let n = 0; n < MAX_STEPS_PER_FRAME; n++) {
            boundary = spec.stepWith(
              protocol,
              tunnel,
              bots,
              manual ? take : null,
            );
            if (boundary !== "stepped") break;
            if (performance.now() >= deadline) break;
          }
        }
        // Render runs once per frame (here), not per tick — the decoupling is what keeps TPS high
        // without pegging the CPU. The heartbeat is bumped per co-signed update in `onUpdate`.
        this.emit();
        if (boundary === "stepped") {
          await sleep(oneShot ? spec.manualStepMs! : 0);
          if (this.gen !== myGen || this.tunnel !== tunnel) return;
          continue;
        }
        if (boundary === "session-over") {
          this.recordGameResult(); // tally the final decided duel (idempotent)
          this.emit();
          sessionOver = true;
          break; // bank exhausted — settle below
        }
        // boundary === "game-over": record, then rematch (auto) or stop.
        this.recordGameResult();
        this.emit();
        if (!this.auto) break; // manual: leave the result on screen
        await sleep(spec.rematchMs ?? DEFAULT_REMATCH_MS);
        if (this.gen !== myGen || this.tunnel !== tunnel) return;
        spec.kickoffNextGame(tunnel);
        this.emit();
      }
      if (sessionOver && this.gen === myGen) await this.settle();
    } catch (e) {
      this.fail(e);
    } finally {
      this.advancing = false;
    }
  };

  /** Tally the just-finished inner duel once (keyed by gamesPlayed). Draw/null → no tally. */
  private recordGameResult(): void {
    const tunnel = this.tunnel;
    if (!tunnel) return;
    const game = tunnel.state.gamesPlayed;
    if (game === this.lastScoredGames) return;
    this.lastScoredGames = game;
    const winner = tunnel.state.inner.winner; // "A" | "B" | "draw" | null
    if (winner === "A") this.score = { ...this.score, you: this.score.you + 1 };
    else if (winner === "B")
      this.score = { ...this.score, foe: this.score.foe + 1 };
  }

  /**
   * Throttled control-plane heartbeat (ADR-0002): send the action COUNT accumulated since the last
   * flush — never a rate; the backend is the single clock. Self-throttles to ~1/s unless `force`
   * (the tail flush at settle, so the final partial window isn't dropped).
   */
  private flushHeartbeat(force: boolean): void {
    const s = this.session;
    if (!s || this.actions === 0) return;
    const now = Date.now();
    const windowMs = now - this.lastHeartbeat;
    if (!force && windowMs < 1000) return;
    const actionsDelta = this.actions;
    this.actions = 0;
    this.lastHeartbeat = now;
    void getControlPlaneClient()
      .sendHeartbeat(s.sessionId, s.statsToken, {
        tunnelId: this.tunnelId,
        nonce: String(this.moveCount),
        actionsDelta,
        windowMs: Math.max(1, windowMs),
      })
      .catch((e) => elog("solo", "heartbeat failed", e));
  }

  /**
   * Cooperative close at the current co-signed state: anchor the transcript root on-chain via the
   * backend `cp.settle` (server-sponsored close + Walrus archival, plain `fetch` in the worker),
   * falling back to a bridge wallet/sponsored close if that route is down (mirrors PvpEngine).
   */
  private async settle(): Promise<void> {
    const tunnel = this.tunnel;
    const spec = this.spec;
    if (!tunnel || !spec) return;
    this.result = spec.sessionResult(tunnel.state.inner);
    this.status = "settling";
    this.emit();
    this.flushHeartbeat(true); // tail flush so the final window's actions aren't dropped
    const tSettle = emark("solo", `settle ${spec.game}`);
    try {
      const bridge = this.requireBridge();
      const createdAt = await bridge.readCreatedAt(this.tunnelId);
      const root = this.transcript
        ? this.transcript.root()
        : new Uint8Array(32);
      const settlement = tunnel.buildSettlementWithRoot(createdAt, root, 0n);
      try {
        await getControlPlaneClient().settle(
          this.tunnelId,
          coSignedToSettleBody(
            settlement,
            this.transcript ? this.transcript.rawEntries() : [],
          ),
        );
      } catch (e) {
        elog("solo", "backend settle failed; bridge close fallback", e);
        await bridge.closeFallback({ tunnelId: this.tunnelId, settlement });
      }
      tSettle();
      this.status = "settled";
      this.emit();
    } catch (e) {
      this.fail(e);
    }
  }
}

/** The per-duel stake: an optional `setup` override (a number, or `{ stake }`) floored at the
 *  spec's stake. Mirrors the legacy solo hook's lobby-stake flooring. */
function resolveStake(setup: unknown, specStake: bigint): bigint {
  const requested =
    typeof setup === "number"
      ? setup
      : Number((setup as { stake?: number } | undefined)?.stake ?? 0);
  const floored = Number.isFinite(requested) ? Math.floor(requested) : 0;
  return BigInt(Math.max(Number(specStake), floored));
}
