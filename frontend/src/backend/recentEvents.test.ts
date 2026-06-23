import { test } from "node:test";
import assert from "node:assert/strict";
import { recentEventsToTxnRows } from "./recentEvents";
import type { TunnelEvent } from "./controlPlane";

const settled: TunnelEvent = {
  tunnelId: "0xabcdef0123456789",
  kind: "settled",
  partyABalance: 1_500_000_000, // 1.5 SUI in MIST
  partyBBalance: 500_000_000, //   0.5 SUI in MIST
  transcriptRoot: "deadbeef",
  txDigest: "DiGeSt",
  timestampMs: 1_750_000_000_000,
  proofUrl: "https://agg/v1/blobs/abc",
};

test("maps a settled event to an honest on-chain TxnRow", () => {
  const [row] = recentEventsToTxnRows([settled]);
  assert.equal(row.digest, "DiGeSt");
  assert.equal(row.proofUrl, "https://agg/v1/blobs/abc");
  assert.equal(row.game, "");
  assert.equal(row.type, "Settled");
  assert.equal(row.status, "Success");
  assert.equal(row.amount, "2 SUI"); // total pot (1.5 + 0.5), NOT a fabricated win
});

test("opened event has no payout amount", () => {
  const opened: TunnelEvent = {
    ...settled,
    kind: "opened",
    partyABalance: null,
    partyBBalance: null,
  };
  const [row] = recentEventsToTxnRows([opened]);
  assert.equal(row.type, "Opened");
  assert.equal(row.amount, "—");
});

test("stable id per digest", () => {
  const [a] = recentEventsToTxnRows([settled]);
  const [b] = recentEventsToTxnRows([settled]);
  assert.equal(a.id, b.id);
});
