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
  FromEngine,
  GameId,
  GameSessionSpec,
  MainBridge,
  MatchController,
  MatchIo,
  MatchSnapshot,
  ToEngine,
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

  constructor(
    private readonly bridge: MainBridge,
    private readonly post: (m: FromEngine) => void,
    private readonly getSpec: (gameId: GameId) => AnySpec | undefined,
  ) {}

  handle(m: ToEngine): void {
    switch (m.t) {
      case "init":
        this.config = m.config;
        break;
      case "findMatch":
        void this.findMatch(m.gameId, m.setup);
        break;
      case "resume":
        void this.resume(m.gameId);
        break;
      case "submitInput":
        this.controller?.onInput(m.input);
        break;
      case "setAuto":
        this.auto = m.on;
        this.controller?.setAuto(m.on);
        this.emit();
        break;
      case "setVisibility":
        this.setVisibility(m.visible);
        break;
      case "reset":
        this.reset();
        break;
      case "bridgeResult":
        // Resolved by the worker's RPC layer; never reaches the engine.
        break;
    }
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
    this.post({ t: "snapshot", snap });
  }

  private setVisibility(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      if (this.dirty) this.flush();
    } else if (this.flushTimer !== null) {
      // Drop an already-armed flush so no snapshot posts while hidden; emit() re-arms on show.
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private reset(): void {
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

  private async findMatch(gameId: GameId, setup: unknown): Promise<void> {
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
      this.status = "funding";
      this.emit();
      let tunnelId: string;
      if (match.role === "A") {
        const opened = await this.bridge.openTunnel({
          partyA: { address: wallet, publicKey: ephemeral.publicKey },
          partyB: { address: match.opponentWallet, publicKey: oppPub },
          amount: spec.stake,
          label: gameId,
        });
        tunnelId = opened.tunnelId;
        mp.announceTunnel(match.matchId, tunnelId);
        channel.sendPeer({ t: "open", tunnelId });
      } else {
        const open = await waitPeer<{ tunnelId: string }>("open");
        tunnelId = open.tunnelId;
        await this.bridge.depositStake({ tunnelId, amount: spec.stake, label: gameId });
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
  private async resume(gameId: GameId): Promise<void> {
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
      this.reset();
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
    const createdAt = await this.bridge.readCreatedAt(tunnelId);
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
      await this.bridge.closeFallback({ tunnelId, settlement: co });
    }
  }
}
