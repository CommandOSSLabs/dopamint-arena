import { test, expect } from "bun:test";
import { PLAYABLE, isPlayable, kitFor, gameStake } from "./games";
import { makeSeats, playMatch } from "./match";
import { pairLocalChannel } from "./channels/localChannel";

test("the 6 real games are playable; removed/unknown ones are not", () => {
  expect([...PLAYABLE].sort()).toEqual(
    ["ticTacToe", "blackjack", "battleship", "quantumPoker", "bombIt", "cross"].sort(),
  );
  expect(isPlayable("blackjack")).toBe(true);
  expect(isPlayable("battleship")).toBe(true);
  expect(isPlayable("payments")).toBe(false);
  expect(isPlayable("chat")).toBe(false);
  expect(isPlayable("slots")).toBe(false);
});

test("kitFor returns the canonical kit; gameStake returns its defaultStake", () => {
  const kit = kitFor("blackjack");
  expect(kit.id).toBe("blackjack");
  expect(gameStake("blackjack")).toBe(kit.defaultStake);
});

test("kitFor throws for an unplayable game", () => {
  expect(() => kitFor("payments")).toThrow(/no kit/);
});

test("every PLAYABLE game has a kit (PLAYABLE and the kit map stay in sync)", () => {
  for (const game of PLAYABLE) {
    expect(isPlayable(game)).toBe(true);
    expect(() => kitFor(game)).not.toThrow();
  }
});

test.each([...PLAYABLE])("%s plays to a settlement over the local channel", async (game) => {
  const stake = gameStake(game);
  const seats = makeSeats(`t-${game}`, { a: stake, b: stake }, 100n);
  const res = await playMatch(kitFor(game), seats, pairLocalChannel(), { seed: 3, maxMoves: 500 });
  const s = res.settlement.settlement;
  expect(s.partyABalance + s.partyBBalance).toBe(stake * 2n);
});
