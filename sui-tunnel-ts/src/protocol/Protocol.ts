/**
 * Generic interaction-protocol abstraction (Deliverable 2).
 *
 * Every tunnel protocol — Payments, Blackjack, TicTacToe, Chat, Quantum Poker —
 * implements this one interface. The framework then gives ALL of them, for free:
 *  - state encoding         (encodeState -> blake2b256 -> the tunnel state_hash)
 *  - signature flow         (the canonical sui_tunnel::state_update message + dual sign)
 *  - settlement mechanism   (balances() drives cooperative close / dispute)
 *  - replay protection      (the engine's strictly-increasing per-tunnel nonce)
 *
 * Protocols contain ONLY their domain logic (how a move changes state and balances);
 * they never touch keys, wire bytes, or the chain. The off-chain engine
 * (core/tunnel.ts) drives them. This keeps protocol code tiny and uniform, and means
 * a new protocol cannot accidentally break the on-chain-settleable wire format.
 */

import { concatBytes } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";

/** The two sides of a tunnel. */
export type Party = "A" | "B";

export function otherParty(p: Party): Party {
  return p === "A" ? "B" : "A";
}

/** Settleable balances for a state; MUST always sum to the tunnel's locked total. */
export interface Balances {
  a: bigint;
  b: bigint;
}

export interface ProtocolContext {
  tunnelId: string;
  /** Balances locked by each party at open; the invariant sum for the tunnel's life. */
  initialBalances: Balances;
}

/**
 * A protocol over an off-chain tunnel.
 *
 * @typeParam State - the protocol's full off-chain state (kept in memory, never on-chain)
 * @typeParam Move  - a single action a party can take
 */
export interface Protocol<State, Move> {
  /** Stable identifier, also used as the state-encoding domain tag. */
  readonly name: string;

  /** Deterministic initial state for a freshly opened tunnel. */
  initialState(ctx: ProtocolContext): State;

  /**
   * Validate and apply `move` made by party `by`, returning the next state.
   * MUST be pure (no mutation of `state`) and MUST throw on an illegal move.
   */
  applyMove(state: State, move: Move, by: Party): State;

  /**
   * Deterministic byte encoding of `state`, hashed into the tunnel's state_hash.
   * MUST be canonical (same state -> same bytes on both parties). For large/growing
   * state, return a fixed-size rolling digest instead of the full state (see
   * {@link rollingDigest}) to keep per-update cost O(1).
   */
  encodeState(state: State): Uint8Array;

  /** On-chain-settleable balances for `state`. MUST sum to the locked total. */
  balances(state: State): Balances;

  /** Whether `state` is terminal (the game/session is over and ready to settle). */
  isTerminal(state: State): boolean;

  /**
   * Optional: produce a legal move for `by`, or null if none. Drives the simulator
   * and autonomous agents. `rng` returns a float in [0,1).
   */
  randomMove?(state: State, by: Party, rng: () => number): Move | null;
}

// ============================================
// ENCODING HELPERS for protocol authors
// ============================================

const enc = new TextEncoder();

/** Domain tag bytes for a protocol's state encoding: `b"sui_tunnel::proto::<name>"`. */
export function protocolDomain(name: string): Uint8Array {
  return enc.encode(`sui_tunnel::proto::${name}`);
}

/** Length-prefixed concatenation: each part becomes `u64be(len) || part`. */
export function lengthPrefixedConcat(parts: Uint8Array[]): Uint8Array {
  const out: Uint8Array[] = [];
  for (const p of parts) {
    out.push(u64ToBeBytes(p.length), p);
  }
  return concatBytes(out);
}

/**
 * O(1) rolling digest for large-state protocols:
 * `next = blake2b256(prevDigest || delta)`. Lets a protocol's encodeState return a
 * 32-byte digest instead of re-serializing full history each transition.
 * (Imported lazily to avoid a hard dependency for protocols that don't need it.)
 */
export function rollingDigest(
  blake2b256: (d: Uint8Array) => Uint8Array,
  prevDigest: Uint8Array,
  delta: Uint8Array
): Uint8Array {
  return blake2b256(concatBytes([prevDigest, delta]));
}
