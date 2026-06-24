/**
 * In-memory off-chain tunnel engine — the per-interaction hot path that produces
 * "effective TPS". NO Sui RPC: between open and close, a tunnel only hashes app
 * state, serializes the canonical state_update message, signs it with both parties,
 * and (in honest mode) verifies both signatures. Each fully co-signed, verified
 * transition is one effective transaction.
 *
 * Replay protection: a single strictly-increasing per-tunnel nonce. Steps MUST be
 * applied in order on one tunnel (the channel-safety invariant); parallelism comes
 * from running MANY tunnels, not concurrent steps on one tunnel (see DESIGN_REVIEW B9).
 */

import { Balances, Party, Protocol } from "../protocol/Protocol";
import {
  blake2b256,
  CryptoBackend,
  KeyPair,
  SignatureScheme,
  SignFn,
  verify,
  VerifyFn,
} from "./crypto";
import { defaultBackend } from "./crypto-native";
import {
  serializeSettlement,
  serializeSettlementWithRoot,
  serializeStateUpdate,
  Settlement,
  SettlementWithRoot,
  StateUpdate,
  StateUpdateWriter,
} from "./wire";

const EMPTY = new Uint8Array(0);

/** One side of a tunnel. `secretKey`/`sign` are present only for parties this process controls. */
export interface PartyEndpoint {
  address: string;
  publicKey: Uint8Array;
  scheme: number;
  secretKey?: Uint8Array;
  /** Backend-bound signer; present iff this party is controlled locally. */
  sign?: SignFn;
  /** Backend-bound verifier (always present). */
  verify: VerifyFn;
}

/** Build a party endpoint with backend-bound signer/verifier closures. */
export function makeEndpoint(
  backend: CryptoBackend,
  address: string,
  keyPair: { publicKey: Uint8Array; scheme: number; secretKey?: Uint8Array },
  controlled: boolean,
): PartyEndpoint {
  return {
    address,
    publicKey: keyPair.publicKey,
    scheme: keyPair.scheme,
    secretKey: controlled ? keyPair.secretKey : undefined,
    sign:
      controlled && keyPair.secretKey
        ? backend.makeSigner(keyPair.secretKey)
        : undefined,
    verify: backend.makeVerifier(keyPair.publicKey),
  };
}

/** A state update co-signed by both parties — the unit that is settleable on-chain. */
export interface CoSignedUpdate {
  update: StateUpdate;
  sigA: Uint8Array;
  sigB: Uint8Array;
}

/** A settlement co-signed by both parties — submitted by `close_cooperative`. */
export interface CoSignedSettlement {
  settlement: Settlement;
  sigA: Uint8Array;
  sigB: Uint8Array;
}

/** A root-anchored settlement co-signed by both parties (`close_cooperative_with_root`). */
export interface CoSignedSettlementWithRoot {
  settlement: SettlementWithRoot;
  sigA: Uint8Array;
  sigB: Uint8Array;
}

export interface OffchainTunnelConfig {
  tunnelId: string;
  partyA: PartyEndpoint;
  partyB: PartyEndpoint;
}

/**
 * Signing behavior per step:
 *  - "full": both parties sign AND both signatures are verified (honest effective TPS).
 *  - "sign-only": both parties sign, no verification (measures raw signing rate).
 *  - "none": apply state only, no crypto (measures protocol/engine overhead).
 */
export type SignMode = "full" | "sign-only" | "none";

export interface StepOptions {
  /** Agreed off-chain timestamp embedded in the signed message (ms). Default 0. */
  timestamp?: bigint;
  mode?: SignMode;
}

export interface StepResult {
  nonce: bigint;
  signed: CoSignedUpdate | null;
  /** True when mode === "full" and both signatures verified. */
  verified: boolean;
  /** Serialized message size in bytes (for bandwidth accounting). */
  messageBytes: number;
}

/** Optional per-update observer (telemetry hook, transcript accumulator). */
export type UpdateObserver = (u: CoSignedUpdate, messageBytes: number) => void;

export class OffchainTunnel<State, Move> {
  readonly tunnelId: string;
  readonly protocol: Protocol<State, Move>;
  readonly partyA: PartyEndpoint;
  readonly partyB: PartyEndpoint;
  readonly total: bigint;

  private _state: State;
  private _nonce: bigint;
  private _latest: CoSignedUpdate | null;
  private readonly writer: StateUpdateWriter;

  /** Called after every co-signed update; used by telemetry / transcript export. */
  onUpdate?: UpdateObserver;

  constructor(
    protocol: Protocol<State, Move>,
    config: OffchainTunnelConfig,
    initialBalances: Balances,
  ) {
    this.tunnelId = config.tunnelId;
    this.protocol = protocol;
    this.partyA = config.partyA;
    this.partyB = config.partyB;
    this.total = initialBalances.a + initialBalances.b;
    this._state = protocol.initialState({
      tunnelId: config.tunnelId,
      initialBalances,
    });
    const { a, b } = protocol.balances(this._state);
    if (a + b !== this.total) {
      throw new Error(
        `protocol initial balances ${a + b} != locked total ${this.total}`,
      );
    }
    this._nonce = 0n; // on-chain initial commitment is nonce 0
    this._latest = null;
    this.writer = new StateUpdateWriter(config.tunnelId, 32);
  }

  /** Convenience self-play factory: this process holds both keypairs. Uses the
   * fastest crypto backend available (native in Node) unless one is provided. */
  static selfPlay<S, M>(
    protocol: Protocol<S, M>,
    tunnelId: string,
    keyA: KeyPair,
    keyB: KeyPair,
    addrA: string,
    addrB: string,
    initialBalances: Balances,
    backend: CryptoBackend = defaultBackend(),
  ): OffchainTunnel<S, M> {
    return new OffchainTunnel(
      protocol,
      {
        tunnelId,
        partyA: makeEndpoint(backend, addrA, keyA, true),
        partyB: makeEndpoint(backend, addrB, keyB, true),
      },
      initialBalances,
    );
  }

  get state(): State {
    return this._state;
  }
  get nonce(): bigint {
    return this._nonce;
  }
  /** Highest co-signed update — the artifact used for cooperative close / dispute. */
  get latest(): CoSignedUpdate | null {
    return this._latest;
  }

  /**
   * Apply one protocol move and co-sign the resulting state. Returns the result;
   * on "full"/"sign-only" the co-signed update is also stored as {@link latest}.
   */
  step(move: Move, by: Party, opts: StepOptions = {}): StepResult {
    const mode = opts.mode ?? "full";
    const next = this.protocol.applyMove(this._state, move, by);
    const { a, b } = this.protocol.balances(next);
    if (a + b !== this.total) {
      throw new Error(`balance sum ${a + b} != locked total ${this.total}`);
    }
    const nonce = this._nonce + 1n;
    const timestamp = opts.timestamp ?? 0n;
    const stateHash = blake2b256(this.protocol.encodeState(next));

    let signed: CoSignedUpdate | null = null;
    let verified = false;
    let messageBytes = 0;

    if (mode !== "none") {
      // Zero-alloc tail write into the reused buffer; sign reads it synchronously.
      const msg = this.writer.write(stateHash, nonce, timestamp, a, b);
      messageBytes = msg.length;
      const sigA = this.partyA.sign ? this.partyA.sign(msg) : EMPTY;
      const sigB = this.partyB.sign ? this.partyB.sign(msg) : EMPTY;
      if (mode === "full") {
        verified =
          this.partyA.verify(msg, sigA) && this.partyB.verify(msg, sigB);
        if (!verified) {
          throw new Error("self co-signed update failed verification (bug)");
        }
      }
      const update: StateUpdate = {
        tunnelId: this.tunnelId,
        stateHash, // fresh array from blake2b256 (not the shared writer buffer)
        nonce,
        timestamp,
        partyABalance: a,
        partyBBalance: b,
      };
      signed = { update, sigA, sigB };
      this._latest = signed;
    } else {
      // still account message size for bandwidth math
      messageBytes = serializeStateUpdate({
        tunnelId: this.tunnelId,
        stateHash,
        nonce,
        timestamp,
        partyABalance: a,
        partyBBalance: b,
      }).length;
    }

    this._state = next;
    this._nonce = nonce;
    if (signed && this.onUpdate) this.onUpdate(signed, messageBytes);
    return { nonce, signed, verified, messageBytes };
  }

  /**
   * Produce the dual-signed cooperative-settlement artifact for the current state.
   *
   * `tunnel::close_cooperative` derives `final_nonce = tunnel.state.nonce + 1` (the
   * on-chain committed nonce, NOT the off-chain step counter) and verifies both
   * signatures over a message rebuilt with that value. So the settlement must be signed
   * with `onchainNonce + 1`, where `onchainNonce` is the tunnel's current on-chain
   * `state.nonce`. It defaults to 0 — the value for a tunnel that never submitted
   * `update_state` on-chain, i.e. the normal cooperative-close case. Pass the actual
   * on-chain nonce if `update_state` was checkpointed on-chain.
   */
  buildSettlement(
    timestamp: bigint,
    onchainNonce: bigint = 0n,
  ): CoSignedSettlement {
    if (!this.partyA.sign || !this.partyB.sign) {
      throw new Error("buildSettlement requires both signers (self-play)");
    }
    const { a, b } = this.protocol.balances(this._state);
    const settlement: Settlement = {
      tunnelId: this.tunnelId,
      partyABalance: a,
      partyBBalance: b,
      finalNonce: onchainNonce + 1n,
      timestamp,
    };
    const msg = serializeSettlement(settlement);
    return {
      settlement,
      sigA: this.partyA.sign(msg),
      sigB: this.partyB.sign(msg),
    };
  }

  /**
   * Produce the dual-signed root-anchored settlement (Deliverable 7/8). `transcriptRoot`
   * is typically `Transcript.root()` (proof/transcript.ts). Settled via
   * `tunnel::close_cooperative_with_root`, compressing the whole transcript to one root.
   */
  buildSettlementWithRoot(
    timestamp: bigint,
    transcriptRoot: Uint8Array,
    onchainNonce: bigint = 0n,
  ): CoSignedSettlementWithRoot {
    if (!this.partyA.sign || !this.partyB.sign) {
      throw new Error(
        "buildSettlementWithRoot requires both signers (self-play)",
      );
    }
    if (transcriptRoot.length !== 32) {
      throw new Error("transcriptRoot must be 32 bytes");
    }
    const { a, b } = this.protocol.balances(this._state);
    // final_nonce = on-chain state.nonce + 1 (see buildSettlement); close_cooperative_with_root
    // recomputes it the same way, so the signed value must match the chain's, not _nonce.
    const settlement: SettlementWithRoot = {
      tunnelId: this.tunnelId,
      partyABalance: a,
      partyBBalance: b,
      finalNonce: onchainNonce + 1n,
      timestamp,
      transcriptRoot,
    };
    const msg = serializeSettlementWithRoot(settlement);
    return {
      settlement,
      sigA: this.partyA.sign(msg),
      sigB: this.partyB.sign(msg),
    };
  }
}

/** Independently verify a co-signed update (used in replay / audit / proof-of-existence). */
export function verifyCoSignedUpdate(
  u: CoSignedUpdate,
  partyA: { publicKey: Uint8Array; scheme: number },
  partyB: { publicKey: Uint8Array; scheme: number },
): boolean {
  if (
    partyA.scheme !== SignatureScheme.ED25519 ||
    partyB.scheme !== SignatureScheme.ED25519
  ) {
    throw new Error("verifyCoSignedUpdate currently supports ed25519 only");
  }
  const msg = serializeStateUpdate(u.update);
  return (
    verify(u.sigA, msg, partyA.publicKey) &&
    verify(u.sigB, msg, partyB.publicKey)
  );
}
