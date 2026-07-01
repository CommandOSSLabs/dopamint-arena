// Typed reads over the explorer-api (Phase 2b). camelCase wire (ADR-0002); same-origin by
// default (Vite proxies /v1), or VITE_BACKEND_URL when split. The detail page verifies
// client-side, so this only fetches rows + the (proxied) transcript blob.
import { resolveBackendUrl } from "./controlPlane";
import type { ProofRecord } from "../../../sui-tunnel-ts/src/proof/transcript";

export type LifecycleKind = "opened" | "settled";

export interface SettlementRow {
  txDigest: string;
  kind: LifecycleKind;
  tunnelId: string;
  partyAAddr: string | null;
  partyBAddr: string | null;
  // u64 MIST / nonce as decimal strings (ADR-0002) — parse with BigInt; a number would lose
  // precision past 2^53 MIST (~9.0M SUI) and break the in-browser balance-conservation check.
  partyABalance: string | null;
  partyBBalance: string | null;
  finalNonce: string | null;
  transcriptRoot: string | null;
  proofUrl: string | null;
  walrusBlobId: string | null;
  checkpoint: number;
  timestampMs: number;
  closedAtMs: number | null;
  game: string | null;
}

export interface SettlementPage {
  rows: SettlementRow[];
  nextCursor: string | null; // opaque composite keyset token; pass back verbatim
}

/** Re-export the canonical SDK transcript record so the verify path has one source of truth. */
export type { ProofRecord };

export interface SettlementQuery {
  limit: number;
  cursor?: string; // opaque composite keyset token from a prior page's nextCursor
  tunnel?: string;
  address?: string;
  kind?: LifecycleKind;
}

export function settlementsUrl(base: string, q: SettlementQuery): string {
  const root = base.replace(/\/+$/, "");
  const p = new URLSearchParams();
  p.set("limit", String(q.limit));
  if (q.cursor) p.set("cursor", q.cursor);
  if (q.tunnel) p.set("tunnel", q.tunnel);
  if (q.address) p.set("address", q.address);
  if (q.kind) p.set("kind", q.kind);
  return `${root}/v1/settlements?${p.toString()}`;
}

const base = () => resolveBackendUrl();
/** Backend root with any trailing slashes trimmed (the explorer paths are appended raw). */
const apiRoot = () => base().replace(/\/+$/, "");

export async function listSettlements(
  q: SettlementQuery,
): Promise<SettlementPage> {
  const res = await fetch(settlementsUrl(base(), q));
  if (!res.ok) throw new Error(`listSettlements ${res.status}`);
  return (await res.json()) as SettlementPage;
}

export async function getSettlement(digest: string): Promise<SettlementRow> {
  const res = await fetch(`${apiRoot()}/v1/settlements/${digest}`);
  if (!res.ok) throw new Error(`getSettlement ${res.status}`);
  return (await res.json()) as SettlementRow;
}

/** Transcript bytes plus the api's declared wire format, so the caller picks the right verifier. */
export type TranscriptFetch = {
  bytes: Uint8Array;
  /** "entries" = server-owned chunks (root/balances from the row); "body" = whole settle body. */
  format: "entries" | "body";
};

/**
 * The transcript bytes, via the explorer api (same-origin). The api serves the bot's reassembled
 * S3 chunks when present (entries-only) and falls back to the legacy Walrus blob (a whole settle
 * body), tagging which via the `x-transcript-format` header — the caller uses it to choose the
 * verifier. Throws on a non-ok response (404 => anchored-but-unverifiable), which the caller catches.
 */
export async function getTranscript(
  digest: string,
): Promise<TranscriptFetch | null> {
  const res = await fetch(`${apiRoot()}/v1/settlements/${digest}/transcript`);
  if (!res.ok) throw new Error(`getTranscript ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const format =
    res.headers.get("x-transcript-format") === "entries" ? "entries" : "body";
  return { bytes, format };
}

/** Live new-settlement feed (SSE). Returns an unsubscribe fn. */
export function openExplorerStream(
  onRow: (row: SettlementRow) => void,
): () => void {
  const src = new EventSource(`${apiRoot()}/v1/explorer/stream`);
  src.onmessage = (ev) => {
    try {
      onRow(JSON.parse(ev.data) as SettlementRow);
    } catch {
      /* ignore malformed frame */
    }
  };
  return () => src.close();
}
