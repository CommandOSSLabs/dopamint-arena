/**
 * Generic PvP-match engine shared by every symmetric, public-seed, turn-alternating tunnel game
 * (bomb-it, chicken-cross). It owns the entire control plane — matchmaking over the relay, the
 * on-chain funding handshake + stake, the per-tick propose loop with an auto-bot/human seat, the
 * out-of-React session kept alive across window remounts, warm/cold resume, cooperative settle, and
 * the 1h grace floor. A game supplies only a `PvpMatchSpec`: its protocol, view, resume adapter, and
 * how a per-seat "intent" maps to a `Move`. The previous per-game hooks were ~600-line copies of
 * this body; collapsing them here makes relay/staking/auto-mode parity hold by construction.
 *
 * Scope: public-state, no-hidden-secret games (ADR-0010) with JSON-native moves — they ride the
 * relay with the identity codec, no per-game move (de)serializer. Hidden-info games (battleship/
 * poker) are a richer superset (binary moves + secret hooks) and are NOT driven by this engine.
 */
import { useEffect, useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import type { CoSignedUpdate } from "sui-tunnel-ts/core/tunnel";
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import type { Protocol } from "sui-tunnel-ts/protocol/Protocol";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { registerWindowDisposer } from "@/lib/windowSessions";
import {
  MpClient,
  resolveMpWsUrl,
  type PvpChannel,
  type Role,
} from "@/pvp/mpClient";
import {
  getControlPlaneClient,
  resolveBackendUrl,
} from "@/backend/controlPlane";
import {
  closeCooperativeWithRoot,
  openAndFundSharedTunnel,
  raiseDisputeUnilateral,
  readCreatedAt,
  type SignExec,
} from "@/onchain/tunnelTx";
import {
  openSharedTunnelStaked,
  depositStakeStaked,
  type StakeStrategy,
} from "@/onchain/stakeTunnel";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "@/onchain/mtps";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { coSignedToSettleBody } from "@/backend/settleRequest";
import {
  attachResume,
  resumeActiveTunnels,
  type ResumeAdapter,
} from "@/pvp/resumeSession";
import {
  installResumePersistence,
  evictExpiredRecords,
  readResumeRecord,
  listActiveTunnels,
} from "@/pvp/resume";

export type PvpStatus =
  | "idle"
  | "matching"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

/**
 * The per-game knowledge the engine needs. Every field is a real point of variation between two
 * games whose control flow is otherwise identical.
 *
 * @typeParam State  protocol state; must carry a `winner` the board reads.
 * @typeParam Move   protocol move; JSON-native (carried over the relay with the identity codec).
 * @typeParam Intent a single seat's per-tick input (a direction, an action) before it becomes a Move.
 * @typeParam View   the flattened, render-ready snapshot the board consumes.
 */
export interface PvpMatchSpec<
  State extends { winner: unknown },
  Move,
  Intent,
  View,
> {
  /** Matchmaking + resume key (e.g. "bomb-it"); also the window-disposer/log label. */
  game: string;
  /** Pacing between this seat's proposes (ms). */
  stepMs: number;
  /** Per-seat stake locked on-chain (MIST). */
  stake: bigint;
  makeProtocol: () => Protocol<State, Move>;
  deriveView: (displayState: State) => View;
  makeResumeAdapter: (onReconciled: () => void) => ResumeAdapter<State, Move>;
  /** The seat's input when no human intent is pending (a bot "stay"/forward default). */
  idleIntent: Intent;
  /** Wrap a seat's intent into a co-signable Move for that role. */
  intentToMove: (role: Role, intent: Intent) => Move;
  /** Read this seat's intent out of a bot-proposed Move (undefined ⇒ apply `idleIntent`). */
  readIntent: (role: Role, move: Move | null) => Intent | undefined;
  /** Reconnect grace before the settlement floor (ms). Unset ⇒ the engine's 1h default. */
  graceMs?: number;
  /**
   * Free/draw OVERRIDE for the post-grace settlement floor. When set, the engine hands the close
   * to the GAME on grace-expiry instead of running the wagered default (stake the checkpoint via
   * `raiseDisputeUnilateral` only). The game owns the whole close (raise + force-close after the
   * on-chain window) so a dropped peer leaves a refund/draw, not a stranded tunnel. Unset ⇒ the
   * wagered default runs UNCHANGED — other games behave identically.
   */
  onGraceSettle?: (args: {
    /** Latest BOTH-signed checkpoint to stake on-chain (null ⇒ nothing co-signed yet). */
    latest: CoSignedUpdate | null;
    role: Role;
    tunnelId: string;
    /** Resolved signer (sponsored in MTPS mode, else wallet) for the on-chain settle txs. */
    signExec: SignExec;
    /** Poll at force-close time: has the peer reconnected since grace expired (peerDropped flipped
     *  false)? Guards the force-close so a resumed match is never force-closed. */
    peerReturned: () => boolean;
    /** Mark the engine status settled once the on-chain close lands (settling → settled). */
    markSettled: () => void;
  }) => void;
}

/** The hook's reactive surface. Game wrappers rename `setIntent` to their domain control. */
export interface PvpMatch<State extends { winner: unknown }, Intent, View> {
  status: PvpStatus;
  role: Role | null;
  /** Per-seat stake (MIST); surfaced in the outcome banner as the on-chain payout. */
  stake: number;
  /** Auto mode for YOUR seat: on (default) = a bot plays it; off = you play. The opponent toggles
   *  their own seat independently — both on = bot-vs-bot, both off = human-vs-human. */
  auto: boolean;
  view: View | null;
  winner: State["winner"];
  error: string | null;
  /** True while the opponent is dropped mid-match (within the reconnect grace window). Games may
   *  surface a reconnect overlay; flips back false the moment the peer resumes. */
  peerDropped: boolean;
  /** Join the public queue; paired with the next player who also clicks Find Match. */
  findMatch: () => void;
  /** Queue this seat's next intent (consumed on the next propose; resets to idle after). */
  setIntent: (intent: Intent) => void;
  toggleAuto: () => void;
  reset: () => void;
}

interface PvpDeps {
  account: { address: string } | null;
  client: unknown;
  /** Wallet sender-pays signer — the SUI-fallback funding path and the non-MTPS close. */
  signExec: (tx: never) => Promise<{ digest: string }>;
  /** Backend-gas-sponsored signer (ADR-0009) — the open/fund path, so a 0-SUI player pays nothing. */
  sponsoredSignExec: (tx: never) => Promise<{ digest: string }>;
  /** Pick a user SUI coin to fund this seat's stake (SUI fallback; gas is sponsored, stake is not). */
  selectStakeCoin: (minAmount: bigint) => Promise<string>;
  /** MTPS stake: faucet (invisibly, sponsored) if short, then return a stake coin id (ADR-0010). */
  prepareStake: (minAmount: bigint) => Promise<string>;
  /** ADR-0013: ensure the player's MTPS address balance covers the stake. No-op once funded. */
  ensureStakeBalance: (minAmount: bigint) => Promise<void>;
}

interface PvpSnapshot<State extends { winner: unknown }, View> {
  status: PvpStatus;
  role: Role | null;
  stake: number;
  auto: boolean;
  view: View | null;
  winner: State["winner"];
  error: string | null;
  peerDropped: boolean;
}

/** Buffer peer messages so a waiter never misses one that arrived early. */
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

/** Which seat proposes at this nonce: A proposes nonce 0→1, B 1→2, A 2→3, … */
function turn(nonce: bigint): Role {
  return nonce % 2n === 0n ? "A" : "B";
}

/**
 * A PvP match's whole session — matchmaking socket, tunnel, bot timer — kept OUT of React so a
 * minimized or reflowed window stays CONNECTED in the background instead of dropping the opponent.
 * The component subscribes; only an explicit window close disposes it. See `lib/windowSessions`.
 */
class PvpSession<State extends { winner: unknown }, Move, Intent, View> {
  deps: PvpDeps | null = null;

  private status: PvpStatus = "idle";
  private role: Role | null = null;
  private auto = true;
  private view: View | null = null;
  private winner: State["winner"] = null as State["winner"];
  private error: string | null = null;
  private peerDropped = false;
  private snap: PvpSnapshot<State, View>;
  private listeners = new Set<() => void>();

  private mp: MpClient | null = null;
  private dt: DistributedTunnel<State, Move> | null = null;
  private detachResume: (() => void) | null = null;
  private proposeTimer: ReturnType<typeof setTimeout> | null = null;
  private intent: Intent;

  constructor(private readonly spec: PvpMatchSpec<State, Move, Intent, View>) {
    this.intent = spec.idleIntent;
    this.snap = {
      status: "idle",
      role: null,
      stake: Number(spec.stake),
      auto: true,
      view: null,
      winner: null as State["winner"],
      error: null,
      peerDropped: false,
    };
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): PvpSnapshot<State, View> => this.snap;

  private emit() {
    this.snap = {
      status: this.status,
      role: this.role,
      stake: Number(this.spec.stake),
      auto: this.auto,
      view: this.view,
      winner: this.winner,
      error: this.error,
      peerDropped: this.peerDropped,
    };
    for (const l of this.listeners) l();
  }

  private fail(e: unknown) {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }

  private sync = () => {
    if (this.dt) {
      this.view = this.spec.deriveView(this.dt.displayState);
      this.winner = this.dt.state.winner;
    }
    this.emit();
  };

  /** Schedule a propose for this seat if it's our turn. Clears any existing timer first. */
  private maybePropose = () => {
    const dt = this.dt;
    const myRole = this.role;
    if (!dt || !myRole) return;
    if (dt.protocol.isTerminal(dt.state)) return;
    if (turn(dt.nonce) !== myRole) return;

    if (this.proposeTimer !== null) {
      clearTimeout(this.proposeTimer);
      this.proposeTimer = null;
    }

    this.proposeTimer = setTimeout(() => {
      this.proposeTimer = null;
      const dtNow = this.dt;
      const myRoleNow = this.role;
      if (!dtNow || !myRoleNow) return;
      if (dtNow.protocol.isTerminal(dtNow.state)) return;
      if (turn(dtNow.nonce) !== myRoleNow) return;

      // Auto → a bot proposes this seat's move; manual → your queued intent (idle once consumed).
      let intent: Intent;
      if (this.auto) {
        const botMove =
          dtNow.protocol.randomMove?.(dtNow.state, myRoleNow, Math.random) ??
          null;
        intent =
          this.spec.readIntent(myRoleNow, botMove) ?? this.spec.idleIntent;
      } else {
        intent = this.intent;
        this.intent = this.spec.idleIntent;
      }
      try {
        dtNow.propose(this.spec.intentToMove(myRoleNow, intent), 0n);
      } catch {
        // Proposal already pending or other transient error — safe to ignore here.
      }
    }, this.spec.stepMs);
  };

  reset = () => {
    if (this.proposeTimer !== null) {
      clearTimeout(this.proposeTimer);
      this.proposeTimer = null;
    }
    this.detachResume?.();
    this.detachResume = null;
    this.mp?.close();
    this.mp = null;
    this.dt = null;
    this.role = null;
    this.intent = this.spec.idleIntent;
    this.auto = true;
    this.winner = null as State["winner"];
    this.status = "idle";
    this.view = null;
    this.error = null;
    this.peerDropped = false;
    this.emit();
  };

  dispose = () => {
    if (this.proposeTimer !== null) {
      clearTimeout(this.proposeTimer);
      this.proposeTimer = null;
    }
    this.detachResume?.();
    this.detachResume = null;
    this.mp?.close();
    this.mp = null;
    this.dt = null;
    this.listeners.clear();
  };

  private makeAdapter() {
    return this.spec.makeResumeAdapter(() => this.sync());
  }

  // Wire the per-move loop + resume onto a freshly built/rebuilt tunnel. Shared by the live
  // (findMatch) and cold-load (resume) paths. The readiness handshake and the opening
  // maybePropose stay with the caller — a resuming peer is mid-game and never re-sends "ready".
  private activateSession(
    mp: MpClient,
    channel: PvpChannel,
    dt: DistributedTunnel<State, Move>,
    waitPeer: ReturnType<typeof makeInbox>,
    info: {
      matchId: string;
      role: Role;
      opponentWallet: string;
      opponentPubkeyHex: string;
      selfEphemeralSecretHex: string;
    },
  ) {
    // Bind the live tunnel for sync()/maybePropose()/the board. BOTH callers route through here,
    // so set it here — the resume() cold-load path doesn't set it otherwise, which left a resumed
    // match with a null `dt` (no view → stuck loading, the propose loop never schedules).
    this.dt = dt;
    const deps = this.deps!;
    const signExec = deps.signExec;
    const sponsoredSignExec = deps.sponsoredSignExec;
    const coinType = isMtpsConfigured ? MTPS_COIN_TYPE : undefined;
    const reads = deps.client as unknown as Parameters<
      typeof openAndFundSharedTunnel
    >[0]["reads"];
    const proto = this.spec.makeProtocol();
    const transcript = new Transcript(dt.tunnelId);
    let settling = false;
    dt.onConfirmed = (u) => {
      transcript.append(u);
      this.sync();
      this.maybePropose();
      if (proto.isTerminal(dt.state) && !settling) {
        settling = true;
        this.status = "settling";
        this.emit();
        void settle(
          dt,
          info.role,
          channel,
          waitPeer,
          reads,
          signExec as never,
          sponsoredSignExec as never,
          dt.tunnelId,
          transcript,
          getControlPlaneClient(),
          this.spec.game,
          coinType,
        ).then(
          () => {
            this.status = "settled";
            this.emit();
          },
          (e) => this.fail(e),
        );
      }
    };

    this.detachResume?.();
    this.detachResume = attachResume({
      mp,
      channel,
      tunnel: dt,
      adapter: this.makeAdapter(),
      identity: {
        matchId: info.matchId,
        tunnelId: dt.tunnelId,
        role: info.role,
        game: this.spec.game,
        opponentWallet: info.opponentWallet,
        opponentPubkeyHex: info.opponentPubkeyHex,
        selfEphemeralSecretHex: info.selfEphemeralSecretHex,
      },
      graceMs: this.spec.graceMs,
      // Surface peer presence so a game can show a reconnect overlay; the snapshot drives the UI.
      onPeerState: (dropped) => {
        this.peerDropped = dropped;
        this.emit();
      },
      // Settlement floor on grace-expiry. A free/draw game (onGraceSettle) OWNS the whole close
      // (raise + force-close → refund/draw); otherwise the wagered default stakes the checkpoint.
      onGraceExpired: (latest) => {
        if (this.spec.onGraceSettle) {
          this.status = "settling";
          this.emit();
          this.spec.onGraceSettle({
            latest,
            role: info.role,
            tunnelId: dt.tunnelId,
            signExec: (isMtpsConfigured
              ? sponsoredSignExec
              : signExec) as never,
            peerReturned: () => !this.peerDropped,
            markSettled: () => {
              this.status = "settled";
              this.emit();
            },
          });
          return;
        }
        if (latest)
          void raiseDisputeUnilateral({
            signExec: signExec as never,
            tunnelId: dt.tunnelId,
            update: latest,
            role: info.role,
          });
      },
    });

    this.status = "playing";
    this.sync();
  }

  // Cold-load entry: on mount, rebuild any persisted in-flight match for this game and re-attach.
  resume = () => {
    if (this.mp) return; // already in a live or resumed session
    const deps = this.deps;
    if (!deps?.account) return; // wallet not ready yet; the mount effect retries
    installResumePersistence();
    evictExpiredRecords();
    const wallet = deps.account.address;
    const resumable = listActiveTunnels()
      .map((id) => readResumeRecord(id))
      .some((r) => r?.game === this.spec.game);
    if (!resumable) return; // nothing to resume → don't open a socket
    void (async () => {
      try {
        const ephemeral: KeyPair = generateKeyPair();
        const mp = new MpClient(
          resolveMpWsUrl(resolveBackendUrl()),
          wallet,
          ephemeral,
        );
        this.mp = mp;
        const restored = resumeActiveTunnels<State, Move>(
          mp,
          this.spec.game,
          {
            proto: this.spec.makeProtocol(),
            adapter: this.makeAdapter(),
          },
          { selfWallet: wallet },
        );
        if (restored.length === 0) {
          this.mp = null;
          mp.close();
          return;
        }
        const { tunnel, channel } = restored[0];
        const rec = readResumeRecord(tunnel.tunnelId)!;
        this.role = rec.role;
        const waitPeer = makeInbox(channel);
        this.activateSession(mp, channel, tunnel, waitPeer, {
          matchId: rec.matchId,
          role: rec.role,
          opponentWallet: rec.opponentWallet,
          opponentPubkeyHex: rec.opponentPubkeyHex,
          selfEphemeralSecretHex: rec.selfEphemeralSecretHex!,
        });
        await mp.connect(); // opening handshake carries resume{matchId}
        try {
          this.maybePropose(); // kick a due move
        } catch {
          /* a move is already in flight — the resync handshake converges it */
        }
        this.sync();
      } catch (e) {
        this.fail(e);
      }
    })();
  };

  findMatch = () => {
    const deps = this.deps;
    if (!deps?.account) {
      this.error = "connect a wallet first";
      this.status = "error";
      this.emit();
      return;
    }
    const wallet = deps.account.address;
    installResumePersistence();
    evictExpiredRecords();
    const signExec = deps.signExec;
    const reads = deps.client as unknown as Parameters<
      typeof openAndFundSharedTunnel
    >[0]["reads"];

    void (async () => {
      try {
        this.error = null;
        this.status = "matching";
        this.emit();
        const ephemeral: KeyPair = generateKeyPair();
        const mp = new MpClient(
          resolveMpWsUrl(resolveBackendUrl()),
          wallet,
          ephemeral,
        );
        this.mp = mp;
        await mp.connect();
        const match = await mp.quickMatch(this.spec.game);
        this.role = match.role;
        this.emit();

        const channel = mp.channel(match.matchId);
        const waitPeer = makeInbox(channel);

        // 1) exchange ephemeral pubkeys (wallet is only the matchmaking label).
        channel.sendPeer({
          t: "hello",
          ephemeralPubkey: toHex(ephemeral.publicKey),
        });
        const hello = await waitPeer<{ ephemeralPubkey: string }>("hello");
        const oppPub = fromHex(hello.ephemeralPubkey);

        // 2) fund on-chain, gas-sponsored. MTPS path (ADR-0010): faucet the stake invisibly
        //    (settler pays gas) so a 0-SUI player plays free; SUI path (MTPS env unset):
        //    sponsored stake with a sender-pays fallback (ADR-0009). Seat A opens + announces; B deposits.
        this.status = "funding";
        this.emit();
        const stake: StakeStrategy = {
          sponsoredSignExec: deps.sponsoredSignExec as never,
          walletSignExec: signExec as never,
          prepareStake: deps.prepareStake,
          selectStakeCoin: deps.selectStakeCoin,
          ensureStakeBalance: deps.ensureStakeBalance,
        };
        let tunnelId: string;
        if (match.role === "A") {
          tunnelId = await openSharedTunnelStaked({
            reads,
            partyA: { address: wallet, publicKey: ephemeral.publicKey },
            partyB: { address: match.opponentWallet, publicKey: oppPub },
            amount: this.spec.stake,
            label: this.spec.game,
            ...stake,
          });
          mp.announceTunnel(match.matchId, tunnelId);
          channel.sendPeer({ t: "open", tunnelId });
        } else {
          const open = await waitPeer<{ tunnelId: string }>("open");
          tunnelId = open.tunnelId;
          await depositStakeStaked({
            tunnelId,
            amount: this.spec.stake,
            label: this.spec.game,
            ...stake,
          });
        }

        // 3) build the distributed engine over the relay transport. Moves are JSON-native, so
        //    the tunnel carries them with its identity codec (no per-game (de)serializer).
        const backend = defaultBackend();
        const self = makeEndpoint(backend, wallet, ephemeral, true);
        const opp = makeEndpoint(
          backend,
          match.opponentWallet,
          { publicKey: oppPub, scheme: ephemeral.scheme },
          false,
        );
        const dt = new DistributedTunnel<State, Move>(
          this.spec.makeProtocol(),
          {
            tunnelId,
            self,
            opponent: opp,
            selfParty: match.role,
          },
          channel.transport,
          { a: this.spec.stake, b: this.spec.stake },
        );
        this.dt = dt;
        this.activateSession(mp, channel, dt, waitPeer, {
          matchId: match.matchId,
          role: match.role,
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
        this.maybePropose();
        this.sync();
      } catch (e) {
        this.fail(e);
      }
    })();
  };

  setIntent = (intent: Intent) => {
    this.intent = intent;
  };

  toggleAuto = () => {
    this.auto = !this.auto;
    this.intent = this.spec.idleIntent;
    this.emit();
  };
}

/**
 * Build a React hook that drives this game's PvP matches. Sessions live in a module-level map keyed
 * by `windowId` (one map per game, since each game calls this once) so a window can minimize/reflow
 * without dropping the opponent; the window-close disposer tears the session down.
 */
export function createPvpMatchHook<
  State extends { winner: unknown },
  Move,
  Intent,
  View,
>(
  spec: PvpMatchSpec<State, Move, Intent, View>,
): (windowId: string) => PvpMatch<State, Intent, View> {
  const sessions = new Map<string, PvpSession<State, Move, Intent, View>>();

  function getSession(windowId: string): PvpSession<State, Move, Intent, View> {
    let session = sessions.get(windowId);
    if (!session) {
      session = new PvpSession(spec);
      sessions.set(windowId, session);
      const created = session;
      registerWindowDisposer(windowId, `${spec.game}-pvp`, () => {
        created.dispose();
        sessions.delete(windowId);
      });
    }
    return session;
  }

  return function usePvpMatch(windowId: string): PvpMatch<State, Intent, View> {
    const account = useCurrentAccount();
    const client = useSuiClient();
    const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
    const sponsored = useSponsoredSignExec();

    const session = getSession(windowId);
    session.deps = {
      account,
      client,
      signExec: (async (
        tx: Parameters<typeof signAndExecute>[0]["transaction"],
      ) => {
        const r = await signAndExecute({ transaction: tx });
        return { digest: r.digest };
      }) as never,
      // Open/fund routes through the backend gas sponsor (ADR-0009); the close keeps signExec
      // above unless MTPS mode, where settle() swaps in the sponsored signer.
      sponsoredSignExec: sponsored.signExec as never,
      selectStakeCoin: sponsored.selectStakeCoin,
      prepareStake: sponsored.prepareStake,
      ensureStakeBalance: sponsored.ensureStakeBalance,
    };

    // Cold-load: once the wallet is known, re-attach to any persisted in-flight match. resume()
    // is idempotent (no-ops if already connected or nothing to restore).
    useEffect(() => {
      session.resume();
    }, [session, account?.address]);

    const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
    return {
      status: snap.status,
      role: snap.role,
      stake: snap.stake,
      auto: snap.auto,
      view: snap.view,
      winner: snap.winner,
      error: snap.error,
      peerDropped: snap.peerDropped,
      findMatch: session.findMatch,
      setIntent: session.setIntent,
      toggleAuto: session.toggleAuto,
      reset: session.reset,
    };
  };
}

/**
 * Exchange root-anchored settlement halves over the relay, then seat A submits the close via the
 * backend /settle (the settler anchors the transcript root + archives to Walrus). Both seats must
 * anchor the SAME root or close_cooperative_with_root rebuilds different bytes and on-chain verify
 * fails — so the root is exchanged and asserted equal before either side trusts the combine.
 * Fallback: wallet-submitted close_cooperative_with_root (backend down).
 */
async function settle<State, Move>(
  dt: DistributedTunnel<State, Move>,
  role: Role,
  channel: PvpChannel,
  waitPeer: <T>(t: string) => Promise<T>,
  reads: Parameters<typeof readCreatedAt>[0],
  signExec: Parameters<typeof closeCooperativeWithRoot>[0]["signExec"],
  // In MTPS mode the player holds 0 SUI, so a wallet-signed close would throw and strand the
  // staked MTPS — the fallback close must use the sponsored signer there.
  sponsoredSignExec: Parameters<typeof closeCooperativeWithRoot>[0]["signExec"],
  tunnelId: string,
  transcript: Transcript,
  cp: ReturnType<typeof getControlPlaneClient>,
  game: string,
  coinType: string | undefined,
): Promise<void> {
  const createdAt = await readCreatedAt(reads, tunnelId);
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
  if (role !== "A") return; // single submitter, mirrors the cooperative-close pattern
  try {
    await cp.settle(
      tunnelId,
      coSignedToSettleBody(co, transcript.rawEntries()),
    );
  } catch (e) {
    console.error(
      `[${game}] backend settle failed; falling back to wallet close:`,
      e,
    );
    await closeCooperativeWithRoot({
      signExec: isMtpsConfigured ? sponsoredSignExec : signExec,
      tunnelId,
      settlement: co,
      coinType,
    });
  }
}
