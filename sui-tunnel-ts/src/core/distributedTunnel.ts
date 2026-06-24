/**
 * PvP off-chain engine: a process holding ONE party's signer that co-signs moves
 * with a remote counterparty over an untrusted `Transport`.
 *
 * Correctness rule (non-negotiable): on a MOVE, the receiver re-applies the move on
 * ITS OWN state, recomputes the hash, and signs only if the re-derived
 * {stateHash, nonce, balances} match the frame. It never signs a state it saw only as
 * a hash. State advances on CONFIRMATION — the proposer advances only on a valid ACK.
 *
 * The signed bytes (`wire.serializeStateUpdate` / `serializeSettlement`) are
 * byte-identical to `OffchainTunnel`, so any co-signed artifact settles on-chain
 * exactly as a self-play one does.
 */
import { Balances, Party, Protocol } from "../protocol/Protocol";
import { bytesEqual } from "./bytes";
import { blake2b256 } from "./crypto";
import {
  AckFrame,
  decodeFrame,
  encodeFrame,
  identityMoveCodec,
  MoveCodec,
  MoveFrame,
} from "./distributedFrame";
import {
  CoSignedSettlement,
  CoSignedSettlementWithRoot,
  CoSignedUpdate,
  PartyEndpoint,
  verifyCoSignedUpdate,
} from "./tunnel";
import {
  serializeSettlement,
  serializeSettlementWithRoot,
  serializeStateUpdate,
  Settlement,
  SettlementWithRoot,
  StateUpdate,
} from "./wire";

/** Opaque byte transport between the two seats. The relay forwards frames blindly. */
export interface Transport {
  send(frame: Uint8Array): void;
  onFrame(cb: (frame: Uint8Array) => void): void;
}

/** Read-only view of a tunnel's resume-relevant state (for persistence / reconciliation). */
export interface TunnelSnapshot<State, Move> {
  state: State;
  nonce: bigint;
  latest: CoSignedUpdate | null;
  pending: { move: Move; timestamp: bigint } | null;
}

export interface DistributedConfig<M> {
  tunnelId: string;
  /** This process's seat — MUST carry a `sign` fn. */
  self: PartyEndpoint;
  /** The opponent's seat — verify-only (no `sign`). */
  opponent: PartyEndpoint;
  /** Which side `self` is; fixes signature placement (sigA/sigB) and turn order. */
  selfParty: Party;
  moveCodec?: MoveCodec<M>;
}

interface PendingProposal<State, Move> {
  next: State;
  update: StateUpdate;
  msg: Uint8Array;
  sigSelf: Uint8Array;
  move: Move;
  timestamp: bigint;
}

export class DistributedTunnel<State, Move> {
  readonly tunnelId: string;
  readonly protocol: Protocol<State, Move>;
  readonly self: PartyEndpoint;
  readonly opponent: PartyEndpoint;
  readonly selfParty: Party;
  readonly total: bigint;

  private _state: State;
  private _nonce: bigint;
  private _latest: CoSignedUpdate | null;
  private pending: PendingProposal<State, Move> | null;
  private readonly codec: MoveCodec<Move>;
  private readonly transport: Transport;

  /** Fired after each confirmed co-signed update (telemetry / watchtower checkpoint). */
  onConfirmed?: (u: CoSignedUpdate) => void;

  constructor(
    protocol: Protocol<State, Move>,
    cfg: DistributedConfig<Move>,
    transport: Transport,
    initialBalances: Balances
  ) {
    if (!cfg.self.sign) {
      throw new Error("DistributedTunnel: self endpoint must carry a signer");
    }
    this.tunnelId = cfg.tunnelId;
    this.protocol = protocol;
    this.self = cfg.self;
    this.opponent = cfg.opponent;
    this.selfParty = cfg.selfParty;
    this.total = initialBalances.a + initialBalances.b;
    this._state = protocol.initialState({
      tunnelId: cfg.tunnelId,
      initialBalances,
    });
    const { a, b } = protocol.balances(this._state);
    if (a + b !== this.total) {
      throw new Error(
        `protocol initial balances ${a + b} != locked total ${this.total}`
      );
    }
    this._nonce = 0n;
    this._latest = null;
    this.pending = null;
    this.codec = (cfg.moveCodec ?? identityMoveCodec) as MoveCodec<Move>;
    this.transport = transport;
    transport.onFrame((bytes) => this.onFrame(bytes));
  }

  get state(): State {
    return this._state;
  }
  /**
   * State to render NOW. While a proposal awaits its ACK this is the locally-applied,
   * already-signed `pending.next`; otherwise the last confirmed state. Lets the UI show
   * the proposer's own move instantly instead of waiting for the co-sign round-trip.
   * Never use this for settlement or security decisions — use `state` (confirmed) for those.
   */
  get displayState(): State {
    return this.pending ? this.pending.next : this._state;
  }
  get nonce(): bigint {
    return this._nonce;
  }
  get latest(): CoSignedUpdate | null {
    return this._latest;
  }

  private selfIsA(): boolean {
    return this.selfParty === "A";
  }

  /** Place self/other signatures into A/B slots according to which side we are. */
  private coSign(
    update: StateUpdate,
    sigSelf: Uint8Array,
    sigOther: Uint8Array
  ): CoSignedUpdate {
    return this.selfIsA()
      ? { update, sigA: sigSelf, sigB: sigOther }
      : { update, sigA: sigOther, sigB: sigSelf };
  }

  /**
   * Propose a move by THIS seat: apply locally, sign our half, emit a MOVE.
   * State advances only when a valid ACK arrives. The proposer chooses `timestamp`;
   * the receiver reuses it verbatim (it is folded into the signed bytes).
   */
  propose(move: Move, timestamp: bigint): void {
    this.seatPending(move, timestamp);
    this.transport.send(encodeFrame(this.pendingMoveFrame(), this.codec));
  }

  /** Prepare + sign this seat's pending proposal WITHOUT sending it. Deterministic: the same
   *  (state, move, timestamp) yields byte-identical signed bytes — so a restored proposal
   *  re-sends identically. `propose` = seatPending + send; restore uses seatPending alone and
   *  lets the reconciliation handshake decide whether to (re-)send. */
  seatPending(move: Move, timestamp: bigint): void {
    if (this.pending) throw new Error("a proposal is already awaiting ACK");
    const next = this.protocol.applyMove(this._state, move, this.selfParty);
    const { a, b } = this.protocol.balances(next);
    if (a + b !== this.total)
      throw new Error(`balance sum ${a + b} != locked total ${this.total}`);
    const nonce = this._nonce + 1n;
    const stateHash = blake2b256(this.protocol.encodeState(next));
    const update: StateUpdate = {
      tunnelId: this.tunnelId,
      stateHash,
      nonce,
      timestamp,
      partyABalance: a,
      partyBBalance: b,
    };
    const msg = serializeStateUpdate(update);
    const sigSelf = this.self.sign!(msg);
    this.pending = { next, update, msg, sigSelf, move, timestamp };
  }

  /** Re-send the current pending proposal's MOVE frame (idempotent at the peer iff it has not
   *  applied it — the reconciliation handshake guarantees this). No-op if nothing is pending. */
  resendPending(): void {
    if (this.pending)
      this.transport.send(encodeFrame(this.pendingMoveFrame(), this.codec));
  }

  private pendingMoveFrame(): MoveFrame<Move> {
    const p = this.pending!;
    return {
      kind: "move",
      nonce: p.update.nonce,
      by: this.selfParty,
      move: p.move,
      timestamp: p.timestamp,
      stateHash: p.update.stateHash,
      partyABalance: p.update.partyABalance,
      partyBBalance: p.update.partyBBalance,
      sigProposer: p.sigSelf,
    };
  }

  /** Seat the tunnel at a verified both-signed checkpoint (resume-time only). Asserts the
   *  checkpoint binds to `state`, balances sum to the locked total, and both signatures verify.
   *  A checkpoint older than the current nonce is ignored (never move backward). Throws on any
   *  integrity failure so the caller can fall through to the settlement floor. */
  adoptCheckpoint(state: State, coSigned: CoSignedUpdate): void {
    const u = coSigned.update;
    if (u.tunnelId !== this.tunnelId)
      throw new Error("adoptCheckpoint: tunnelId mismatch");
    if (u.nonce < this._nonce) return; // lower nonce: silent no-op
    if (u.partyABalance + u.partyBBalance !== this.total) {
      throw new Error("adoptCheckpoint: balance sum != locked total");
    }
    const reHash = blake2b256(this.protocol.encodeState(state));
    if (!bytesEqual(reHash, u.stateHash))
      throw new Error("adoptCheckpoint: state hash mismatch");
    const partyA = this.selfIsA() ? this.self : this.opponent;
    const partyB = this.selfIsA() ? this.opponent : this.self;
    if (!verifyCoSignedUpdate(coSigned, partyA, partyB)) {
      throw new Error("adoptCheckpoint: co-signature verification failed");
    }
    this._state = state;
    this._nonce = u.nonce;
    this._latest = coSigned;
    if (this.pending && this.pending.update.nonce <= u.nonce)
      this.pending = null;
  }

  /** Read-only resume snapshot for persistence / reconciliation. */
  snapshot(): TunnelSnapshot<State, Move> {
    return {
      state: this._state,
      nonce: this._nonce,
      latest: this._latest,
      pending: this.pending
        ? { move: this.pending.move, timestamp: this.pending.timestamp }
        : null,
    };
  }

  private onFrame(bytes: Uint8Array): void {
    const frame = decodeFrame<Move>(bytes, this.codec);
    if (frame.kind === "move") this.onMove(frame);
    else this.onAck(frame);
  }

  private onMove(frame: MoveFrame<Move>): void {
    if (frame.by === this.selfParty)
      throw new Error("received a MOVE attributed to self");
    if (frame.nonce !== this._nonce + 1n) {
      throw new Error(
        `nonce gap: got ${frame.nonce}, expected ${this._nonce + 1n}`
      );
    }
    const next = this.protocol.applyMove(this._state, frame.move, frame.by);
    const { a, b } = this.protocol.balances(next);
    if (a + b !== this.total)
      throw new Error(`balance sum ${a + b} != locked total ${this.total}`);
    if (a !== frame.partyABalance || b !== frame.partyBBalance) {
      throw new Error("frame balances != re-derived balances");
    }
    const stateHash = blake2b256(this.protocol.encodeState(next));
    if (!bytesEqual(stateHash, frame.stateHash)) {
      throw new Error("frame stateHash != re-derived stateHash");
    }
    const update: StateUpdate = {
      tunnelId: this.tunnelId,
      stateHash,
      nonce: frame.nonce,
      timestamp: frame.timestamp,
      partyABalance: a,
      partyBBalance: b,
    };
    const msg = serializeStateUpdate(update);
    if (!this.opponent.verify(msg, frame.sigProposer)) {
      throw new Error("proposer signature failed verification");
    }
    const sigResponder = this.self.sign!(msg);
    // self is the responder; frame.by (the opponent) is the proposer.
    this._latest = this.coSign(update, sigResponder, frame.sigProposer);
    this._state = next;
    this._nonce = frame.nonce;
    const ack: AckFrame = { kind: "ack", nonce: frame.nonce, sigResponder };
    this.transport.send(encodeFrame(ack, this.codec));
    this.onConfirmed?.(this._latest);
  }

  private onAck(frame: AckFrame): void {
    const p = this.pending;
    if (!p || frame.nonce !== p.update.nonce) {
      throw new Error(`unexpected ACK for nonce ${frame.nonce}`);
    }
    if (!this.opponent.verify(p.msg, frame.sigResponder)) {
      throw new Error("responder signature failed verification");
    }
    this._latest = this.coSign(p.update, p.sigSelf, frame.sigResponder);
    this._state = p.next;
    this._nonce = p.update.nonce;
    this.pending = null;
    this.onConfirmed?.(this._latest);
  }

  /**
   * Sign THIS seat's half of the cooperative settlement for the current state.
   * `finalNonce = onchainNonce + 1`, byte-identical to `OffchainTunnel.buildSettlement`.
   * The other half is collected over the relay / backend.
   */
  buildSettlementHalf(
    timestamp: bigint,
    onchainNonce: bigint = 0n
  ): { settlement: Settlement; sigSelf: Uint8Array } {
    const { a, b } = this.protocol.balances(this._state);
    const settlement: Settlement = {
      tunnelId: this.tunnelId,
      partyABalance: a,
      partyBBalance: b,
      finalNonce: onchainNonce + 1n,
      timestamp,
    };
    const sigSelf = this.self.sign!(serializeSettlement(settlement));
    return { settlement, sigSelf };
  }

  /** Combine our half with the opponent's into a dual-signed settlement, verifying theirs. */
  combineSettlement(
    settlement: Settlement,
    sigSelf: Uint8Array,
    sigOther: Uint8Array
  ): CoSignedSettlement {
    const msg = serializeSettlement(settlement);
    if (!this.opponent.verify(msg, sigOther)) {
      throw new Error("opponent settlement signature failed verification");
    }
    return this.selfIsA()
      ? { settlement, sigA: sigSelf, sigB: sigOther }
      : { settlement, sigA: sigOther, sigB: sigSelf };
  }

  /**
   * Sign THIS seat's half of a root-anchored cooperative settlement for the current state.
   * `finalNonce = onchainNonce + 1`; bytes are byte-identical to
   * `OffchainTunnel.buildSettlementWithRoot`. Both seats MUST pass the SAME `transcriptRoot`
   * (each derives it from its own transcript and they agree out-of-band), or the combined
   * signatures verify off-chain but fail at close_cooperative_with_root.
   */
  buildSettlementHalfWithRoot(
    timestamp: bigint,
    transcriptRoot: Uint8Array,
    onchainNonce: bigint = 0n
  ): { settlement: SettlementWithRoot; sigSelf: Uint8Array } {
    if (transcriptRoot.length !== 32) {
      throw new Error("transcriptRoot must be 32 bytes");
    }
    const { a, b } = this.protocol.balances(this._state);
    const settlement: SettlementWithRoot = {
      tunnelId: this.tunnelId,
      partyABalance: a,
      partyBBalance: b,
      finalNonce: onchainNonce + 1n,
      timestamp,
      transcriptRoot,
    };
    const sigSelf = this.self.sign!(serializeSettlementWithRoot(settlement));
    return { settlement, sigSelf };
  }

  /** Combine our root-anchored half with the opponent's into a dual-signed settlement,
   *  verifying theirs over the with-root bytes. */
  combineSettlementWithRoot(
    settlement: SettlementWithRoot,
    sigSelf: Uint8Array,
    sigOther: Uint8Array
  ): CoSignedSettlementWithRoot {
    const msg = serializeSettlementWithRoot(settlement);
    if (!this.opponent.verify(msg, sigOther)) {
      throw new Error("opponent settlement signature failed verification");
    }
    return this.selfIsA()
      ? { settlement, sigA: sigSelf, sigB: sigOther }
      : { settlement, sigA: sigOther, sigB: sigSelf };
  }
}
