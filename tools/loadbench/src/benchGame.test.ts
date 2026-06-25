import { test, expect } from "bun:test";
import { parseBenchArgs } from "./benchGame";

test("defaults: relay channel, onchain anchor, 1 match, concurrency 1", () => {
  const a = parseBenchArgs(["blackjack"]);
  expect(a).toEqual({ game: "blackjack", channel: "relay", anchor: "onchain", matches: 1, concurrency: 1, all: false });
});

test("flags override defaults", () => {
  const a = parseBenchArgs(["payments", "--channel", "local", "--matches", "10", "--concurrency", "4"]);
  expect(a.channel).toBe("local");
  expect(a.matches).toBe(10);
  expect(a.concurrency).toBe(4);
});

test("--offchain selects the offchain anchor (no chain)", () => {
  expect(parseBenchArgs(["payments", "--offchain"]).anchor).toBe("offchain");
  expect(parseBenchArgs(["payments", "--tunnel-anchor", "offchain"]).anchor).toBe("offchain");
  // --onchain shorthand is parsed (overrides a prior --offchain), not just the default.
  expect(parseBenchArgs(["payments", "--offchain", "--onchain"]).anchor).toBe("onchain");
});

test("--all sets the all flag", () => {
  expect(parseBenchArgs(["--all"]).all).toBe(true);
});
