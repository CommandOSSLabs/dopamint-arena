import { useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { BOMB_IT_MIN_STAKE } from "sui-tunnel-ts/protocol/bombIt";
import type { BombItMove, BombItAction } from "sui-tunnel-ts/protocol/bombIt";
import {
  MultiGameBombItProtocol,
  type MultiGameBombItState,
} from "sui-tunnel-ts/protocol/multiGameBombIt";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import type { TelemetryWriter } from "../../telemetry/TelemetryProvider";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "../../backend/controlPlane";
import { settleViaBackend } from "../../backend/settle";
import {
  closeCooperativeWithRoot,
  openAndFundSelfPlay,
  readCreatedAt,
} from "../../onchain/tunnelTx";
import { useSponsoredSignExec } from "../../onchain/useSponsoredSignExec";
import { withSponsorFallback } from "../../onchain/sponsor";
import {
  DOPAMINT_COIN_TYPE,
  isDopamintConfigured,
} from "../../onchain/dopamint";
import {
  deriveMultiView,
  kickoffNextGame,
  sessionResult,
  stepMultiGame,
  SOLO_STEP_MS,
  type BombItView,
  type BombItResult,
} from "./session-core";

/**
 * Bomb It is a REACTION game, so its solo loop advances ONE co-signed tick per SOLO_STEP_MS
 * rather than batching many ticks per frame like chicken-cross's throughput showcase. That keeps
 * the bomb fuse and the bot fight legible (fuse ≈ FUSE_TICKS * SOLO_STEP_MS ≈ 1s) — at the batched
 * rate the 8-tick fuse burned in ~50ms, so a manual drop was instant death and a bot duel a blur.
 * One tick per interval is also negligible crypto per frame, so the CPU stays cool without a cap.
 */

/** A beat between finished duels so the result + updated score register before the rematch. */
const BOMB_REMATCH_MS = 700;

/** DOPAMINT bank locked per seat (1 DOPAMINT, 9 decimals) — funds MANY per-game stakes. */
const LOCKED_PER_SEAT = 1_000_000_000n;
/** SUI-fallback bank per seat (MIST), when the DOPAMINT env is unset. */
const SUI_PER_SEAT = 500n;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type SessionStatus =
  | "idle"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

export interface BombItSession {
  status: SessionStatus;
  view: BombItView | null;
  result: BombItResult | null;
  stake: number;
  error: string | null;
  /** Auto mode: when on (default), a bot autopilots your seat; off = you play it yourself. */
  auto: boolean;
  /** Wins this session (one tunnel, many duels): `you` = bomber A's wins, `foe` = bomber B's. */
  score: { you: number; foe: number };
  /** Completed duels behind the current one (the running duel is `gamesPlayed + 1`). */
  gamesPlayed: number;
  start: (stake: number) => void;
  reset: () => void;
  queueAction: (a: BombItAction) => void;
  toggleAuto: () => void;
  /** Settle + close the tunnel NOW at the current co-signed state — cash out anytime. */
  settleNow: () => void;
}

/** You always sit in seat A for a solo match; seat B is the bot opponent. */
const HUMAN_SEAT = "A" as const;

/** React-supplied capabilities, refreshed each render (wallet may connect later). */
interface BombDeps {
  report: TelemetryWriter;
  account: { address: string } | null;
  client: unknown;
  signExec: (tx: never) => Promise<{ digest: string }>;
  /** Backend-gas-sponsored signer (ADR-0009); falls back to signExec when the sponsor is down. */
  sponsoredSignExec: (tx: never) => Promise<{ digest: string }>;
  /** Pick a user coin to fund the (both-seat) bank; gas is sponsored, the stake is not. */
  selectStakeCoin: (minAmount: bigint) => Promise<string>;
  /** DOPAMINT stake: faucet (invisibly, sponsored) if short, then return a stake coin id. */
  prepareStake: (minAmount: bigint) => Promise<string>;
}

interface BombSnapshot {
  status: SessionStatus;
  view: BombItView | null;
  result: BombItResult | null;
  stake: number;
  error: string | null;
  auto: boolean;
  score: { you: number; foe: number };
  gamesPlayed: number;
}

/**
 * The solo (bot-vs-bot self-play) Bomb It session, kept OUT of React so it survives the window
 * unmounting (minimize / maximize / desktop reflow). One funded tunnel hosts MANY duels; the
 * player settles once on demand. The component subscribes to it; only an explicit window close
 * disposes it. See `lib/windowSessions`.
 */
class BombBotSession {
  deps: BombDeps | null = null;

  private status: SessionStatus = "idle";
  private view: BombItView | null = null;
  private result: BombItResult | null = null;
  private error: string | null = null;
  // Autopilot: when on (default), the driver steers seat A too, so the whole duel plays
  // itself. Lives on the session, not React, because the off-React advance loop reads it
  // each step.
  private auto = true;
  private snap: BombSnapshot = {
    status: "idle",
    view: null,
    result: null,
    stake: 0,
    error: null,
    auto: true,
    score: { you: 0, foe: 0 },
    gamesPlayed: 0,
  };
  private listeners = new Set<() => void>();

  private tunnel: OffchainTunnel<MultiGameBombItState, BombItMove> | null = null;
  private protocol: MultiGameBombItProtocol | null = null;
  // One tunnel hosts many duels; settlement is player-driven. `settleRequested`
  // stops the auto-rematch loop, `score`/`lastScoredGames` track the running tally.
  private settleRequested = false;
  private score = { you: 0, foe: 0 };
  private lastScoredGames = -1;
  private txnId = 0;
  private stake = 0;
  private tunnelId = "";
  private createdAt = 0n;
  private transcript: Transcript | null = null;
  private onChain = false;
  private advancing = false;
  // Guards re-entry: a session that has begun a duel can't be restarted (only
  // reset()/Play Again returns it to idle). Stops StrictMode / double-click dupes.
  private starting = false;
  // When auto is off, the player queues a seat-A action; the loop consumes it once.
  private pendingAction: BombItAction | undefined = undefined;
  // Bumped on reset/dispose so an in-flight advance loop knows to abandon ship.
  private gen = 0;
  // Control-plane TPS heartbeat (ADR-0002, self-play contract). The backend derives
  // live TPS from action COUNTS we send — never a rate. Registered once per match;
  // each co-signed update bumps `actions`/`moveCount`, flushed as a throttled window.
  private session: RegisterSessionResult | null = null;
  private moveCount = 0;
  private actions = 0;
  private lastHeartbeat = 0;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): BombSnapshot => this.snap;

  private emit() {
    this.snap = {
      status: this.status,
      view: this.view,
      result: this.result,
      stake: this.stake,
      error: this.error,
      auto: this.auto,
      score: this.score,
      gamesPlayed: this.tunnel?.state.gamesPlayed ?? 0,
    };
    for (const l of this.listeners) l();
  }
  private setStatus(s: SessionStatus) {
    this.status = s;
    this.emit();
  }
  private fail(e: unknown) {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }
  private pushView() {
    if (this.tunnel) this.view = deriveMultiView(this.tunnel.state);
    this.emit();
  }

  reset = () => {
    this.gen += 1;
    this.advancing = false;
    this.starting = false;
    this.settleRequested = false;
    this.tunnel = null;
    this.protocol = null;
    this.transcript = null;
    this.session = null;
    this.score = { you: 0, foe: 0 };
    this.lastScoredGames = -1;
    this.txnId = 0;
    this.pendingAction = undefined;
    this.deps?.report.setActive(0);
    this.status = "idle";
    this.view = null;
    this.result = null;
    this.stake = 0;
    this.error = null;
    this.emit();
  };

  dispose = () => {
    this.gen += 1;
    this.advancing = false;
    this.deps?.report.setActive(0);
    this.tunnel = null;
    this.protocol = null;
    this.transcript = null;
    this.session = null;
    this.listeners.clear();
  };

  /**
   * Throttled control-plane heartbeat (ADR-0002, self-play TPS contract). Sends the
   * action COUNT accumulated since the last flush — never a rate; the backend is the
   * single clock and derives TPS from the counts. Self-throttles to ~1/s unless
   * `force` (the tail flush at settle, so the final partial window isn't dropped).
   */
  private flushHeartbeat(force: boolean) {
    const s = this.session;
    if (!s || this.actions === 0) return;
    const now = Date.now();
    const windowMs = now - this.lastHeartbeat;
    if (!force && windowMs < 1000) return;
    const actionsDelta = this.actions;
    this.actions = 0;
    this.lastHeartbeat = now;
    getControlPlaneClient()
      .sendHeartbeat(s.sessionId, s.statsToken, {
        tunnelId: this.tunnelId,
        nonce: String(this.moveCount),
        actionsDelta,
        windowMs: Math.max(1, windowMs),
      })
      .catch((e) => console.error("[bomb-it] heartbeat failed:", e));
  }

  /** Tally the just-finished inner duel once (keyed by gamesPlayed). Draw/null → no tally. */
  private recordGameResult() {
    if (!this.tunnel) return;
    const game = this.tunnel.state.gamesPlayed;
    if (game === this.lastScoredGames) return;
    const winner = this.tunnel.state.inner.winner; // "A" | "B" | "draw" | null
    this.lastScoredGames = game;
    if (winner === "A") this.score = { ...this.score, you: this.score.you + 1 };
    else if (winner === "B")
      this.score = { ...this.score, foe: this.score.foe + 1 };
    // One "My Activity" row per decided duel (skip draws/pushes), mirroring battleship.
    if (winner === "A" || winner === "B") {
      this.deps?.report.pushLocalTxn({
        id: (this.txnId += 1),
        game: "bomb-it",
        time: new Date().toLocaleTimeString("en-GB"),
        bot: "You",
        type: winner === "A" ? "Bot Win" : "Bot Loss",
        status: "Success",
        amount: "",
      });
    }
    // winner "draw"/null = no tally, duel still counts toward gamesPlayed.
  }

  /**
   * Drive the multi-game duel. Bomb It is a reaction game, so it co-signs ONE tick per
   * SOLO_STEP_MS (the human-scale cadence the fuse needs) — not cross's per-frame batch.
   * Across duel boundaries: when a duel ends, record the result and EITHER loop into the
   * next duel on the same tunnel (autopilot on, fundable, no settle pending) OR stop and
   * leave the result on screen. Settlement is never automatic — the player calls {@link settleNow}.
   */
  private advance = async () => {
    if (this.advancing) return;
    this.advancing = true;
    const myGen = this.gen;
    const tunnel = this.tunnel;
    const protocol = this.protocol;
    try {
      while (tunnel && protocol) {
        // Manual: only act on the player's queued action; otherwise the seat stays put.
        const human = this.auto
          ? null
          : {
              seat: HUMAN_SEAT,
              getAction: () => {
                const a = this.pendingAction ?? "stay";
                this.pendingAction = undefined;
                return a;
              },
            };
        const boundary = stepMultiGame(protocol, tunnel, Math.random, human);
        if (boundary === "stepped") {
          this.moveCount += 1;
          this.actions += 1;
          this.pushView();
          this.flushHeartbeat(false);
          await sleep(SOLO_STEP_MS);
          if (this.gen !== myGen || this.tunnel !== tunnel) return;
          continue;
        }
        this.pushView();
        if (boundary === "session-over") {
          this.recordGameResult(); // tally the final decided duel (idempotent via lastScoredGames)
          this.pushView();
          break; // exhausted — leave for settle
        }
        // boundary === "game-over": record, then rematch (auto) or stop.
        this.recordGameResult();
        this.pushView();
        if (!this.auto || this.settleRequested) break;
        await sleep(BOMB_REMATCH_MS); // a beat so the result + score register
        if (this.gen !== myGen || this.tunnel !== tunnel) return;
        kickoffNextGame(tunnel);
        this.pushView();
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.advancing = false;
    }
  };

  start = (nextStake: number) => {
    const deps = this.deps;
    if (!deps) return;
    // Solo play is on-chain only: a connected wallet funds + settles the self-play
    // tunnel (gas sponsored, DOPAMINT stake). No wallet → require connect, not a demo.
    if (!deps.account) {
      this.error = "connect a wallet to stake the tunnel";
      this.status = "error";
      this.emit();
      return;
    }
    // Only a fresh/idle session may start; a live duel never restarts itself.
    if (this.starting || this.status !== "idle") return;
    this.starting = true;
    this.gen += 1;
    this.error = null;
    this.result = null;
    this.settleRequested = false;
    this.score = { you: 0, foe: 0 };
    this.lastScoredGames = -1;
    this.txnId = 0;
    this.pendingAction = undefined;

    // Per-game stake from the lobby (the small swap), floored at BOMB_IT_MIN_STAKE.
    const floored = Math.floor(nextStake);
    const stakePerGame = BigInt(
      Math.max(Number(BOMB_IT_MIN_STAKE), Number.isFinite(floored) ? floored : 0),
    );
    this.stake = Number(stakePerGame);
    this.emit();

    const a = createParticipant("bomber-a");
    const b = createParticipant("bomber-b");

    void (async () => {
      try {
        // The LARGE bank funded on-chain per seat (vs the small per-game stake). Multi-game
        // swaps `stakePerGame` per duel off this bank, so it survives MANY duels (not one).
        const fundedPerSeat = isDopamintConfigured
          ? LOCKED_PER_SEAT
          : SUI_PER_SEAT;

        const reads = deps.client as unknown as Parameters<
          typeof openAndFundSelfPlay
        >[0]["reads"];
        this.setStatus("funding");
        const partyA = { address: a.address, publicKey: a.keyPair.publicKey };
        const partyB = { address: b.address, publicKey: b.keyPair.publicKey };
        // DOPAMINT (ADR-0010): faucet both seats' bank invisibly (gas-sponsored) and stake
        // DOPAMINT — free for a 0-SUI player. SUI path (DOPAMINT env unset): sponsored SUI
        // stake with a sender-pays fallback (ADR-0009).
        const tunnelId = isDopamintConfigured
          ? await openAndFundSelfPlay({
              reads,
              signExec: deps.sponsoredSignExec as never,
              partyA,
              partyB,
              aAmount: fundedPerSeat,
              bAmount: fundedPerSeat,
              coinType: DOPAMINT_COIN_TYPE,
              stakeCoinId: await deps.prepareStake(2n * fundedPerSeat),
            })
          : await withSponsorFallback(
              async () =>
                openAndFundSelfPlay({
                  reads,
                  signExec: deps.sponsoredSignExec as never,
                  partyA,
                  partyB,
                  aAmount: fundedPerSeat,
                  bAmount: fundedPerSeat,
                  stakeCoinId: await deps.selectStakeCoin(2n * fundedPerSeat),
                }),
              () =>
                openAndFundSelfPlay({
                  reads,
                  signExec: deps.signExec as never,
                  partyA,
                  partyB,
                  aAmount: fundedPerSeat,
                  bAmount: fundedPerSeat,
                }),
              "bombIt open/fund",
            );
        const createdAt = await readCreatedAt(reads, tunnelId);

        // Multi-game: many duels on one funded tunnel; the player settles once. The per-game
        // stake is the SMALL swap, the funded bank above is what survives across duels.
        const protocol = new MultiGameBombItProtocol(tunnelId, stakePerGame);
        const tunnel = OffchainTunnel.selfPlay(
          protocol,
          tunnelId,
          a.keyPair,
          b.keyPair,
          a.address,
          b.address,
          { a: fundedPerSeat, b: fundedPerSeat },
        );
        // Record every co-signed update so the close can anchor the transcript root on-chain
        // (close_cooperative_with_root) and the backend can archive the proof to Walrus.
        const transcript = new Transcript(tunnelId);
        tunnel.onUpdate = (u, bytes) => {
          transcript.append(u);
          // One co-signed update = one action for the control-plane TPS count (ADR-0002);
          // moveCount is the monotonic nonce. Flush is self-throttled (~1/s).
          this.moveCount += 1;
          this.actions += 1;
          this.deps?.report.bumpCounters({
            updates: 1,
            signatures: 2,
            verifications: 2,
            bytes,
          });
          this.flushHeartbeat(false);
        };

        this.tunnel = tunnel;
        this.protocol = protocol;
        this.transcript = transcript;
        this.tunnelId = tunnelId;
        this.createdAt = createdAt;
        this.onChain = true;

        // Register the on-chain tunnel for control-plane TPS stats (ADR-0002). Best-effort:
        // the backend is never in the per-move loop, so a failed register must not block play.
        this.session = null;
        this.moveCount = 0;
        this.actions = 0;
        this.lastHeartbeat = Date.now();
        getControlPlaneClient()
          .registerSession({
            userAddress: a.address,
            game: "bomb-it",
            tunnels: [{ tunnelId, partyA: a.address, partyB: b.address }],
          })
          .then((s) => {
            this.session = s;
          })
          .catch((e) => console.error("[bomb-it] registerSession failed:", e));

        this.deps?.report.bumpCounters({ tunnelsOpened: 1 });
        this.deps?.report.setActive(2);
        this.starting = false;
        this.setStatus("playing");
        this.pushView();
        void this.advance();
      } catch (e) {
        this.starting = false;
        this.deps?.report.setActive(0);
        this.fail(e);
      }
    })();
  };

  /**
   * Close the tunnel NOW at the current co-signed state — allowed anytime, even mid-duel
   * (which pays out the net of finished duels and voids the running one). Stops the
   * autopilot loop first so nothing steps while the close is built. Anchors the
   * transcript root on-chain (close_cooperative_with_root), settling through the backend.
   */
  private settle = async () => {
    const tunnel = this.tunnel;
    if (!tunnel) return;
    this.result = sessionResult(tunnel.state.inner);
    this.setStatus("settling");
    // Tail flush before the close so the final partial window's actions aren't dropped.
    this.flushHeartbeat(true);
    this.deps?.report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
    this.deps?.report.setActive(0);
    if (!this.onChain || !this.deps) {
      this.setStatus("settled"); // safety: no open tunnel to close (shouldn't happen post-start)
      return;
    }
    try {
      // Settle through the backend /settle API: the server submits the close AND archives the
      // transcript to Walrus (ADR-0002/0005). Fall back to a sponsored/wallet close if it's down.
      const deps = this.deps; // non-null past the guard above; capture for the fallback closure
      const transcript = this.transcript;
      const settlement = tunnel.buildSettlementWithRoot(
        this.createdAt,
        transcript ? transcript.root() : new Uint8Array(32),
        0n,
      );
      const coinType = isDopamintConfigured ? DOPAMINT_COIN_TYPE : undefined;
      // DOPAMINT path closes via the gas sponsor too (so a 0-SUI player can close their
      // bot game for free); SUI path closes sender-pays. coinType must match the tunnel's coin.
      await settleViaBackend({
        tunnelId: this.tunnelId,
        settlement,
        transcript: transcript ? transcript.toRecord().entries : [],
        label: "bombIt",
        fallbackClose: () =>
          closeCooperativeWithRoot({
            signExec: (isDopamintConfigured
              ? deps.sponsoredSignExec
              : deps.signExec) as never,
            tunnelId: this.tunnelId,
            settlement,
            coinType,
          }),
      });
      this.setStatus("settled");
    } catch (e) {
      this.fail(e);
    }
  };

  queueAction = (a: BombItAction) => {
    this.pendingAction = a;
  };

  toggleAuto = () => {
    this.auto = !this.auto;
    this.pendingAction = undefined;
    this.emit();
    // Turning autopilot on while a duel is live: kick the driver so it steers / loops.
    if (this.auto && this.status === "playing") void this.advance();
  };

  /** Settle + close the tunnel NOW at the current co-signed state — cash out anytime,
   *  even mid-duel. Stops the autopilot loop first so nothing steps during the close. */
  settleNow = () => {
    if (this.status !== "playing") return;
    this.settleRequested = true;
    this.gen += 1; // make the in-flight advance loop bail before its next step
    this.advancing = false;
    void this.settle();
  };
}

const bombSessions = new Map<string, BombBotSession>();

function getBombSession(windowId: string): BombBotSession {
  let session = bombSessions.get(windowId);
  if (!session) {
    session = new BombBotSession();
    bombSessions.set(windowId, session);
    const created = session;
    registerWindowDisposer(windowId, "bomb-it-bot", () => {
      created.dispose();
      bombSessions.delete(windowId);
    });
  }
  return session;
}

export function useBombItSession(windowId: string): BombItSession {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();

  const session = getBombSession(windowId);
  session.deps = {
    report,
    account,
    client,
    signExec: (async (
      tx: Parameters<typeof signAndExecute>[0]["transaction"],
    ) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    }) as never,
    sponsoredSignExec: sponsored.signExec as never,
    selectStakeCoin: sponsored.selectStakeCoin,
    prepareStake: sponsored.prepareStake,
  };

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    status: snap.status,
    view: snap.view,
    result: snap.result,
    stake: snap.stake,
    error: snap.error,
    auto: snap.auto,
    score: snap.score,
    gamesPlayed: snap.gamesPlayed,
    start: session.start,
    reset: session.reset,
    queueAction: session.queueAction,
    toggleAuto: session.toggleAuto,
    settleNow: session.settleNow,
  };
}
