import type { TunnelEvent } from "./controlPlane";
import type { TxnRow } from "../panels/types";

/** MIST (1e9) → trimmed SUI string, e.g. 2_000_000_000 → "2", 2 → "0.000000002". */
function fmtSui(mist: number): string {
  const whole = Math.trunc(mist / 1e9);
  const frac = String(Math.abs(mist) % 1e9)
    .padStart(9, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Stable non-negative int from the tx digest, for React keys (djb2). */
function digestId(digest: string): number {
  let h = 5381;
  for (let i = 0; i < digest.length; i++)
    h = ((h << 5) + h + digest.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Project backend settlement events to on-chain feed rows. Honest by construction: a settled
 * row shows the total pot SETTLED (not a P&L "win"), balances are SUI not dollars, and `game`
 * is "" so events get no false per-game attribution (the backend has no game tag).
 */
export function recentEventsToTxnRows(events: TunnelEvent[]): TxnRow[] {
  return events.map((e) => {
    const settled = e.kind === "settled";
    const pot =
      settled && e.partyABalance != null && e.partyBBalance != null
        ? `${fmtSui(e.partyABalance + e.partyBBalance)} SUI`
        : "—";
    return {
      id: digestId(e.txDigest),
      game: "",
      digest: e.txDigest,
      proofUrl: e.proofUrl ?? undefined,
      time: new Date(e.timestampMs).toLocaleTimeString("en-GB"),
      bot: e.tunnelId,
      type: settled ? "Settled" : "Opened",
      status: "Success",
      amount: pot,
    };
  });
}
