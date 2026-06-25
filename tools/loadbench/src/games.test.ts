import { test, expect } from "bun:test";
import { PLAYABLE, isPlayable, kitFor, gameStake } from "./games";

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
