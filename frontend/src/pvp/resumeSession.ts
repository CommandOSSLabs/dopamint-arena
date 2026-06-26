/**
 * Per-game resume driver. One `attachResume` call wires a game's tunnel + channel into:
 *  - debounced persistence on every confirmed move (the resume record), and
 *  - the resume-time reconciliation handshake over the existing peer-message side channel.
 * Games supply only a thin `ResumeAdapter` (full-state (de)serialization, an optional hidden
 * secret the peer can never supply, optional move (de)serialization for codec-based moves, and a
 * re-render hook). Verification + adoption live in the SDK; this module never touches keys or
 * signatures directly.
 */
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import type { CoSignedUpdate } from "sui-tunnel-ts/core/tunnel";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { fromHex } from "sui-tunnel-ts/core/bytes";
import type { Protocol } from "sui-tunnel-ts/protocol/Protocol";
import type { MoveCodec } from "sui-tunnel-ts/core/distributedFrame";
import { decideReconcile } from "sui-tunnel-ts/core/reconcile";
import type { ReconcileAction, ResyncView } from "sui-tunnel-ts/core/reconcile";
import type { MpClient, PvpChannel, PeerMessage } from "./mpClient";
import {
  clearResumeRecord,
  evictExpiredRecords,
  fromWireCoSigned,
  keypairFromSecretHex,
  listActiveTunnels,
  readResumeRecord,
  toWireCoSigned,
  writeResumeRecord,
} from "./resume";
import type { JsonValue, ResumeRecord } from "./resume";

export type ReconcileOutcome = ReconcileAction;

/** A game's thin resume adapter. State (de)serialization is REQUIRED and covers the FULL app
 *  state; `serializeState` MUST exclude any hidden secret (captured separately). Move methods
 *  default to identity (JSON-native moves); secret methods are omitted by games with no secret. */
export interface ResumeAdapter<State, Move> {
  serializeState(s: State): JsonValue;
  deserializeState(j: JsonValue): State;
  serializeMove?(m: Move): JsonValue;
  deserializeMove?(j: JsonValue): Move;
  captureSecret?(): JsonValue;
  restoreSecret?(j: JsonValue): void;
  onReconciled(
    tunnel: DistributedTunnel<State, Move>,
    outcome: ReconcileOutcome,
  ): void;
}

/** Static record fields the driver cannot derive from the tunnel snapshot. */
export interface ResumeIdentity {
  matchId: string;
  tunnelId: string;
  role: "A" | "B";
  game: string;
  opponentWallet: string;
  opponentPubkeyHex: string;
  /** Per-match self signing secret (hex), persisted so a cold reload can rebuild the signer. */
  selfEphemeralSecretHex: string;
}

export interface AttachResumeArgs<State, Move> {
  mp: MpClient;
  channel: PvpChannel;
  tunnel: DistributedTunnel<State, Move>;
  adapter: ResumeAdapter<State, Move>;
  identity: ResumeIdentity;
  graceMs?: number;
  onGraceExpired?: (latest: CoSignedUpdate | null) => void;
  /** Injectable for tests; defaults to the globals. */
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (h: unknown) => void;
  };
}

/** Build the full ResumeRecord from the live tunnel snapshot + static identity + adapter. */
function buildRecord<State, Move>(
  tunnel: DistributedTunnel<State, Move>,
  adapter: ResumeAdapter<State, Move>,
  identity: ResumeIdentity,
): ResumeRecord | null {
  const snap = tunnel.snapshot();
  if (!snap.latest) return null; // nothing co-signed yet — nothing to resume to
  const serMove =
    adapter.serializeMove ?? ((m: Move) => m as unknown as JsonValue);
  return {
    ...identity,
    latestCoSigned: toWireCoSigned(snap.latest),
    latestState: adapter.serializeState(snap.state),
    pending: snap.pending
      ? {
          move: serMove(snap.pending.move),
          timestamp: snap.pending.timestamp,
        }
      : undefined,
    secret: adapter.captureSecret ? adapter.captureSecret() : undefined,
    updatedAt: Date.now(),
  };
}

/** Cold-load: seat a freshly-constructed tunnel from a persisted record WITHOUT sending. The
 *  reconciliation handshake decides whether to (re-)send the pending move. */
export function restoreInto<State, Move>(
  tunnel: DistributedTunnel<State, Move>,
  record: ResumeRecord,
  adapter: ResumeAdapter<State, Move>,
): void {
  tunnel.adoptCheckpoint(
    adapter.deserializeState(record.latestState),
    fromWireCoSigned(record.latestCoSigned),
  );
  if (record.secret !== undefined && adapter.restoreSecret)
    adapter.restoreSecret(record.secret);
  if (record.pending) {
    const deMove =
      adapter.deserializeMove ?? ((j: JsonValue) => j as unknown as Move);
    tunnel.seatPending(
      deMove(record.pending.move),
      record.pending.timestamp,
    );
  }
}

/** Current connected wallet at mount — the only live value cold-load can't read from a record. */
export interface ResumeContext {
  selfWallet: string;
}

/** The thin per-game inputs cold-load reconstruction cannot derive from a persisted record. */
export interface RebuildSpec<State, Move> {
  /** The same `Protocol` object the hook builds for a live match. */
  proto: Protocol<State, Move>;
  /** Required for games with binary moves (battleship, poker); JSON-native games omit it. */
  moveCodec?: MoveCodec<Move>;
  /** Full-state + hidden-secret (de)serialization + UI hydration. */
  adapter: ResumeAdapter<State, Move>;
  /** Override the rebuilt tunnel's locked balances; defaults to the checkpoint's A/B split. */
  balancesFromRecord?(record: ResumeRecord): { a: bigint; b: bigint };
}

export interface RestoredSession<State, Move> {
  tunnel: DistributedTunnel<State, Move>;
  channel: PvpChannel;
}

/** Default locked balances: the checkpoint's current A/B split (sums to the same locked total). */
function balancesFromCheckpoint(record: ResumeRecord): {
  a: bigint;
  b: bigint;
} {
  return {
    a: record.latestCoSigned.update.partyABalance,
    b: record.latestCoSigned.update.partyBBalance,
  };
}

/**
 * Cold-load: reconstruct one tunnel from a persisted record + per-game spec, seat it at the
 * checkpoint, and warm-attach it. Throws if the record can't be restored (missing per-match key,
 * `adoptCheckpoint` integrity failure) — `resumeActiveTunnels` catches and evicts those. The
 * returned tunnel renders immediately from `tunnel.snapshot().state`; the resync handshake (run by
 * the attached driver once the peer is reachable) closes any ≤1-move gap.
 */
export function rebuildTunnel<State, Move>(
  mp: MpClient,
  record: ResumeRecord,
  spec: RebuildSpec<State, Move>,
  ctx: ResumeContext,
): RestoredSession<State, Move> {
  if (!record.selfEphemeralSecretHex)
    throw new Error("rebuildTunnel: record has no per-match signing key");
  const backend = defaultBackend();
  const keypair = keypairFromSecretHex(record.selfEphemeralSecretHex);
  const self = makeEndpoint(backend, ctx.selfWallet, keypair, true);
  const opponent = makeEndpoint(
    backend,
    record.opponentWallet,
    { publicKey: fromHex(record.opponentPubkeyHex), scheme: keypair.scheme },
    false,
  );
  const channel = mp.channel(record.matchId);
  const balances = (spec.balancesFromRecord ?? balancesFromCheckpoint)(record);
  const tunnel = new DistributedTunnel<State, Move>(
    spec.proto,
    {
      tunnelId: record.tunnelId,
      self,
      opponent,
      selfParty: record.role,
      moveCodec: spec.moveCodec,
    },
    channel.transport,
    balances,
  );
  restoreInto(tunnel, record, spec.adapter); // verify-on-adopt; throws on tamper
  mp.markActive(record.matchId);
  // Reconstruct-only: the caller owns onConfirmed + attachResume (live and cold paths
  // share one activateSession), so they can pass onGraceExpired and the per-move handler.
  return { tunnel, channel };
}

/**
 * Cold-load every persisted match for one game: evict expired records, then rebuild each active
 * record whose `game` matches. Corrupt/unrestorable records are evicted and skipped so a single bad
 * entry never blocks the rest. Call once on hook mount, BEFORE `mp.connect()`.
 */
export function resumeActiveTunnels<State, Move>(
  mp: MpClient,
  gameId: string,
  spec: RebuildSpec<State, Move>,
  ctx: ResumeContext,
): RestoredSession<State, Move>[] {
  evictExpiredRecords();
  const out: RestoredSession<State, Move>[] = [];
  for (const tunnelId of listActiveTunnels()) {
    const record = readResumeRecord(tunnelId);
    if (!record || record.game !== gameId) continue;
    try {
      out.push(rebuildTunnel(mp, record, spec, ctx));
    } catch {
      clearResumeRecord(tunnelId); // unrestorable → drop; user falls through to a fresh match
    }
  }
  return out;
}

/** Send THIS seat's resync (latest nonce + pending flag + checkpoint + full state for gap-fill). */
function sendResync<State, Move>(args: AttachResumeArgs<State, Move>): void {
  const snap = args.tunnel.snapshot();
  args.channel.sendPeer({
    t: "resync",
    nonce: snap.nonce,
    hasPending: snap.pending !== null,
    checkpoint: snap.latest ? toWireCoSigned(snap.latest) : undefined,
    fullState: args.adapter.serializeState(snap.state),
  } as Extract<PeerMessage, { t: "resync" }>);
}

/** React to a peer's resync: decide, then act on the LOCAL tunnel (verify-on-adopt). */
function onResync<State, Move>(
  args: AttachResumeArgs<State, Move>,
  msg: Extract<PeerMessage, { t: "resync" }>,
): void {
  const snap = args.tunnel.snapshot();
  const self: ResyncView = {
    nonce: snap.nonce,
    hasPending: snap.pending !== null,
    checkpoint: snap.latest,
  };
  const peerCp: CoSignedUpdate | null = msg.checkpoint
    ? fromWireCoSigned(msg.checkpoint)
    : null;
  const peer: ResyncView = {
    nonce: msg.nonce,
    hasPending: msg.hasPending,
    checkpoint: peerCp,
  };
  const { action } = decideReconcile(self, peer);
  try {
    if (action === "adopt" && peerCp && msg.fullState !== undefined) {
      args.tunnel.adoptCheckpoint(
        args.adapter.deserializeState(msg.fullState),
        peerCp,
      );
    } else if (action === "re-propose") {
      args.tunnel.resendPending();
    }
    // "wait"/"noop" do nothing; "settle" is surfaced to the game via onReconciled.
    args.adapter.onReconciled(args.tunnel, action);
  } catch {
    // adoptCheckpoint rejected (equivocation / tamper) -> fall through to the settlement floor.
    args.adapter.onReconciled(args.tunnel, "settle");
  }
}

/**
 * Wire persistence + the resync handshake. Persists on every confirmed move (debounced), sends a
 * resync when the peer is reachable (`resume.ok` with peerOnline, or `peer.resumed`), and reacts to
 * the peer's resync. Returns a detach fn (unsubscribes; does not close the socket).
 */
export function attachResume<State, Move>(
  args: AttachResumeArgs<State, Move>,
): () => void {
  const { mp, channel, tunnel, identity } = args;

  // Persist on confirm, preserving any game-set onConfirmed.
  const prevConfirmed = tunnel.onConfirmed;
  tunnel.onConfirmed = (u) => {
    prevConfirmed?.(u);
    const rec = buildRecord(tunnel, args.adapter, identity);
    if (rec) writeResumeRecord(rec);
  };

  // Route the peer's resync through the channel's existing onPeer; preserve any prior handler.
  const peerHandler = (m: Exclude<PeerMessage, { t: "frame" }>) => {
    if ((m as { t: string }).t === "resync")
      onResync(args, m as Extract<PeerMessage, { t: "resync" }>);
  };
  channel.addPeerListener(peerHandler);

  const offOk = mp.onResumeOk((e) => {
    if (e.matchId === identity.matchId && e.peerOnline) sendResync(args);
  });
  const offRes = mp.onPeerResumed((e) => {
    if (e.matchId === identity.matchId) sendResync(args);
  });

  const graceMs = args.graceMs ?? 3_600_000;
  const timers = args.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) =>
      clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  let graceHandle: unknown = null;
  const cancelGrace = () => {
    if (graceHandle != null) {
      timers.clearTimeout(graceHandle);
      graceHandle = null;
    }
  };

  const offDrop = mp.onPeerDropped((e) => {
    if (e.matchId !== identity.matchId) return;
    cancelGrace();
    graceHandle = timers.setTimeout(() => {
      graceHandle = null;
      args.onGraceExpired?.(tunnel.snapshot().latest);
    }, graceMs);
  });
  // a peer return cancels the grace timer (handshake handles convergence instead)
  const offOkCancel = mp.onResumeOk((e) => {
    if (e.matchId === identity.matchId && e.peerOnline) cancelGrace();
  });
  const offResCancel = mp.onPeerResumed((e) => {
    if (e.matchId === identity.matchId) cancelGrace();
  });

  return () => {
    offOk();
    offRes();
    offDrop();
    offOkCancel();
    offResCancel();
    cancelGrace();
    channel.removePeerListener(peerHandler);
    if (tunnel.onConfirmed) tunnel.onConfirmed = prevConfirmed;
  };
}
