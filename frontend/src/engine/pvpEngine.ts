/**
 * Generic worker-side PvP session — the port of `pvp/pvpMatchHook.ts`'s `PvpSession`,
 * parameterized per game by a `GameSessionSpec` and using the `MainBridge` (over the worker
 * boundary) for the few main-only ops (funding, settle-read, close fallback, resume-record
 * persistence). Owns the WebSocket, the `DistributedTunnel`, ephemeral signing, the
 * transcript, and the resume wiring.
 *
 * Covers findMatch → fund → play → settle, warm reconnect resync, and cold-load resume.
 * Resume records persist in the worker's own IndexedDB (`persist/idb.ts`) — `localStorage` is
 * absent in workers, and keeping records worker-side confines the ephemeral key + game secret
 * to this thread (design §5/§6); they never transit the main heap or the bridge.
 */
import {
  MpClient,
  resolveMpWsUrl,
  type PvpChannel,
  type Role,
} from "@/pvp/mpClient";
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

export class PvpEngine {
  /** Set via `attachBridge` (a Comlink proxy whose methods RPC to main); required for
   *  funding/settle. Nullable so the engine can be constructed before main wires it. */
  private bridge: MainBridge | null = null;
  /** Set via `subscribe` (a Comlink proxy); `flush` invokes it with each coalesced snapshot. */
  private onSnapshot: ((snap: MatchSnapshot) => void) | null = null;

  private config: EngineConfig | null = null;
  private spec: AnySpec | null = null;
  private controller: AnyController | null = null;
  private mp: MpClient | null = null;
  private dt: AnyTunnel | null = null;
  private detachResume: (() => void) | null = null;

  private status: EngineStatus = "idle";
  private role: Role | null = null;
  private auto = true;
  private opponentWallet: string | null = null;
  private connStatus: ConnStatus = "closed";
  private offConn: (() => void) | null = null;
  private error: string | null = null;
  /** intentId of a seat-A open still queued in the main-thread bulk-open window (design §4.1),
   *  else null. `reset()` cancels it via the bridge so a torn-down match never opens an orphan
   *  tunnel; cleared once the open resolves/rejects. */
  private pendingOpenIntentId: string | null = null;

  constructor(
    private readonly getSpec: (gameId: GameId) => AnySpec | undefined,
  ) {}

  // --- EngineApi surface (Comlink-exposed by engine.worker.ts) -----------------------------

  /** Bootstrap config; set once before the first match. */
  init(config: EngineConfig): void {
    this.config = config;
  }

  /** Wire the main-thread chain bridge (a Comlink proxy); set once before the first match. */
  attachBridge(bridge: MainBridge): void {
    this.bridge = bridge;
  }

  /** Register the coalesced-snapshot sink (a Comlink proxy); set once at spawn. */
  subscribe(onSnapshot: (snap: MatchSnapshot) => void): void {
    this.onSnapshot = onSnapshot;
  }

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

  /** The chain bridge must be attached (engineClient does so at spawn) before funding/settle;
   *  throwing here surfaces as the snapshot's `error` via the caller's `fail`. */
  private requireBridge(): MainBridge {
    if (!this.bridge) throw new Error("engine bridge not attached");
    return this.bridge;
  }

  /** Track the socket lifecycle so the snapshot's `connStatus` reflects reality (design §7).
   *  `MpClient` auto-reconnects, so an unexpected drop is "reconnecting" and a server-side
   *  resume returns to "open"; neither fires on our own `close()` — `reset()` sets "closed". */
  private wireConn(mp: MpClient): void {
    this.offConn?.();
    mp.onClose = () => {
      this.connStatus = "reconnecting";
      this.emit();
    };
    this.offConn = mp.onResumeOk(() => {
      this.connStatus = "open";
      this.emit();
    });
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
      dt && this.controller ? this.controller.deriveView(dt.displayState) : null;
    const snap: MatchSnapshot = {
      status: this.status,
      role: this.role,
      auto: this.auto,
      stake: this.spec ? Number(this.spec.stake) : 0,
      view,
      winner: dt ? dt.state.winner : null,
      opponentWallet: this.opponentWallet,
      tunnelId: dt ? dt.tunnelId : null,
      connStatus: this.connStatus,
      error: this.error,
    };
    // Comlink proxy: fire-and-forget (returns a Promise we ignore); coalesced upstream so the
    // per-call RPC cost is negligible (design §7).
    this.onSnapshot?.(snap);
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

  /**
   * Orphan-tunnel cancel (design §4.1): if a seat-A open is still queued in the main-thread
   * bulk-open window, cancel it so this torn-down match never opens a tunnel (and consumes stake).
   * Awaited by `reset()` so `engineClient.disposeWindow` can let the cancel land before terminating
   * the worker. If the intent already flushed into an in-flight PTB the bridge no-ops and `findMatch`
   * bails on its own session-gone guard — so this never crashes.
   */
  private async cancelPendingOpen(): Promise<void> {
    const intentId = this.pendingOpenIntentId;
    if (!intentId || !this.bridge) return;
    this.pendingOpenIntentId = null;
    try {
      await this.bridge.cancelOpen(intentId);
    } catch {
      /* bridge detached or open already resolved — nothing left to cancel */
    }
  }

  async reset(): Promise<void> {
    await this.cancelPendingOpen();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.dirty = false;
    this.detachResume?.();
    this.detachResume = null;
    this.offConn?.();
    this.offConn = null;
    this.controller?.dispose();
    this.mp?.close();
    this.mp = null;
    this.dt = null;
    this.controller = null;
    this.role = null;
    this.auto = true;
    this.opponentWallet = null;
    this.connStatus = "closed";
    this.error = null;
    this.status = "idle";
    this.emit();
  }

  async findMatch(gameId: GameId, setup?: unknown): Promise<void> {
    const config = this.config;
    const spec = this.getSpec(gameId);
    if (!config || !spec) {
      this.fail(new Error(`engine not ready for game '${gameId}'`));
      return;
    }
    this.spec = spec;
    try {
      this.error = null;
      this.status = "matching";
      this.connStatus = "connecting";
      this.emit();

      const ephemeral: KeyPair = generateKeyPair();
      const wallet = config.wallet;
      const mp = new MpClient(resolveMpWsUrl(config.backendUrl), wallet, ephemeral);
      this.mp = mp;
      this.wireConn(mp);
      await mp.connect();
      this.connStatus = "open";
      const match = await mp.quickMatch(gameId);
      this.role = match.role;
      this.opponentWallet = match.opponentWallet;
      this.emit();

      const channel = mp.channel(match.matchId);
      const waitPeer = makeInbox(channel);

      const controller = spec.createMatch(this.io());
      this.controller = controller;
      controller.initSetup(setup);

      // 1) exchange ephemeral pubkeys (the wallet is only a matchmaking label).
      channel.sendPeer({ t: "hello", ephemeralPubkey: toHex(ephemeral.publicKey) });
      const hello = await waitPeer<{ ephemeralPubkey: string }>("hello");
      const oppPub = fromHex(hello.ephemeralPubkey);

      // 2) fund on-chain via the bridge (role-asymmetric, interleaved with the relay).
      const bridge = this.requireBridge();
      this.status = "funding";
      this.emit();
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
        // reset match on a closed socket. Detected via the captured `mp` (reset() nulls `this.mp`).
        if (this.mp !== mp) return;
        tunnelId = opened.tunnelId;
        mp.announceTunnel(match.matchId, tunnelId);
        channel.sendPeer({ t: "open", tunnelId });
      } else {
        const open = await waitPeer<{ tunnelId: string }>("open");
        tunnelId = open.tunnelId;
        await bridge.depositStake({ tunnelId, amount: spec.stake, label: gameId });
      }

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
        spec.makeProtocol(),
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
      controller.onConfirmed(); // kick the first due move
      this.emit();
    } catch (e) {
      this.fail(e);
    }
  }

  /** Cold-load: rebuild any persisted in-flight match for this game and re-attach. */
  async resume(gameId: GameId): Promise<void> {
    if (this.mp) return; // already in a live or resumed session
    const config = this.config;
    const spec = this.getSpec(gameId);
    if (!config || !spec) return;
    this.spec = spec;
    let records: ResumeRecord[];
    try {
      records = await resumeIdb.getAllByGame(gameId);
    } catch {
      return;
    }
    if (records.length === 0) return;
    try {
      const ephemeral = generateKeyPair(); // connection auth only; the tunnel uses the record's key
      const mp = new MpClient(resolveMpWsUrl(config.backendUrl), config.wallet, ephemeral);
      this.mp = mp;
      this.wireConn(mp);
      this.connStatus = "connecting";
      const controller = spec.createMatch(this.io());
      this.controller = controller;
      const adapter = controller.resumeAdapter?.();
      if (!adapter) {
        this.mp = null;
        mp.close();
        return;
      }
      const rec = records[0];
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
      await mp.connect(); // opening handshake carries resume{matchId}
      this.connStatus = "open";
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
   *  live (findMatch) and cold-load (resume) paths; the caller does the ready handshake / connect. */
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
      controller.onConfirmed();
      this.emit();
      if (proto.isTerminal(dt.state) && !settling) {
        settling = true;
        this.status = "settling";
        this.emit();
        void this.settle(channel, waitPeer, transcript, info.tunnelId).then(
          () => {
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
    if (adapter && this.mp) {
      this.detachResume?.();
      this.detachResume = attachResume({
        mp: this.mp,
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
    const bridge = this.requireBridge();
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
    const other = await waitPeer<{ sig: string; transcriptRoot: string }>("settleHalf");
    if (other.transcriptRoot !== toHex(root)) {
      throw new Error("settlement transcript-root mismatch between parties");
    }
    const co = dt.combineSettlementWithRoot(half.settlement, half.sigSelf, fromHex(other.sig));
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
