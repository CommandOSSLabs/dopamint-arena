// Locks the wire `forfeit()` sends: forced (0, total) balances, finalNonce 1. Full session
// orchestration (send frame, await bot's settleHalf, combine, submit) is covered by the
// integration gate — this only pins the forfeit-half the hook builds from `@/pvp/forfeit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";
import { buildForfeitHalf } from "@/pvp/forfeit";

test("forfeit half zeroes the human and gives the bot the pot", () => {
  const eph = generateKeyPair();
  const { settlement } = buildForfeitHalf({
    tunnelId: "0x" + "00".repeat(31) + "01",
    total: 2n,
    wallet: "0x" + "ab".repeat(32),
    eph,
    timestamp: 1n,
    transcriptRoot: new Uint8Array(32),
  });
  assert.equal(settlement.partyABalance, 0n);
  assert.equal(settlement.partyBBalance, 2n);
});
