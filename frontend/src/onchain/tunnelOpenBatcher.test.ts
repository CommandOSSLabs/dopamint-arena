import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PACKAGE_ID = "0x2";
process.env.SUI_NETWORK = "testnet";
// Force the SUI funding mode (no MTPS env) so the batcher's group key is deterministic in tests.
delete process.env.VITE_MTPS_PACKAGE_ID;
delete process.env.VITE_MTPS_COIN_TYPE;

import {
  TunnelOpenBatcher,
  type BatcherDeps,
  type TunnelOpenRequest,
} from "./tunnelOpenBatcher.ts";
import { normalizeSuiAddress } from "./tunnelTx.ts";

const party = (address: string) => ({ address, publicKey: new Uint8Array(32) });
// A fixed valid 32-byte Sui address for partyB; tests only correlate by partyA so sharing is fine.
const PARTY_B_ADDR = "0x000000000000000000000000000000000000000000000000000000000000bb00";
const req = (a: string): TunnelOpenRequest => ({
  partyA: party(a),
  partyB: party(PARTY_B_ADDR),
  aAmount: 500n,
  bAmount: 500n,
});

/**
 * Minimal fake deps for batcher unit tests. The default `getTransactionBlock` returns an empty
 * objectChanges list; tests that need tunnel correlation override it directly. `getObject` echoes
 * `input.id` back as `party_a.address` so deterministic overrides can key tunnels by id.
 */
function fakeDeps(opts: { onSign: () => void; failOpens?: number }): BatcherDeps {
  let opensSoFar = 0;
  return {
    reads: {
      waitForTransaction: async () => {},
      getTransactionBlock: async () => ({ objectChanges: [] }),
      getObject: async (input: { id: string }) => ({
        data: {
          content: {
            fields: {
              party_a: { fields: { address: input.id } },
            },
          },
        },
      }),
    } as unknown as BatcherDeps["reads"],
    sponsoredSignExec: async (_tx) => {
      opensSoFar += 1;
      opts.onSign();
      if (opts.failOpens && opensSoFar <= opts.failOpens) {
        throw new Error("sponsor 422 (test)");
      }
      return { digest: "0xd" + opensSoFar };
    },
    signExec: async () => ({ digest: "0xwallet" }),
    ensureStakeBalance: async () => {},
    prepareStake: async () => "0xcoin",
    selectStakeCoin: async () => "0xcoin",
  } as unknown as BatcherDeps;
}

test("coalesces concurrent requests into ONE signed PTB", async () => {
  let signs = 0;
  const deps = fakeDeps({ onSign: () => (signs += 1) });
  // make reads echo the three party-As as created tunnels
  (deps.reads as any).getTransactionBlock = async () => ({
    objectChanges: ["0xA", "0xB", "0xC"].map((a) => ({
      type: "created",
      objectType: "0xpkg::tunnel::Tunnel<0x2::sui::SUI>",
      objectId: "tunnel-for-" + a,
    })),
  });
  (deps.reads as any).getObject = async (i: { id: string }) => ({
    data: {
      content: {
        fields: {
          party_a: { fields: { address: i.id.replace("tunnel-for-", "") } },
        },
      },
    },
  });

  const batcher = new TunnelOpenBatcher(() => deps, { flushDelayMs: 0, maxBatch: 16 });
  const [a, b, c] = await Promise.all([
    batcher.request(req("0xA")),
    batcher.request(req("0xB")),
    batcher.request(req("0xC")),
  ]);
  assert.equal(signs, 1, "three requests → one sponsor call");
  // Tunnel ids come from getTransactionBlock; normalization is in openAndFundMany, not the batcher.
  // The id returned is the raw objectId, not the normalized party-A address.
  assert.ok(typeof a === "string" && a.length > 0, "a resolved to a non-empty string");
  assert.ok(typeof b === "string" && b.length > 0, "b resolved to a non-empty string");
  assert.ok(typeof c === "string" && c.length > 0, "c resolved to a non-empty string");
  // Spot-check correlation: each request gets the tunnel keyed to its party-A
  assert.equal(a, "tunnel-for-0xA");
  assert.equal(b, "tunnel-for-0xB");
  assert.equal(c, "tunnel-for-0xC");
});

test("chunks a batch larger than maxBatch into ceil(N/maxBatch) signed PTBs", async () => {
  let signs = 0;
  const deps = fakeDeps({ onSign: () => (signs += 1) });
  (deps.reads as any).getObject = async (i: { id: string }) => ({
    data: { content: { fields: { party_a: { fields: { address: i.id } } } } },
  });
  // Default getTransactionBlock returns [] → openAndFundMany throws count mismatch → per-request
  // fallback fires (signs per chunk: 1 batch PTB + N single-open PTBs via withSponsorFallback).
  // With 5 requests at maxBatch 2 → 3 chunks (sizes 2/2/1) → 3 batch calls + 5 single-open
  // calls = 8 total sponsoredSignExec calls. An unchunked single-PTB run would yield 1 + 5 = 6
  // and must fail this test, proving chunking actually occurred.
  const batcher = new TunnelOpenBatcher(() => deps, { flushDelayMs: 0, maxBatch: 2 });
  const reqs = ["0x1", "0x2", "0x3", "0x4", "0x5"].map((a) => batcher.request(req(a)));
  await Promise.allSettled(reqs);
  // 3 batch PTBs (2+2+1) + 5 single-open fallbacks = 8; unchunked (1 batch + 5 singles) = 6.
  assert.equal(signs, 8, "5 requests at maxBatch 2 → 3 batch PTBs + 5 fallback opens = 8 signs");
});

test("falls back to single opens when a chunk's batched PTB fails", async () => {
  // The batch open fails completely (both the sponsored path and the senderPays path throw) so
  // flushChunk's catch block fires and drives per-request single opens. The second sponsored call
  // (in openSingle's withSponsorFallback) succeeds, resolving the request.
  let signs = 0;
  const deps = fakeDeps({ onSign: () => (signs += 1), failOpens: 1 });
  // Make the batch senderPays path fail too so openChunk throws entirely, triggering the batcher-
  // level fallback (not just the sponsor-level fallback inside withSponsorFallback).
  (deps as any).signExec = async () => {
    throw new Error("wallet rejected (test)");
  };
  (deps.reads as any).getTransactionBlock = async () => ({
    objectChanges: [
      {
        type: "created",
        objectType: "0xpkg::tunnel::Tunnel<0x2::sui::SUI>",
        objectId: "tunnel-for-0xA",
      },
    ],
  });
  (deps.reads as any).getObject = async () => ({
    data: { content: { fields: { party_a: { fields: { address: "0xA" } } } } },
  });
  const batcher = new TunnelOpenBatcher(() => deps, { flushDelayMs: 0, maxBatch: 16 });
  const id = await batcher.request(req("0xA"));
  assert.ok(typeof id === "string" && id.length > 0, "request still resolves via fallback");
  assert.ok(signs >= 2, "one failed batch + at least one fallback open");
});

test("rejects all pending when no wallet deps are available", async () => {
  const batcher = new TunnelOpenBatcher(() => null, { flushDelayMs: 0 });
  await assert.rejects(() => batcher.request(req("0xA")), /no wallet/i);
});

test("requests arriving within the debounce window share one flush", async () => {
  let signs = 0;
  const deps = fakeDeps({ onSign: () => (signs += 1) });
  (deps.reads as any).getTransactionBlock = async () => ({
    objectChanges: ["0xA", "0xB"].map((a) => ({
      type: "created",
      objectType: "0xpkg::tunnel::Tunnel<0x2::sui::SUI>",
      objectId: "tunnel-for-" + a,
    })),
  });
  (deps.reads as any).getObject = async (i: { id: string }) => ({
    data: { content: { fields: { party_a: { fields: { address: i.id.replace("tunnel-for-", "") } } } } },
  });
  const batcher = new TunnelOpenBatcher(() => deps, { flushDelayMs: 20, maxBatch: 16 });
  const p1 = batcher.request(req("0xA"));
  // second request 5ms later — still inside the 20ms debounce → same flush
  await new Promise((r) => setTimeout(r, 5));
  const p2 = batcher.request(req("0xB"));
  await Promise.all([p1, p2]);
  assert.equal(signs, 1, "staggered-but-close requests coalesce into one PTB");
});
