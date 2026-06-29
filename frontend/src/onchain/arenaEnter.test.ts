import { test } from "node:test";
import assert from "node:assert/strict";
import { toHex } from "@mysten/sui/utils";

import { enterArena, allocateArenaBots } from "./arenaEnter.ts";
import type { TunnelOpenRequest } from "./tunnelOpenBatcher.ts";

const BOT_EPH = "aa".repeat(32); // 32-byte ephemeral pubkey, hex
const BOT_ADDR = "0xbot";

/** A fetch that routes the two arena endpoints, recording each request body. */
function fakeFetch(captured: {
  allocate?: unknown;
  opened?: unknown;
}): typeof fetch {
  return (async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (String(url).endsWith("/v1/arena/allocate")) {
      captured.allocate = body;
      return {
        ok: true,
        json: async () => ({
          allocations: [
            {
              game: "blackjack",
              matchId: "m1",
              botEphPubkey: BOT_EPH,
              botAddress: BOT_ADDR,
            },
          ],
        }),
      };
    }
    if (String(url).endsWith("/v1/arena/opened")) {
      captured.opened = body;
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
}

test("allocateArenaBots posts {userAddress, games} and returns allocations", async () => {
  const captured: { allocate?: unknown } = {};
  const allocs = await allocateArenaBots(["blackjack"], "0xuser", {
    apiBase: "",
    fetchFn: fakeFetch(captured),
  });
  assert.deepEqual(captured.allocate, {
    userAddress: "0xuser",
    games: ["blackjack"],
  });
  assert.equal(allocs.length, 1);
  assert.equal(allocs[0].botAddress, BOT_ADDR);
  assert.equal(allocs[0].botEphPubkey, BOT_EPH);
});

test("enterArena opens seat-A per allocation and reports opened tunnels", async () => {
  const captured: { opened?: unknown } = {};
  const opens: TunnelOpenRequest[] = [];

  const opened = await enterArena({
    games: ["blackjack"],
    userAddress: "0xuser",
    stakePerGame: 100n,
    apiBase: "",
    fetchFn: fakeFetch(captured),
    makeUserParty: async () => ({
      address: "0xuser",
      publicKey: new Uint8Array(32),
    }),
    open: async (req) => {
      opens.push(req);
      return "0xtunnel1";
    },
  });

  // Exactly one open, seat-A funded, party B carries BOTH bot keys, seat B unfunded by the user.
  assert.equal(opens.length, 1);
  assert.equal(opens[0].fundMode, "seatA");
  assert.equal(opens[0].aAmount, 100n);
  assert.equal(opens[0].bAmount, 0n);
  assert.equal(opens[0].partyB.address, BOT_ADDR);
  assert.equal(
    toHex(opens[0].partyB.publicKey),
    BOT_EPH,
    "party B's pk is the bot's ephemeral pubkey",
  );

  // The opened tunnel is reported so the bot deposits seat B.
  assert.deepEqual(captured.opened, {
    allocations: [{ matchId: "m1", tunnelId: "0xtunnel1" }],
  });

  // Returns the per-game mapping the caller hands to each game.
  assert.deepEqual(opened, [
    { game: "blackjack", matchId: "m1", tunnelId: "0xtunnel1" },
  ]);
});
