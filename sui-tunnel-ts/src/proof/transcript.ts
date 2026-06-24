/**
 * Proof-of-existence transcript (Deliverable 7) + settlement compression (Deliverable 8).
 *
 * Accumulates every co-signed state update for a tunnel and computes a Merkle root over
 * them. That 32-byte root is what both parties sign into `serialize_settlement_with_root`
 * and anchor on-chain at close (`tunnel::close_cooperative_with_root`) — compressing an
 * arbitrarily long interaction history to one on-chain commitment that later proves the
 * interactions existed. The full transcript streams to a pluggable store (proof/storage.ts);
 * the chain holds only the root.
 *
 * The Merkle algorithm here is an SDK-internal agreement between the two parties (both
 * compute the same root to co-sign it); the chain does not recompute it — it only stores
 * the agreed root. So this need not match Move, but it IS deterministic and replayable.
 */

import { concatBytes, toHex } from "../core/bytes";
import { blake2b256 } from "../core/crypto";
import { CoSignedUpdate } from "../core/tunnel";
import { serializeStateUpdate } from "../core/wire";

const LEAF = new TextEncoder().encode("sui_tunnel::transcript::leaf");
const NODE = new TextEncoder().encode("sui_tunnel::transcript::node");
const ZERO32 = new Uint8Array(32);

export interface TranscriptEntry {
  nonce: bigint;
  message: Uint8Array; // canonical serialized state_update
  sigA: Uint8Array;
  sigB: Uint8Array;
}

/** Leaf = blake2b256(domain ‖ state_update_message ‖ sigA ‖ sigB). */
export function transcriptLeaf(e: TranscriptEntry): Uint8Array {
  return blake2b256(concatBytes([LEAF, e.message, e.sigA, e.sigB]));
}

/** Merkle root over leaves (odd levels padded with a zero leaf). Empty => 32 zero bytes. */
export function transcriptRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return ZERO32;
  let level = leaves.slice();
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(ZERO32);
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(blake2b256(concatBytes([NODE, level[i], level[i + 1]])));
    }
    level = next;
  }
  return level[0];
}

/** A serializable proof-of-existence record for one tunnel's transcript. */
export interface ProofRecord {
  tunnelId: string;
  /** Hex Merkle root (the value anchored on-chain at close). */
  root: string;
  updateCount: number;
  /** Final settled balances, if known at export time. */
  finalBalances?: { a: string; b: string };
  closedAtMs?: number;
  /** Full transcript (hex-encoded) so interactions can be independently re-verified. */
  entries: { nonce: string; message: string; sigA: string; sigB: string }[];
}

/** Accumulates a tunnel's co-signed updates and produces the anchorable root + record. */
export class Transcript {
  readonly tunnelId: string;
  private readonly entries: TranscriptEntry[] = [];
  private readonly leaves: Uint8Array[] = [];

  constructor(tunnelId: string) {
    this.tunnelId = tunnelId;
  }

  /** Append a co-signed update (wire this to OffchainTunnel.onUpdate). */
  append(u: CoSignedUpdate): void {
    const e: TranscriptEntry = {
      nonce: u.update.nonce,
      message: serializeStateUpdate(u.update),
      sigA: u.sigA,
      sigB: u.sigB,
    };
    this.entries.push(e);
    this.leaves.push(transcriptLeaf(e));
  }

  get length(): number {
    return this.entries.length;
  }

  /** The 32-byte Merkle root to anchor on-chain at close. */
  root(): Uint8Array {
    return transcriptRoot(this.leaves);
  }

  /** Build the exportable proof record (optionally with final balances/close time). */
  toRecord(meta?: {
    finalBalances?: { a: bigint; b: bigint };
    closedAtMs?: number;
  }): ProofRecord {
    return {
      tunnelId: this.tunnelId,
      root: toHex(this.root()),
      updateCount: this.entries.length,
      finalBalances: meta?.finalBalances
        ? {
            a: meta.finalBalances.a.toString(),
            b: meta.finalBalances.b.toString(),
          }
        : undefined,
      closedAtMs: meta?.closedAtMs,
      entries: this.entries.map((e) => ({
        nonce: e.nonce.toString(),
        message: toHex(e.message),
        sigA: toHex(e.sigA),
        sigB: toHex(e.sigB),
      })),
    };
  }
}
