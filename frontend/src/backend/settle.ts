// Cooperative-settle orchestration shared by every game (ADR-0002/0005). The exact
// `try backend /settle → catch → client close` shape was copy-pasted across ~12 hooks; this
// centralizes it. The CLOSE fallback stays a caller callback on purpose: the close mechanism
// differs per game (the shared `closeCooperativeWithRoot` vs a vendored `buildCloseWithRootTx`
// builder, and the sponsored-vs-wallet signer choice), but the settle-then-fallback flow does not.
import type { CoSignedSettlementWithRoot } from "sui-tunnel-ts/core/tunnel";
import type { TranscriptEntry } from "sui-tunnel-ts/proof/transcript";
import { getControlPlaneClient } from "./controlPlane";
import { coSignedToSettleBody } from "./settleRequest";

/**
 * Settle a tunnel: submit the co-signed root settlement to the backend `/settle` route (server-
 * sponsored close + Walrus transcript archival). If that route is unavailable, run `fallbackClose`
 * — a client-submitted `close_cooperative_with_root`. `label` only tags the fallback warning.
 *
 * Returns the close tx digest from whichever path landed it (the backend's, or the fallback's if it
 * returns one), so the caller records the SAME bookkeeping on both paths. A `fallbackClose` that
 * returns nothing yields `undefined`.
 */
export async function settleViaBackend(opts: {
  tunnelId: string;
  settlement: CoSignedSettlementWithRoot;
  transcript: TranscriptEntry[];
  label: string;
  fallbackClose: () => Promise<string | { digest: string } | void>;
}): Promise<string | undefined> {
  try {
    const r = await getControlPlaneClient().settle(
      opts.tunnelId,
      coSignedToSettleBody(opts.settlement, opts.transcript),
    );
    return r.txDigest;
  } catch (e) {
    console.warn(
      `[${opts.label}] backend settle failed; falling back to wallet close:`,
      e,
    );
    const r = await opts.fallbackClose();
    return typeof r === "string" ? r : r?.digest;
  }
}
