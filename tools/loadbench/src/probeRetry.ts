/**
 * Bounded retry for on-chain submission under concurrency.
 *
 * When many txs from one owner are in flight, the SDK selects a gas coin via RPC
 * (`getCoins`) and another in-flight tx can consume/re-version that coin before
 * this one executes — surfacing as "object … unavailable for consumption" /
 * "Transaction needs to be rebuilt". This is expected load-generator noise, not a
 * back-pressure signal: rebuild the tx (re-selects a fresh coin version) and retry
 * with brief backoff. Move aborts, insufficient-gas, and malformed-tx errors are
 * NOT retriable and propagate immediately so real failures stay visible.
 *
 * The caller's `fn` MUST construct a fresh `Transaction` each call so the retry
 * actually re-resolves gas — passing a pre-built tx would retry the same stale refs.
 */

/** Stale-gas / equivocation signatures that a rebuild-and-resubmit can clear. */
const RETRIABLE_TX =
  /unavailable for consumption|needs to be rebuilt|not available for consumption|equivocat|reserved for another transaction|object version unavailable|ObjectVersionUnavailable|quorum.*conflict|-32002/i;

export function isRetriableTxError(e: unknown): boolean {
  return RETRIABLE_TX.test(String((e as { message?: unknown })?.message ?? e));
}

/** Run `fn`, retrying up to `tries` times on a retriable submission error with
 *  linear backoff (`baseDelayMs · attempt`). Re-throws the last error if exhausted
 *  or if the error is not retriable. */
export async function withTxRetry<T>(
  fn: () => Promise<T>,
  tries = 5,
  baseDelayMs = 40,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetriableTxError(e)) throw e;
      if (attempt < tries)
        await new Promise<void>((r) => setTimeout(r, baseDelayMs * attempt));
    }
  }
  throw lastErr;
}
