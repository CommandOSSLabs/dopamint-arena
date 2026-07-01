import {
  computeUnlocked,
  StreamStatus,
  type StreamFields,
} from "@/onchain/streamingPayment";

import type { StreamingTick } from "../types";

/** Build the next tick proposal from chain stream fields and wall clock. */
export function buildTick(
  stream: StreamFields,
  tickNonce: number,
  timestampMs: bigint,
): StreamingTick {
  return {
    streamId: stream.id,
    tickNonce,
    timestampMs,
    accruedUnlocked: computeUnlocked(stream, timestampMs),
  };
}

/**
 * B-side verify (self-play: local B keypair; target: contractor bot).
 * Returns an error message when the tick must be rejected.
 */
export function verifyTick(
  stream: StreamFields,
  tick: StreamingTick,
  prior: StreamingTick | null,
): string | null {
  if (tick.streamId !== stream.id) return "streamId mismatch";
  if (stream.status !== StreamStatus.ACTIVE) return "stream not active";
  if (tick.tickNonce !== (prior?.tickNonce ?? -1) + 1) return "bad tick nonce";
  if (tick.timestampMs < stream.startMs) return "timestamp before start";
  if (tick.timestampMs > stream.endMs) return "timestamp after end";
  if (tick.accruedUnlocked > stream.totalAmount) return "accrued exceeds total";

  const expected = computeUnlocked(stream, tick.timestampMs);
  if (tick.accruedUnlocked !== expected)
    return "accrued does not match unlock formula";

  if (prior && tick.accruedUnlocked < prior.accruedUnlocked) {
    return "accrued not monotonic";
  }

  return null;
}

/** Display accrued capped at on-chain available (docs display rule). */
export function displayAccrued(
  verifiedAccrued: bigint,
  onChainAvailable: bigint,
): bigint {
  return verifiedAccrued < onChainAvailable
    ? verifiedAccrued
    : onChainAvailable;
}
