import { test } from "node:test";
import assert from "node:assert/strict";
import { toHex } from "@mysten/sui/utils";

import { enterArena, allocateArenaBots } from "./arenaEnter.ts";
import type { TunnelOpenRequest } from "./tunnelOpenBatcher.ts";

const BOT_EPH = "aa".repeat(32); // 32-byte ephemeral pubkey, hex
const BOT_ADDR = "0xbot";

interface Captured {
  allocate?: {
    userAddress: string;
    games: { id: string; userEphPubkey: string }[];
  };
  opened?: { allocations: { matchId: string; tunnelId: string }[] };
}

/** A fetch that routes the two arena endpoints, recording each request body. Allocate returns ONE bot
 *  per requested game (distinct match/tunnel per index), so N same-game requests → N bots — the fleet's
 *  per-request behavior the FE now relies on. */
function fakeFetch(captured: Captured): typeof fetch {
  return (async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (String(url).endsWith("/v1/arena/allocate")) {
      captured.allocate = body;
      const allocations = body.games.map((g: { id: string }, i: number) => ({
        game: g.id,
        matchId: `m${i + 1}`,
        tunnelId: `0xtunnel${i + 1}`,
        botEphPubkey: BOT_EPH,
        botAddress: BOT_ADDR,
        stakeEach: 100,
      }));
      return { ok: true, json: async () => ({ allocations }) };
    }
    if (String(url).endsWith("/v1/arena/opened")) {
      captured.opened = body;
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
}

test("allocateArenaBots posts {userAddress, games:[{id,userEphPubkey}]} and returns allocations with tunnelId", async () => {
  const captured: Captured = {};
  const allocs = await allocateArenaBots(
    [{ id: "blackjack", userEphPubkey: "ab12" }],
    "0xuser",
    { apiBase: "", fetchFn: fakeFetch(captured) },
  );
  assert.deepEqual(captured.allocate, {
    userAddress: "0xuser",
    games: [{ id: "blackjack", userEphPubkey: "ab12" }],
  });
  assert.equal(allocs.length, 1);
  assert.equal(allocs[0].tunnelId, "0xtunnel1", "the pre-opened tunnel");
  assert.equal(allocs[0].botAddress, BOT_ADDR);
  assert.equal(allocs[0].botEphPubkey, BOT_EPH);
});

test("enterArena mints an eph key, deposits seat A into the pre-opened tunnel, reports joined, returns {allocation,keypair}", async () => {
  const captured: Captured = {};
  const opens: TunnelOpenRequest[] = [];

  const matches = await enterArena({
    games: ["blackjack"],
    userAddress: "0xuser",
    apiBase: "",
    fetchFn: fakeFetch(captured),
    open: async (req) => {
      opens.push(req);
      return req.tunnelId!; // a deposit resolves with the tunnel it funded
    },
  });

  // A generated per-request eph pubkey reaches allocate (the fleet bakes it into the tunnel at create).
  assert.equal(captured.allocate?.games.length, 1);
  assert.equal(captured.allocate?.games[0].id, "blackjack");
  assert.match(captured.allocate!.games[0].userEphPubkey, /^[0-9a-f]{64}$/);

  // Exactly one DEPOSIT (not an open) into the fleet-pre-opened tunnel, seat-A stake, party B = bot.
  assert.equal(opens.length, 1);
  assert.equal(opens[0].mode, "deposit");
  assert.equal(opens[0].tunnelId, "0xtunnel1");
  assert.equal(opens[0].aAmount, 100n); // from allocation.stakeEach
  assert.equal(opens[0].partyB.address, BOT_ADDR);

  // The returned keypair is EXACTLY the one baked into the tunnel: its pubkey == party A's == allocate's.
  assert.equal(matches.length, 1);
  assert.equal(matches[0].allocation.tunnelId, "0xtunnel1");
  assert.equal(
    toHex(matches[0].keypair.publicKey),
    captured.allocate!.games[0].userEphPubkey,
  );
  assert.deepEqual(opens[0].partyA.publicKey, matches[0].keypair.publicKey);

  assert.deepEqual(captured.opened, {
    allocations: [{ matchId: "m1", tunnelId: "0xtunnel1" }],
  });
});

test("enterArena gives N windows of the SAME game distinct bots, each paired with its own key in order", async () => {
  const captured: Captured = {};
  const opens: TunnelOpenRequest[] = [];

  const matches = await enterArena({
    games: ["caro", "caro", "caro"], // 3 caro windows
    userAddress: "0xuser",
    apiBase: "",
    fetchFn: fakeFetch(captured),
    open: async (req) => {
      opens.push(req);
      return req.tunnelId!;
    },
  });

  // 3 distinct allocate requests, each with its OWN ephemeral key.
  const pubkeys = captured.allocate!.games.map((g) => g.userEphPubkey);
  assert.equal(pubkeys.length, 3);
  assert.equal(new Set(pubkeys).size, 3, "3 distinct ephemeral keys");

  // 3 deposits into 3 distinct tunnels.
  assert.deepEqual(
    opens.map((o) => o.tunnelId),
    ["0xtunnel1", "0xtunnel2", "0xtunnel3"],
  );

  // 3 matches; each keypair is EXACTLY its tunnel's baked-in (allocate-request) key, paired in order.
  assert.equal(matches.length, 3);
  matches.forEach((m, i) => {
    assert.equal(m.allocation.tunnelId, `0xtunnel${i + 1}`);
    assert.equal(
      toHex(m.keypair.publicKey),
      pubkeys[i],
      `match ${i} paired with request ${i}'s key`,
    );
  });
});

test("enterArena pairs by echoed userEphPubkey — robust to out-of-order serving + a mid-batch omission", async () => {
  const captured: Captured = {};
  const opens: TunnelOpenRequest[] = [];

  // A backend that ECHOES userEphPubkey but serves the SAME game's requests out of order and drops the
  // middle one — the exact case order-within-game pairing mishandles. Position-based pairing would hand
  // the surviving second allocation request-1's key (wrong tunnel); pubkey pairing must not.
  const echoingReorderingFetch: typeof fetch = (async (
    url: string,
    init?: { body?: string },
  ) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (String(url).endsWith("/v1/arena/allocate")) {
      captured.allocate = body;
      const g = body.games as { id: string; userEphPubkey: string }[];
      // Serve requests #2 and #0 (reversed, #1 omitted), each echoing its own pubkey + a tunnel keyed
      // to that pubkey so we can prove the deposit landed in the right tunnel for the right key.
      const allocations = [g[2], g[0]].map((req) => ({
        game: req.id,
        matchId: `m-${req.userEphPubkey.slice(0, 6)}`,
        tunnelId: `0xt-${req.userEphPubkey.slice(0, 6)}`,
        botEphPubkey: BOT_EPH,
        botAddress: BOT_ADDR,
        userEphPubkey: req.userEphPubkey,
        stakeEach: 100,
      }));
      return { ok: true, json: async () => ({ allocations }) };
    }
    if (String(url).endsWith("/v1/arena/opened")) {
      captured.opened = body;
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;

  const matches = await enterArena({
    games: ["caro", "caro", "caro"],
    userAddress: "0xuser",
    apiBase: "",
    fetchFn: echoingReorderingFetch,
    open: async (req) => {
      opens.push(req);
      return req.tunnelId!;
    },
  });

  // Only the two served requests come back — the omitted one is simply absent.
  assert.equal(matches.length, 2);
  for (const m of matches) {
    // Each bundled key is the one for THIS allocation's echoed pubkey — paired by identity, not position.
    assert.equal(toHex(m.keypair.publicKey), m.allocation.userEphPubkey);
    // …and the deposit for that allocation's tunnel used that same key (right key → right tunnel).
    const deposit = opens.find((o) => o.tunnelId === m.allocation.tunnelId);
    assert.ok(deposit, "a deposit exists for the allocation's tunnel");
    assert.deepEqual(deposit!.partyA.publicKey, m.keypair.publicKey);
  }
});
