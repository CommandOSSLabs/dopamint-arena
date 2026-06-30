/**
 * One PvP match, worker-side — the per-match half of the shared {@link PvpHub} (M1: all PvP
 * windows multiplex over ONE relay socket). Ported from the former single-match `PvpEngine`:
 * the ONLY behavioural changes are that the socket is INJECTED (the hub owns the shared
 * `MpClient`) and teardown `releaseMatch`es this match instead of `close()`-ing the socket.
 *
 * Owns this match's `DistributedTunnel`, ephemeral signing, transcript, resume wiring, and the
 * coalesced snapshot it emits back to its window. Covers findMatch → fund → play → settle, warm
 * reconnect resync (driven by the hub's shared socket), and cold-load resume.
 *
 * Resume records persist in the worker's own IndexedDB (`persist/idb.ts`) — `localStorage` is
 * absent in workers, and keeping records worker-side confines the ephemeral key + game secret to
 * this thread (design §5/§6); they never transit the main heap or the bridge.
 */
import { type MpClient, type PvpChannel, type Role } from "@/pvp/mpClient";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { getControlPlaneClient } from "@/backend/controlPlane";
import { coSignedToSettleBody } from "@/backend/settleRequest";
import { attachResume, rebuildTunnel } from "@/pvp/resumeSession";
import type { ResumeRecord } from "@/pvp/resume";
import { resumeIdb } from "./persist/idb";
import { elog, emark } from "./debug";
import type {
  ConnStatus,
  EngineConfig,
  EngineStatus,
  GameId,
  GameSessionSpec,
  MainBridge,
  MatchController,
  MatchIo,
  MatchSnapshot,
} from "./engineApi";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySpec = GameSessionSpec<any, any, any, any, any>;
type AnyController = MatchController<any, any, any, any, any>;
type AnyTunnel = DistributedTunnel<any, any>;

/** Static identity the resume layer + settle need, shared by the live and cold-load paths. */
interface ActivateInfo {
  matchId: string;
  tunnelId: string;
  role: Role;
  game: GameId;
  opponentWallet: string;
  opponentPubkeyHex: string;
  selfEphemeralSecretHex: string;
}

/** What the hub injects into each session: the shared socket, the static wiring, and the sinks
 *  the session reports through. `connStatus` is a getter because the socket lifecycle is shared
 *  (hub-owned) — a drop/resume affects every session at once. */
export interface SessionDeps {
  windowId: string;
  /** The hub's shared, already-connected `MpClient` (one socket for all PvP windows). */
  mp: MpClient;
  config: EngineConfig;
  bridge: MainBridge;
  getSpec: (gameId: GameId) => AnySpec | undefined;
  /** Push a coalesced snapshot for this window (the hub tags it with `windowId`). */
  emit: (snap: MatchSnapshot) => void;
  /** The shared socket's current lifecycle (hub-tracked). */
  connStatus: () => ConnStatus;
}

/** Buffer peer messages so a waiter never misses one that arrived early (port of makeInbox). */
function makeInbox(channel: PvpChannel) {
  const buf = new Map<string, unknown>();
  const waiters = new Map<string, (m: unknown) => void>();
  channel.onPeer((m) => {
    const w = waiters.get(m.t);
    if (w) {
      waiters.delete(m.t);
      w(m);
    } else {
      buf.set(m.t, m);
    }
  });
  return <T = unknown>(t: string): Promise<T> =>
    new Promise((res) => {
      const b = buf.get(t);
      if (b) {
        buf.delete(t);
        res(b as T);
      } else {
        waiters.set(t, res as (m: unknown) => void);
      }
    });
}

export class PvpMatchSession {
  private spec: AnySpec | null = null;
  private controller: AnyController | null = null;
  private dt: AnyTunnel | null = null;
  private detachResume: (() => void) | null = null;

  private status: EngineStatus = "idle";
  private role: Role | null = null;
  private auto = true;
  private opponentWallet: string | null = null;
  private error: string | null = null;
  /** This match's relay id, set once matched; `reset` releases it from the shared socket. */
  private matchId: string | null = null;
  /** intentId of a seat-A open still queued in the main-thread bulk-open window (design §4.1),
   *  else null. `reset()` cancels it via the bridge so a torn-down match never opens an orphan
   *  tunnel; cleared once the open resolves/rejects. */
  private pendingOpenIntentId: string | null = null;
  /**
   * Concurrency + abort guards (defect #2). `busy` rejects a second findMatch/resume for this same
   * window while one is mid-flight (without it, a resume's async gap let a findMatch fund a second
   * tunnel). `gen` bumps on reset so an in-flight findMatch that already passed an await bails
   * instead of resurrecting a torn-down match (the shared socket is no longer ours to identify by).
   */
  private busy = false;
  private gen = 0;

  constructor(private readonly deps: SessionDeps) {}

  // --- per-session command surface (the hub routes by windowId) ----------------------------

  /** Queue a human input (fire/intent); the controller proposes if it's due. */
  submitInput(input: unknown): void {
    this.controller?.onInput(input);
  }

  /** Toggle autopilot for this seat and re-evaluate whether to propose. */
  setAuto(on: boolean): void {
    this.auto = on;
    this.controller?.setAuto(on);
    this.emit();
  }

  private io(): MatchIo<any, any> {
    return {
      role: this.role as Role,
      tunnel: () => this.dt,
      auto: () => this.auto,
      emitView: () => this.emit(),
    };
  }

  private fail(e: unknown): void {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }

  // --- Snapshot coalescing (no rAF in a worker; pause while hidden) ------------------------
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private visible = true;

  private emit(): void {
    this.dirty = true;
    if (!this.visible || this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 16);
  }

  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const dt = this.dt;
    const view =
      dt && this.controller
        ? this.controller.deriveView(dt.displayState)
        : null;
    const snap: MatchSnapshot = {
      status: this.status,
      role: this.role,
      auto: this.auto,
      stake: this.spec ? Number(this.spec.stake) : 0,
      view,
      winner: dt ? dt.state.winner : null,
      opponentWallet: this.opponentWallet,
      tunnelId: dt ? dt.tunnelId : null,
      // The socket lifecycle is shared across all PvP windows (hub-tracked), so read it lazily.
      connStatus: this.deps.connStatus(),
      error: this.error,
      // Cumulative co-signed updates (the tunnel nonce) so main can feed this window's local TPS.
      moves: dt ? Number(dt.nonce) : 0,
    };
    // Comlink proxy: fire-and-forget (returns a Promise we ignore); coalesced upstream so the
    // per-call RPC cost is negligible (design §7).
    this.deps.emit(snap);
  }

  setVisibility(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      if (this.dirty) this.flush();
    } else if (this.flushTimer !== null) {
      // Drop an already-armed flush so no snapshot posts while hidden; emit() re-arms on show.
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Force a coalesced re-emit — the hub calls this on all sessions when the SHARED socket's
   *  lifecycle changes (drop/reconnect), since `connStatus` is read lazily from the hub. */
  refreshConn(): void {
    this.emit();
  }

  /**
   * Orphan-tunnel cancel (design §4.1): if a seat-A open is still queued in the main-thread
   * bulk-open window, cancel it so this torn-down match never opens a tunnel (and consumes stake).
   * Awaited by `reset()` so the hub can let the cancel land before reclaiming the window. If the
   * intent already flushed into an in-flight PTB the bridge no-ops and `findMatch` bails on its own
   * generation guard — so this never crashes.
   */
  private async cancelPendingOpen(): Promise<void> {
    const intentId = this.pendingOpenIntentId;
    if (!intentId) return;
    this.pendingOpenIntentId = null;
    try {
      await this.deps.bridge.cancelOpen(intentId);
    } catch {
      /* open already resolved — nothing left to cancel */
    }
  }

  async reset(): Promise<void> {
    this.gen += 1; // abort any in-flight findMatch/resume past its next await
    await this.cancelPendingOpen();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.dirty = false;
    this.detachResume?.();
    this.detachResume = null;
    this.controller?.dispose();
    // Release THIS match from the shared socket — never close the socket (other windows use it).
    if (this.matchId) this.deps.mp.releaseMatch(this.matchId);
    this.matchId = null;
    this.dt = null;
    this.controller = null;
    this.role = null;
    this.auto = true;
    this.opponentWallet = null;
    this.error = null;
    this.status = "idle";
    this.busy = false;
    this.emit();
  }

  async findMatch(gameId: GameId, setup?: unknown): Promise<void> {
    if (this.busy) return; // a findMatch/resume is already in flight for this window (defect #2)
    this.busy = true;
    const myGen = this.gen;
    const config = this.deps.config;
    const spec = this.deps.getSpec(gameId);
    if (!spec) {
      this.busy = false;
      this.fail(new Error(`engine not ready for game '${gameId}'`));
      return;
    }
    this.spec = spec;
    try {
      this.error = null;
      const tMatch = emark("match", `findMatch ${gameId}`);
      this.status = "matching";
      this.emit();

      const ephemeral: KeyPair = generateKeyPair();
      const wallet = config.wallet;
      const mp = this.deps.mp; // shared, already connected by the hub
      // Composite matchmaking key when the spec derives one from setup (ttt/caro board size, §13);
      // else the bare gameId — so the in-scope games queue exactly as before.
      const matchKey = spec.matchmakingKey?.(setup) ?? gameId;
      const match = await mp.quickMatch(matchKey);
      if (this.gen !== myGen) return; // reset during matchmaking
      this.matchId = match.matchId;
      this.role = match.role;
      this.opponentWallet = match.opponentWallet;
      this.emit();
      elog("match", "matched", {
        window: this.deps.windowId,
        role: match.role,
        matchId: match.matchId,
      });

      const channel = mp.channel(match.matchId);
      const waitPeer = makeInbox(channel);

      const controller = spec.createMatch(this.io());
      this.controller = controller;
      controller.initSetup(setup);

      // 1) exchange ephemeral pubkeys (the wallet is only a matchmaking label).
      channel.sendPeer({
        t: "hello",
        ephemeralPubkey: toHex(ephemeral.publicKey),
      });
      const hello = await waitPeer<{ ephemeralPubkey: string }>("hello");
      const oppPub = fromHex(hello.ephemeralPubkey);

      // 2) fund on-chain via the bridge (role-asymmetric, interleaved with the relay).
      const bridge = this.deps.bridge;
      this.status = "funding";
      this.emit();
      const tFund = emark("match", `fund ${match.role}`);
      let tunnelId: string;
      if (match.role === "A") {
        // Tag this open so a teardown during the bulk-open window can cancel it (orphan-tunnel
        // cancel, design §4.1) before the job flushes a tunnel for a gone match. The id must be
        // unique across the whole (per-user, cross-window) bulk-open job, hence a UUID.
        const intentId = crypto.randomUUID();
        this.pendingOpenIntentId = intentId;
        const opened = await bridge
          .openTunnel(
            {
              partyA: { address: wallet, publicKey: ephemeral.publicKey },
              partyB: { address: match.opponentWallet, publicKey: oppPub },
              amount: spec.stake,
              label: gameId,
            },
            intentId,
          )
          .finally(() => {
            this.pendingOpenIntentId = null;
          });
        // The open could not be cancelled because it had already flushed into an in-flight PTB
        // (design §4.1). If the session was torn down meanwhile, the tunnel is orphaned (its stake
        // already consumed — the accepted cost of a flushed PTB); just bail rather than resurrect a
        // reset match. Detected via the generation counter (reset() bumps it).
        if (this.gen !== myGen) return;
        tunnelId = opened.tunnelId;
        mp.announceTunnel(match.matchId, tunnelId);
        channel.sendPeer({ t: "open", tunnelId });
      } else {
        const open = await waitPeer<{ tunnelId: string }>("open");
        if (this.gen !== myGen) return;
        tunnelId = open.tunnelId;
        await bridge.depositStake({
          tunnelId,
          amount: spec.stake,
          label: gameId,
        });
        if (this.gen !== myGen) return;
      }
      tFund();

      // 3) build the distributed engine over the relay transport.
      const backend = defaultBackend();
      const self = makeEndpoint(backend, wallet, ephemeral, true);
      const opp = makeEndpoint(
        backend,
        match.opponentWallet,
        { publicKey: oppPub, scheme: ephemeral.scheme },
        false,
      );
      const dt: AnyTunnel = new DistributedTunnel(
        spec.makeProtocol(setup),
        {
          tunnelId,
          self,
          opponent: opp,
          selfParty: match.role,
          moveCodec: spec.moveCodec,
        },
        channel.transport,
        { a: spec.stake, b: spec.stake },
      );
      this.dt = dt;
      this.activate(channel, waitPeer, {
        matchId: match.matchId,
        tunnelId,
        role: match.role,
        game: gameId,
        opponentWallet: match.opponentWallet,
        opponentPubkeyHex: toHex(oppPub),
        selfEphemeralSecretHex: toHex(ephemeral.secretKey),
      });

      // 4) readiness handshake before the opening commit can reach the peer.
      if (match.role === "A") {
        await waitPeer("ready");
      } else {
        channel.sendPeer({ t: "ready" });
      }
      if (this.gen !== myGen) return;
      controller.onConfirmed(); // kick the first due move
      tMatch();
      this.emit();
    } catch (e) {
      if (this.gen === myGen) this.fail(e);
    }
  }

  /** Cold-load: rebuild any persisted in-flight match for this game and re-attach to the shared
   *  socket. The hub guarantees the socket is connected before calling this. */
  async resume(gameId: GameId): Promise<void> {
    if (this.busy) return; // already in a live or resuming session (defect #2)
    this.busy = true;
    const myGen = this.gen;
    const config = this.deps.config;
    const spec = this.deps.getSpec(gameId);
    if (!spec) {
      this.busy = false;
      return;
    }
    this.spec = spec;
    let records: ResumeRecord[];
    try {
      records = await resumeIdb.getAllByGame(gameId);
    } catch {
      this.busy = false;
      return;
    }
    if (records.length === 0 || this.gen !== myGen) {
      this.busy = false;
      return;
    }
    try {
      const mp = this.deps.mp; // shared, already connected by the hub
      const controller = spec.createMatch(this.io());
      this.controller = controller;
      const adapter = controller.resumeAdapter?.();
      if (!adapter) {
        this.controller = null;
        this.busy = false;
        return;
      }
      // Most-recently-updated record wins, not lexical tunnelId order (defect #2).
      const rec = [...records].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      this.matchId = rec.matchId;
      this.role = rec.role;
      this.opponentWallet = rec.opponentWallet;
      const rebuilt = rebuildTunnel(
        mp,
        rec,
        { proto: spec.makeProtocol(), moveCodec: spec.moveCodec, adapter },
        { selfWallet: config.wallet },
      );
      this.dt = rebuilt.tunnel;
      this.activate(rebuilt.channel, makeInbox(rebuilt.channel), {
        matchId: rec.matchId,
        tunnelId: rec.tunnelId,
        role: rec.role,
        game: gameId,
        opponentWallet: rec.opponentWallet,
        opponentPubkeyHex: rec.opponentPubkeyHex,
        selfEphemeralSecretHex: rec.selfEphemeralSecretHex ?? "",
      });
      // The shared socket is already open, so send the resume frame explicitly (the connect-time
      // re-attach only covers matches registered before connect — design §5/§6, ADR-0016).
      mp.resumeMatch(rec.matchId);
      try {
        controller.onConfirmed(); // kick a due move
      } catch {
        /* a move is already in flight — the resync handshake converges it */
      }
      this.emit();
    } catch {
      try {
        for (const r of records) await resumeIdb.delete(r.tunnelId);
      } catch {
        /* best-effort cleanup */
      }
      void this.reset();
    }
  }

  /** Wire onConfirmed (transcript + drive + settle) + resume persistence/resync. Shared by the
   *  live (findMatch) and cold-load (resume) paths; the caller does the ready handshake. */
  private activate(
    channel: PvpChannel,
    waitPeer: ReturnType<typeof makeInbox>,
    info: ActivateInfo,
  ): void {
    const dt = this.dt as AnyTunnel;
    const controller = this.controller as AnyController;
    const proto = (this.spec as AnySpec).makeProtocol();
    const transcript = new Transcript(dt.tunnelId);
    let settling = false;
    dt.onConfirmed = (u) => {
      // Drive the controller BEFORE emitting: hidden-info games update view-local state
      // (e.g. battleship's lastEnemyShot) in onConfirmed, which the snapshot must reflect.
      transcript.append(u);
      elog("move", "confirmed", {
        game: info.game,
        nonce: dt.nonce.toString(),
      });
      controller.onConfirmed();
      this.emit();
      if (proto.isTerminal(dt.state) && !settling) {
        settling = true;
        this.status = "settling";
        this.emit();
        const tSettle = emark("settle", info.game);
        void this.settle(channel, waitPeer, transcript, info.tunnelId).then(
          () => {
            tSettle();
            controller.onSettled?.();
            this.status = "settled";
            this.emit();
            void resumeIdb.delete(info.tunnelId).catch(() => {});
          },
          (e) => this.fail(e),
        );
      }
    };

    // Resume: persist on confirm/propose (eager write to the worker's own IndexedDB) + run the
    // resync handshake on reconnect. attachResume wraps the onConfirmed set above (preserving it).
    const adapter = controller.resumeAdapter?.();
    if (adapter) {
      this.detachResume?.();
      this.detachResume = attachResume({
        mp: this.deps.mp,
        channel,
        tunnel: dt,
        adapter,
        identity: {
          matchId: info.matchId,
          tunnelId: info.tunnelId,
          role: info.role,
          game: info.game,
          opponentWallet: info.opponentWallet,
          opponentPubkeyHex: info.opponentPubkeyHex,
          selfEphemeralSecretHex: info.selfEphemeralSecretHex,
        },
        persist: (rec) => {
          void resumeIdb.put(rec).catch(() => {});
        },
      });
    }

    this.status = "playing";
    this.emit();
  }

  private async settle(
    channel: PvpChannel,
    waitPeer: ReturnType<typeof makeInbox>,
    transcript: Transcript,
    tunnelId: string,
  ): Promise<void> {
    const dt = this.dt as AnyTunnel;
    const bridge = this.deps.bridge;
    const createdAt = await bridge.readCreatedAt(tunnelId);
    const root = transcript.root();
    const half = dt.buildSettlementHalfWithRoot(createdAt, root, 0n);
    channel.sendPeer({
      t: "settleHalf",
      partyABalance: half.settlement.partyABalance.toString(),
      partyBBalance: half.settlement.partyBBalance.toString(),
      finalNonce: half.settlement.finalNonce.toString(),
      timestamp: half.settlement.timestamp.toString(),
      transcriptRoot: toHex(root),
      sig: toHex(half.sigSelf),
    });
    const other = await waitPeer<{ sig: string; transcriptRoot: string }>(
      "settleHalf",
    );
    if (other.transcriptRoot !== toHex(root)) {
      throw new Error("settlement transcript-root mismatch between parties");
    }
    const co = dt.combineSettlementWithRoot(
      half.settlement,
      half.sigSelf,
      fromHex(other.sig),
    );
    if (this.role !== "A") return; // single submitter, mirrors the cooperative-close pattern
    try {
      await getControlPlaneClient().settle(
        tunnelId,
        coSignedToSettleBody(co, transcript.rawEntries()),
      );
    } catch {
      await bridge.closeFallback({ tunnelId, settlement: co });
    }
  }
}
