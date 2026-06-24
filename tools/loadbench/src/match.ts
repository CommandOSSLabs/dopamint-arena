import type { Transport } from "../../../sui-tunnel-ts/src/core/distributedTunnel";
import { DistributedTunnel } from "../../../sui-tunnel-ts/src/core/distributedTunnel";
import { makeEndpoint, type CoSignedSettlementWithRoot } from "../../../sui-tunnel-ts/src/core/tunnel";
import { defaultBackend } from "../../../sui-tunnel-ts/src/core/crypto-native";
import { createParticipant } from "../../../sui-tunnel-ts/src/core/keys";
import { blake2b256 } from "../../../sui-tunnel-ts/src/core/crypto";
import { toHex, fromHex } from "../../../sui-tunnel-ts/src/core/bytes";
import { mulberry32 } from "../../../sui-tunnel-ts/src/sim/rng";
import type { Protocol, Party } from "../../../sui-tunnel-ts/src/protocol/Protocol";
import type { MoveCodec } from "../../../sui-tunnel-ts/src/core/distributedFrame";

export type Participant = ReturnType<typeof createParticipant>;
export interface Seats {
  tunnelId: string;
  balances: { a: bigint; b: bigint };
  createdAt: bigint;
  partyA: Participant;
  partyB: Participant;
}
export interface MatchResult {
  moves: number;
  bytes: number;
  latenciesMs: number[];
  settlement: CoSignedSettlementWithRoot;
}

/**
 * Derive a 32-byte hex tunnel ID from a human-readable label.
 * Wire format requires a 0x-prefixed hex string (Sui object ID shape).
 */
function tunnelIdFromLabel(label: string): string {
  const hash = blake2b256(new TextEncoder().encode(`dopamint:tunnel:${label}`));
  return "0x" + Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic seats with fresh ephemeral keys, for off-chain play (no chain). */
export function makeSeats(label: string, balances: { a: bigint; b: bigint }, createdAt: bigint): Seats {
  const tunnelId = tunnelIdFromLabel(label);
  return {
    tunnelId,
    balances,
    createdAt,
    partyA: createParticipant(`${label}-A`),
    partyB: createParticipant(`${label}-B`),
  };
}

/**
 * A move codec that round-trips arbitrary JSON-like moves with bigint and
 * Uint8Array fields. Bigints encode as `{ "__bigint__": "<decimal>" }` and
 * Uint8Arrays as `{ "__bytes__": "<hex>" }` so both survive JSON serialization
 * inside the frame envelope (needed by quantumPoker's commitment arrays).
 */
const bigintSafeCodec: MoveCodec<unknown> = {
  encode(m: unknown): unknown {
    return JSON.parse(
      JSON.stringify(m, (_k, v) => {
        if (typeof v === "bigint") return { __bigint__: v.toString() };
        if (v instanceof Uint8Array) return { __bytes__: toHex(v) };
        return v;
      }),
    );
  },
  decode(j: unknown): unknown {
    return JSON.parse(JSON.stringify(j), (_k, v) => {
      if (v !== null && typeof v === "object") {
        if ("__bigint__" in v) return BigInt(v.__bigint__);
        if ("__bytes__" in v) return fromHex(v.__bytes__);
      }
      return v;
    });
  },
};

function countingTransport(t: Transport, onBytes: (n: number) => void): Transport {
  return { send: (f) => { onBytes(f.length); t.send(f); }, onFrame: (cb) => t.onFrame(cb) };
}

function proposeAndAwait(dt: DistributedTunnel<unknown, unknown>, move: unknown, ts: bigint): Promise<number> {
  const start = performance.now();
  return new Promise<number>((resolve, reject) => {
    let done = false;
    const prev = dt.onConfirmed;
    dt.onConfirmed = (u) => { prev?.(u); if (!done) { done = true; dt.onConfirmed = prev; resolve(performance.now() - start); } };
    try { dt.propose(move, ts); } catch (e) { dt.onConfirmed = prev; reject(e); }
  });
}

export async function playMatch(
  protocol: Protocol<unknown, unknown>,
  seats: Seats,
  transports: [Transport, Transport],
  opts: { seed?: number; maxMoves?: number } = {},
): Promise<MatchResult> {
  const backend = defaultBackend();
  const aEnd = makeEndpoint(backend, seats.partyA.address, seats.partyA.keyPair, true);
  const aOpp = makeEndpoint(backend, seats.partyB.address, seats.partyB.keyPair, false);
  const bEnd = makeEndpoint(backend, seats.partyB.address, seats.partyB.keyPair, true);
  const bOpp = makeEndpoint(backend, seats.partyA.address, seats.partyA.keyPair, false);
  let bytes = 0;
  const tA = countingTransport(transports[0], (n) => (bytes += n));
  const tB = countingTransport(transports[1], (n) => (bytes += n));
  const dtA = new DistributedTunnel(protocol, { tunnelId: seats.tunnelId, self: aEnd, opponent: aOpp, selfParty: "A", moveCodec: bigintSafeCodec }, tA, seats.balances);
  const dtB = new DistributedTunnel(protocol, { tunnelId: seats.tunnelId, self: bEnd, opponent: bOpp, selfParty: "B", moveCodec: bigintSafeCodec }, tB, seats.balances);
  const seatOf: Record<Party, DistributedTunnel<unknown, unknown>> = { A: dtA, B: dtB };

  const rng = mulberry32(opts.seed ?? 1);
  const maxMoves = opts.maxMoves ?? 1000;
  const latenciesMs: number[] = [];
  let moves = 0;
  let ts = seats.createdAt;
  const order: Party[] = ["A", "B"];
  while (moves < maxMoves && !protocol.isTerminal(dtA.state)) {
    let progressed = false;
    for (const p of order) {
      if (protocol.isTerminal(dtA.state)) break;
      const dt = seatOf[p];
      const move = protocol.randomMove?.(dt.state, p, rng) ?? null;
      if (move === null) continue;
      ts += 1n;
      latenciesMs.push(await proposeAndAwait(dt, move, ts));
      moves++;
      progressed = true;
      if (moves >= maxMoves) break;
    }
    if (!progressed) break;
  }

  const root = blake2b256(new TextEncoder().encode(`dopamint:${seats.tunnelId}`));
  const halfA = dtA.buildSettlementHalfWithRoot(seats.createdAt, root, 0n);
  const halfB = dtB.buildSettlementHalfWithRoot(seats.createdAt, root, 0n);
  const settlement = dtA.combineSettlementWithRoot(halfA.settlement, halfA.sigSelf, halfB.sigSelf);
  return { moves, bytes, latenciesMs, settlement };
}
