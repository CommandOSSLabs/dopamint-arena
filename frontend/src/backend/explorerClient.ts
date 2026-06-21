// Typed reads over the explorer-api (Phase 2b). camelCase wire (ADR-0002); same-origin by
// default (Vite proxies /v1), or VITE_BACKEND_URL when split. The detail page verifies
// client-side, so this only fetches rows + the (proxied) transcript blob.
import { resolveBackendUrl } from "./controlPlane";

export type LifecycleKind = "opened" | "settled";

export interface SettlementRow {
  txDigest: string;
  kind: LifecycleKind;
  tunnelId: string;
  partyAAddr: string | null;
  partyBAddr: string | null;
  partyABalance: number | null;
  partyBBalance: number | null;
  finalNonce: number | null;
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

/** Hex-encoded transcript (the `ProofRecord` shape produced by the SDK's Transcript). */
export interface ProofRecord {
  tunnelId: string;
  root: string;
  updateCount: number;
  finalBalances?: { a: string; b: string };
  closedAtMs?: number;
  entries: { nonce: string; message: string; sigA: string; sigB: string }[];
}

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

export async function listSettlements(q: SettlementQuery): Promise<SettlementPage> {
  const res = await fetch(settlementsUrl(base(), q));
  if (!res.ok) throw new Error(`listSettlements ${res.status}`);
  return (await res.json()) as SettlementPage;
}

export async function getSettlement(digest: string): Promise<SettlementRow> {
  const res = await fetch(`${base().replace(/\/+$/, "")}/v1/settlements/${digest}`);
  if (!res.ok) throw new Error(`getSettlement ${res.status}`);
  return (await res.json()) as SettlementRow;
}

/** The full transcript, via the api's Walrus proxy (same-origin). */
export async function getTranscript(digest: string): Promise<ProofRecord> {
  const res = await fetch(`${base().replace(/\/+$/, "")}/v1/settlements/${digest}/transcript`);
  if (!res.ok) throw new Error(`getTranscript ${res.status}`);
  return (await res.json()) as ProofRecord;
}

/** Live new-settlement feed (SSE). Returns an unsubscribe fn. */
export function openExplorerStream(onRow: (row: SettlementRow) => void): () => void {
  const src = new EventSource(`${base().replace(/\/+$/, "")}/v1/explorer/stream`);
  src.onmessage = (ev) => {
    try {
      onRow(JSON.parse(ev.data) as SettlementRow);
    } catch {
      /* ignore malformed frame */
    }
  };
  return () => src.close();
}
