import { test, expect } from "bun:test";
import { parseSwarmArgs, runSwarm } from "./swarm";

test("parseSwarmArgs reads channel, anchor, concurrency, both stop conditions, games", () => {
  const a = parseSwarmArgs([
    "--channel", "local",
    "--offchain",
    "--concurrency", "8",
    "--matches", "100",
    "--duration", "30",
    "--games", "blackjack,chat",
  ]);
  expect(a).toEqual({
    channel: "local",
    anchor: "offchain",
    concurrency: 8,
    matches: 100,
    durationS: 30,
    games: ["blackjack", "chat"],
  });
});

test("parseSwarmArgs defaults to the onchain anchor", () => {
  expect(parseSwarmArgs([]).anchor).toBe("onchain");
});

test("runSwarm stops at the matches cap", async () => {
  const res = await runSwarm(async () => ({ moves: 5 }), {
    concurrency: 4,
    matches: 20,
    durationMs: null,
    now: () => 0,
  });
  expect(res.matches).toBe(20);
  expect(res.moves).toBe(100);
});

test("runSwarm stops when duration elapses", async () => {
  let t = 0;
  const res = await runSwarm(async () => { t += 10; return { moves: 1 }; }, {
    concurrency: 1,
    matches: null,
    durationMs: 50,
    now: () => t,
  });
  expect(res.elapsedMs).toBeGreaterThanOrEqual(50);
});
