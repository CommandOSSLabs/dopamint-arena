/**
 * Participant key management for simulations and agents (Deliverables 1, 9).
 *
 * Generates ephemeral ed25519 identities in bulk (thousands of users/agents) with
 * stable ids and derived Sui addresses. Used by the simulator to assign parties to
 * tunnels and by the agent framework as autonomous identities. Ephemeral keys never
 * touch the chain except when a participant is also an on-chain funder.
 */

import {
  KeyPair,
  generateKeyPair,
  keyPairFromRng,
  ed25519Address,
} from "./crypto";

/** A seeded random generator returning floats in [0,1) (e.g. from sim/rng). */
export type Rng = () => number;

export interface Participant {
  /** Stable identifier, e.g. "user-0", "agent-3". */
  id: string;
  /** Sui address derived from the ed25519 public key. */
  address: string;
  keyPair: KeyPair;
}

/**
 * Create a participant. With `rng` (a seeded generator) the identity is
 * deterministic for reproducible simulations; without it, a fresh random key.
 */
export function createParticipant(id: string, rng?: Rng): Participant {
  const keyPair = rng ? keyPairFromRng(rng) : generateKeyPair();
  return { id, address: ed25519Address(keyPair.publicKey), keyPair };
}

/** A registry of participants, indexed by id. Pass `rng` for deterministic keys. */
export class ParticipantRegistry {
  private readonly byId = new Map<string, Participant>();
  private readonly order: Participant[] = [];

  constructor(private readonly rng?: Rng) {}

  /** Create and register a participant (throws on duplicate id). */
  create(id: string): Participant {
    if (this.byId.has(id)) throw new Error(`participant id exists: ${id}`);
    const p = createParticipant(id, this.rng);
    this.byId.set(id, p);
    this.order.push(p);
    return p;
  }

  /** Create `n` participants with ids `${prefix}0 .. ${prefix}n-1`. */
  createMany(prefix: string, n: number): Participant[] {
    const out = new Array<Participant>(n);
    for (let i = 0; i < n; i++) out[i] = this.create(`${prefix}${i}`);
    return out;
  }

  get(id: string): Participant {
    const p = this.byId.get(id);
    if (!p) throw new Error(`unknown participant: ${id}`);
    return p;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** All participants in creation order. */
  all(): readonly Participant[] {
    return this.order;
  }

  get size(): number {
    return this.order.length;
  }
}
