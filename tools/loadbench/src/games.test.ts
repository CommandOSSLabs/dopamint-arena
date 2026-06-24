import { test, expect } from "bun:test";
import { PLAYABLE, isPlayable, protocolFor, gameBalances } from "./games";
import { makeSeats, playMatch } from "./match";
import { pairLocalChannel } from "./channels/localChannel";

test("battleship and friends are not playable", () => {
  expect(isPlayable("battleship")).toBe(false);
  expect(isPlayable("blackjack")).toBe(true);
});

test.each([...PLAYABLE])("%s plays to a settlement over the local channel", async (game) => {
  const seats = makeSeats(`t-${game}`, gameBalances(game), 100n);
  const res = await playMatch(protocolFor(game), seats, pairLocalChannel(), { seed: 3, maxMoves: 500 });
  const s = res.settlement.settlement;
  expect(s.partyABalance + s.partyBBalance).toBe(seats.balances.a + seats.balances.b);
});
