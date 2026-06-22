/**
 * Per-game resume driver. One `attachResume` call wires a game's tunnel + channel into:
 *  - debounced persistence on every confirmed move (the resume record), and
 *  - the resume-time reconciliation handshake over the existing peer-message side channel.
 * Games supply only a thin `ResumeAdapter` (full-state (de)serialization, an optional hidden
 * secret the peer can never supply, optional move (de)serialization for codec-based moves, and a
 * re-render hook). Verification + adoption live in the SDK; this module never touches keys or
 * signatures directly.
 */
import type { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import type { CoSignedUpdate } from "sui-tunnel-ts/core/tunnel";
import { decideReconcile } from "sui-tunnel-ts/core/reconcile";
import type { ReconcileAction, ResyncView } from "sui-tunnel-ts/core/reconcile";
import type { MpClient, PvpChannel, PeerMessage } from "./mpClient";
import { fromWireCoSigned, toWireCoSigned, writeResumeRecord } from "./resume";
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
}

export interface AttachResumeArgs<State, Move> {
  mp: MpClient;
  channel: PvpChannel;
  tunnel: DistributedTunnel<State, Move>;
  adapter: ResumeAdapter<State, Move>;
  identity: ResumeIdentity;
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
          timestamp: snap.pending.timestamp.toString(),
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
      BigInt(record.pending.timestamp),
    );
  }
}

/** Send THIS seat's resync (latest nonce + pending flag + checkpoint + full state for gap-fill). */
function sendResync<State, Move>(args: AttachResumeArgs<State, Move>): void {
  const snap = args.tunnel.snapshot();
  args.channel.sendPeer({
    t: "resync",
    nonce: snap.nonce.toString(),
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
    nonce: BigInt(msg.nonce),
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

  return () => {
    offOk();
    offRes();
    channel.removePeerListener(peerHandler);
    if (tunnel.onConfirmed) tunnel.onConfirmed = prevConfirmed;
  };
}
