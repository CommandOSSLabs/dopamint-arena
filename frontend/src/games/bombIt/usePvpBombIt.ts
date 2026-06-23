import { useEffect, useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import {
  BombItProtocol,
  type BombItState,
  type BombItMove,
  type BombItAction,
} from "sui-tunnel-ts/protocol/bombIt";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { registerWindowDisposer } from "@/lib/windowSessions";
import {
  MpClient,
  resolveMpWsUrl,
  type PvpChannel,
  type Role,
} from "../../pvp/mpClient";
import {
  getControlPlaneClient,
  resolveBackendUrl,
} from "../../backend/controlPlane";
import {
  closeCooperativeWithRoot,
  depositStake,
  openAndFundSharedTunnel,
  raiseDisputeUnilateral,
  readCreatedAt,
} from "../../onchain/tunnelTx";
import { coSignedToSettleRequest } from "../../backend/settleRequest";
import { deriveView, type BombItView } from "./session-core";
import { attachResume, resumeActiveTunnels } from "@/pvp/resumeSession";
import {
  installResumePersistence,
  evictExpiredRecords,
  readResumeRecord,
  listActiveTunnels,
} from "@/pvp/resume";
import { makeBombItResumeAdapter } from "./bombItResumeAdapter";

const STAKE = 500n; // per-seat MIST
const STEP_MS = 250; // pacing between ticks (ms)

export type PvpStatus =
  | "idle"
  | "matching"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

export interface PvpBombIt {
  status: PvpStatus;
  role: Role | null;
  /** Per-seat stake (MIST); surfaced in the outcome banner as the on-chain payout. */
  stake: number;
  /** Auto mode for YOUR seat: on (default) = a bot plays it; off = you play. The opponent
   *  toggles their own seat independently — both on = bot-vs-bot, both off = human-vs-human. */
  auto: boolean;
  view: BombItView | null;
  winner: "A" | "B" | "draw" | null;
  error: string | null;
  /** Join the public queue; paired with the next player who also clicks Find Match. */
  findMatch: () => void;
  queueAction: (a: BombItAction) => void;
  toggleAuto: () => void;
  reset: () => void;
}

type BombItTunnel = DistributedTunnel<BombItState, BombItMove>;

interface PvpDeps {
  account: { address: string } | null;
  client: unknown;
  signExec: (tx: never) => Promise<{ digest: string }>;
}

interface PvpSnapshot {
  status: PvpStatus;
  role: Role | null;
  stake: number;
  auto: boolean;
  view: BombItView | null;
  winner: "A" | "B" | "draw" | null;
  error: string | null;
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
 * A PvP match's whole session — matchmaking socket, tunnel, bot timer — kept
 * OUT of React so a minimized or reflowed window stays CONNECTED in the
 * background instead of dropping the opponent. The component subscribes; only an
 * explicit window close disposes it. See `lib/windowSessions`.
 */
class PvpSession {
  deps: PvpDeps | null = null;

  private status: PvpStatus = "idle";
  private role: Role | null = null;
  private auto = true;
  private view: BombItView | null = null;
  private winner: "A" | "B" | "draw" | null = null;
  private error: string | null = null;
  private snap: PvpSnapshot = {
    status: "idle",
    role: null,
    stake: Number(STAKE),
    auto: true,
    view: null,
    winner: null,
    error: null,
  };
  private listeners = new Set<() => void>();

  private mp: MpClient | null = null;
  private dt: BombItTunnel | null = null;
  private detachResume: (() => void) | null = null;
  private proposeTimer: ReturnType<typeof setTimeout> | null = null;
  private nextAction: BombItAction = "stay";

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): PvpSnapshot => this.snap;

  private emit() {
    this.snap = {
      status: this.status,
      role: this.role,
      stake: Number(STAKE),
      auto: this.auto,
      view: this.view,
      winner: this.winner,
      error: this.error,
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
      this.view = deriveView(this.dt.displayState);
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

      // Auto → a bot proposes this seat's move; manual → your queued action (idle = stay).
      let action: BombItAction;
      if (this.auto) {
        const botMove = dtNow.protocol.randomMove?.(
          dtNow.state,
          myRoleNow,
          Math.random,
        );
        action = (myRoleNow === "A" ? botMove?.a : botMove?.b) ?? "stay";
      } else {
        action = this.nextAction;
        this.nextAction = "stay";
      }
      const move: BombItMove =
        myRoleNow === "A" ? { a: action } : { b: action };
      try {
        dtNow.propose(move, 0n);
      } catch {
        // Proposal already pending or other transient error — safe to ignore here.
      }
    }, STEP_MS);
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
    this.nextAction = "stay";
    this.auto = true;
    this.winner = null;
    this.status = "idle";
    this.view = null;
    this.error = null;
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
    return makeBombItResumeAdapter(() => this.sync());
  }

  // Wire the per-move loop + resume onto a freshly built/rebuilt tunnel. Shared by the live
  // (findMatch) and cold-load (resume) paths. The readiness handshake and the opening
  // maybePropose stay with the caller — a resuming peer is mid-game and never re-sends "ready".
  private activateSession(
    mp: MpClient,
    channel: PvpChannel,
    dt: BombItTunnel,
    waitPeer: ReturnType<typeof makeInbox>,
    info: {
      matchId: string;
      role: Role;
      opponentWallet: string;
      opponentPubkeyHex: string;
      selfEphemeralSecretHex: string;
    },
  ) {
    const deps = this.deps!;
    const signExec = deps.signExec;
    const reads = deps.client as unknown as Parameters<
      typeof openAndFundSharedTunnel
    >[0]["reads"];
    const proto = new BombItProtocol();
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
          dt.tunnelId,
          transcript,
          getControlPlaneClient(),
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
        game: "bomb-it",
        opponentWallet: info.opponentWallet,
        opponentPubkeyHex: info.opponentPubkeyHex,
        selfEphemeralSecretHex: info.selfEphemeralSecretHex,
      },
      // Settlement floor: after the 1h grace, settle from the held checkpoint.
      onGraceExpired: (latest) => {
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

  // Cold-load entry: on mount, rebuild any persisted in-flight bomb-it match and re-attach.
  resume = () => {
    if (this.mp) return; // already in a live or resumed session
    const deps = this.deps;
    if (!deps?.account) return; // wallet not ready yet; the mount effect retries
    installResumePersistence();
    evictExpiredRecords();
    const wallet = deps.account.address;
    const resumable = listActiveTunnels()
      .map((id) => readResumeRecord(id))
      .some((r) => r?.game === "bomb-it");
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
        const restored = resumeActiveTunnels<BombItState, BombItMove>(
          mp,
          "bomb-it",
          {
            proto: new BombItProtocol(),
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
        const match = await mp.quickMatch("bomb-it");
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

        // 2) fund on-chain: seat A opens + funds its seat + announces; seat B deposits.
        this.status = "funding";
        this.emit();
        let tunnelId: string;
        if (match.role === "A") {
          tunnelId = await openAndFundSharedTunnel({
            reads,
            signExec: signExec as never,
            partyA: { address: wallet, publicKey: ephemeral.publicKey },
            partyB: { address: match.opponentWallet, publicKey: oppPub },
            amount: STAKE,
          });
          mp.announceTunnel(match.matchId, tunnelId);
          channel.sendPeer({ t: "open", tunnelId });
        } else {
          const open = await waitPeer<{ tunnelId: string }>("open");
          tunnelId = open.tunnelId;
          await depositStake({
            signExec: signExec as never,
            tunnelId,
            amount: STAKE,
          });
        }

        // 3) build the distributed engine over the relay transport (no moveCodec — JSON-native).
        const backend = defaultBackend();
        const self = makeEndpoint(backend, wallet, ephemeral, true);
        const opp = makeEndpoint(
          backend,
          match.opponentWallet,
          { publicKey: oppPub, scheme: ephemeral.scheme },
          false,
        );
        const dt = new DistributedTunnel<BombItState, BombItMove>(
          new BombItProtocol(),
          {
            tunnelId,
            self,
            opponent: opp,
            selfParty: match.role,
          },
          channel.transport,
          { a: STAKE, b: STAKE },
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

  queueAction = (a: BombItAction) => {
    this.nextAction = a;
  };

  toggleAuto = () => {
    this.auto = !this.auto;
    this.nextAction = "stay";
    this.emit();
  };
}

const pvpSessions = new Map<string, PvpSession>();

function getPvpSession(windowId: string): PvpSession {
  let session = pvpSessions.get(windowId);
  if (!session) {
    session = new PvpSession();
    pvpSessions.set(windowId, session);
    const created = session;
    registerWindowDisposer(windowId, "bomb-it-pvp", () => {
      created.dispose();
      pvpSessions.delete(windowId);
    });
  }
  return session;
}

export function usePvpBombIt(windowId: string): PvpBombIt {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const session = getPvpSession(windowId);
  session.deps = {
    account,
    client,
    signExec: (async (
      tx: Parameters<typeof signAndExecute>[0]["transaction"],
    ) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    }) as never,
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
    findMatch: session.findMatch,
    queueAction: session.queueAction,
    toggleAuto: session.toggleAuto,
    reset: session.reset,
  };
}

/**
 * Exchange root-anchored settlement halves over the relay, then seat A submits the close via the
 * backend /settle (the settler anchors the transcript root + archives to Walrus). Both seats must
 * anchor the SAME root or close_cooperative_with_root rebuilds different bytes and on-chain verify
 * fails — so the root is exchanged and asserted equal before either side trusts the combine.
 * Fallback: wallet-submitted close_cooperative_with_root (backend down).
 */
async function settle(
  dt: BombItTunnel,
  role: Role,
  channel: PvpChannel,
  waitPeer: <T>(t: string) => Promise<T>,
  reads: Parameters<typeof readCreatedAt>[0],
  signExec: Parameters<typeof closeCooperativeWithRoot>[0]["signExec"],
  tunnelId: string,
  transcript: Transcript,
  cp: ReturnType<typeof getControlPlaneClient>,
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
      coSignedToSettleRequest(co, transcript.toRecord().entries),
    );
  } catch (e) {
    console.error(
      "[bomb-it] backend settle failed; falling back to wallet close:",
      e,
    );
    await closeCooperativeWithRoot({ signExec, tunnelId, settlement: co });
  }
}
