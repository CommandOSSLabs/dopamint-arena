import { test } from "node:test";
import assert from "node:assert/strict";
import type { StatsSnapshot } from "./controlPlane";
import { createControlPlaneClient } from "./controlPlane";
import type { SettleRequestBody } from "./controlPlane";

// The backend now emits `recentEvents` (camelCase, u64 as JSON number, Option → nullable)
// on the stats snapshot. A frame WITHOUT it must still parse (older backend / no events).
test("StatsSnapshot carries optional recentEvents", () => {
  const withEvents: StatsSnapshot = {
    tps: 5,
    totalActions: 10,
    activeTunnels: 2,
    settledTunnels: 1,
    perGame: {},
    recentEvents: [
      {
        tunnelId: "0xabc",
        kind: "settled",
        partyABalance: 1500,
        partyBBalance: 500,
        transcriptRoot: "deadbeef",
        txDigest: "DiG",
        timestampMs: 1_750_000_000_000,
        proofUrl: "https://agg/v1/blobs/abc",
      },
    ],
  };
  assert.equal(withEvents.recentEvents?.[0].kind, "settled");

  const without: StatsSnapshot = {
    tps: 0,
    totalActions: 0,
    activeTunnels: 0,
    settledTunnels: 0,
    perGame: {},
  };
  assert.equal(without.recentEvents, undefined);
});

// ADR-0007: settle posts to the TUNNEL resource with NO Authorization — the co-signed settlement
// is the authorization, not a bearer token. This pins the path + the absence of the header so a
// regression can't silently re-introduce the session gate.
test("settle posts to the tunnel settle path with no auth and returns the proof", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        txDigest: "DiG",
        walrusBlobId: "blob1",
        proofUrl: "https://agg/v1/blobs/blob1",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const cp = createControlPlaneClient("https://backend.example");
    const body: SettleRequestBody = {
      settlement: {
        tunnelId: "0x1",
        partyABalance: "1500",
        partyBBalance: "500",
        finalNonce: "1",
        timestamp: "1750000000000",
        transcriptRoot: "deadbeef",
      },
      sigA: "aa",
      sigB: "bb",
      transcript: [],
    };
    const res = await cp.settle("0x1", body);
    assert.equal(res.txDigest, "DiG");
    assert.equal(res.walrusBlobId, "blob1");
    assert.equal(res.proofUrl, "https://agg/v1/blobs/blob1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://backend.example/v1/tunnels/0x1/settle");
    assert.equal(String(calls[0].init.method).toUpperCase(), "POST");
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), body);
  } finally {
    globalThis.fetch = orig;
  }
});
