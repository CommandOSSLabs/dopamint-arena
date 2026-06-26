import { test, expect } from "bun:test";
import { parseAblationArgs } from "./ablationRun";

test("parseAblationArgs defaults to blackjack + 5 trials", () => {
  const a = parseAblationArgs(["--ablation"]);
  expect(a.game).toBe("blackjack");
  expect(a.trials).toBe(5);
});

test("parseAblationArgs reads --game and --trials", () => {
  const a = parseAblationArgs(["--ablation", "--game", "blackjack", "--trials", "9"]);
  expect(a.game).toBe("blackjack");
  expect(a.trials).toBe(9);
});

test("parseAblationArgs rejects an unplayable game", () => {
  expect(() => parseAblationArgs(["--ablation", "--game", "nope"])).toThrow();
});
