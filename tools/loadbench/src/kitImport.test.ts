import { test, expect } from "bun:test";
import { GAME_KITS } from "../../../frontend/src/agent/gameKit";

test("all game kits import under bun with no browser coupling", () => {
  const ids = Object.keys(GAME_KITS).sort();
  expect(ids).toEqual(
    ["blackjack", "bomb-it", "battleship", "chicken-cross", "quantum-poker", "tictactoe", "world-canvas"].sort(),
  );
  for (const id of ids) {
    const kit = (GAME_KITS as Record<string, { protocol: unknown; defaultStake: bigint; createBot: unknown }>)[id];
    expect(typeof kit.protocol).toBe("object");
    expect(typeof kit.createBot).toBe("function");
    expect(typeof kit.defaultStake).toBe("bigint");
  }
});
