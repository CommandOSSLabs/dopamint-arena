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

import { CoSignedUpdate } from "../core/tunnel";
import { serializeStateUpdate, parseStateUpdate } from "../core/wire";
import { blake2b256, verify, SignatureScheme } from "../core/crypto";
import { concatBytes, toHex } from "../core/bytes";
import { decodeSettleBody, decodeSettleEntries, SettleEntry } from "./settleBinary";

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

export interface TranscriptVerification {
  ok: boolean;
  rootMatches: boolean;
  allSigsValid: boolean;
  nonceMonotonic: boolean;
  balancesConserved: boolean;
  stepCount: number;
  steps: {
    nonce: bigint;
    sigAValid: boolean;
    sigBValid: boolean;
    partyABalance: bigint;
    partyBBalance: bigint;
  }[];
  failures: string[];
}

function normRoot(hex: string): string {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  return h.toLowerCase();
}

export interface VerifyParams {
  partyA: { publicKey: Uint8Array; scheme: number };
  partyB: { publicKey: Uint8Array; scheme: number };
  onchainRoot: string;
  lockedTotal?: bigint;
}

/**
 * The four-check verification core, shared by both transcript sources. Proves mutual authorization
 * + integrity — dual signatures, strictly increasing nonces, Merkle root == anchored root, balance
 * conservation (a+b constant, == lockedTotal if given). Does NOT prove game fairness (per-step app
 * state is only hashed, never revealed). ed25519 only; throws on any other scheme.
 *
 * `bodyHeaderRoot` is supplied ONLY for a whole settle body: the recomputed root must then agree
 * with both the body's own header root AND the on-chain anchor. For entries-only chunks there is no
 * header, so the anchor (from the on-chain settlement row) is the sole root of trust.
 */
function verifyEntries(
  entries: SettleEntry[],
  params: VerifyParams,
  bodyHeaderRoot?: string
): TranscriptVerification {
  if (
    params.partyA.scheme !== SignatureScheme.ED25519 ||
    params.partyB.scheme !== SignatureScheme.ED25519
  ) {
    throw new Error("verifyTranscript currently supports ed25519 only");
  }

  const failures: string[] = [];
  const steps: TranscriptVerification["steps"] = [];
  const leaves: Uint8Array[] = [];
  let allSigsValid = true;
  let nonceMonotonic = true;
  let balancesConserved = true;
  let prevNonce: bigint | null = null;
  let total: bigint | null = params.lockedTotal ?? null;

  for (const { message, sigA, sigB } of entries) {
    const su = parseStateUpdate(message);

    const sigAValid = verify(sigA, message, params.partyA.publicKey);
    const sigBValid = verify(sigB, message, params.partyB.publicKey);
    if (!sigAValid || !sigBValid) allSigsValid = false;

    if (prevNonce !== null && su.nonce <= prevNonce) nonceMonotonic = false;
    prevNonce = su.nonce;

    const sum = su.partyABalance + su.partyBBalance;
    if (total === null) total = sum;
    else if (sum !== total) balancesConserved = false;

    leaves.push(transcriptLeaf({ nonce: su.nonce, message, sigA, sigB }));
    steps.push({
      nonce: su.nonce,
      sigAValid,
      sigBValid,
      partyABalance: su.partyABalance,
      partyBBalance: su.partyBBalance,
    });
  }

  const recomputed = toHex(transcriptRoot(leaves));
  const rootMatches =
    recomputed === normRoot(params.onchainRoot) &&
    (bodyHeaderRoot === undefined || recomputed === normRoot(bodyHeaderRoot));

  if (!rootMatches)
    failures.push("merkle root does not match the on-chain anchor");
  if (!allSigsValid) failures.push("one or more dual signatures are invalid");
  if (!nonceMonotonic) failures.push("nonces are not strictly increasing");
  if (!balancesConserved) failures.push("balance conservation violated");

  return {
    ok: rootMatches && allSigsValid && nonceMonotonic && balancesConserved,
    rootMatches,
    allSigsValid,
    nonceMonotonic,
    balancesConserved,
    stepCount: entries.length,
    steps,
    failures,
  };
}

/**
 * Verify a whole settle body (229-byte header + entries) — the legacy one-object archive the
 * explorer proxies from Walrus. The recomputed root is cross-checked against BOTH the body's header
 * root and the on-chain anchor.
 */
export function verifyTranscript(
  blob: Uint8Array,
  params: VerifyParams
): TranscriptVerification {
  const decoded = decodeSettleBody(blob);
  return verifyEntries(decoded.entries, params, toHex(decoded.transcriptRoot));
}

/**
 * Verify header-less reassembled chunks (entries only) — the bot-owned transcript served by the
 * explorer's chunk path. There is no body header, so root and balances come from the on-chain
 * settlement row via `params.onchainRoot` / `params.lockedTotal`.
 */
export function verifyTranscriptEntries(
  entriesBlob: Uint8Array,
  params: VerifyParams
): TranscriptVerification {
  return verifyEntries(decodeSettleEntries(entriesBlob), params);
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

  /** Raw co-signed entries (Uint8Array message + sigs) for binary settle encoding. */
  rawEntries(): TranscriptEntry[] {
    return this.entries.slice();
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
