import { test } from "node:test";
import assert from "node:assert/strict";
import type { StatsSnapshot } from "./controlPlane";

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
