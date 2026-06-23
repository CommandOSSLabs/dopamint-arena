import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentConfig, AGENT_GAMES, nextGameIndex } from "./agentConfig";

test("nextGameIndex round-robins and wraps; single-game stays put", () => {
  assert.equal(nextGameIndex(0, 5), 1);
  assert.equal(nextGameIndex(4, 5), 0);
  assert.equal(nextGameIndex(0, 1), 0);
});

test("off when ?agent absent", () => {
  assert.equal(parseAgentConfig("https://x/?foo=1").enabled, false);
});

test("on for bare ?agent, with key and default concurrency 1", () => {
  const c = parseAgentConfig("https://x/?agent&key=suiprivkey1abc");
  assert.equal(c.enabled, true);
  assert.equal(c.secretKey, "suiprivkey1abc");
  assert.equal(c.concurrency, 1);
});

test("?m sets concurrency (min 1)", () => {
  assert.equal(parseAgentConfig("https://x/?agent&m=20").concurrency, 20);
  assert.equal(parseAgentConfig("https://x/?agent&m=0").concurrency, 1);
});

test("rotation cycles the move-trigger-ready games: tic-tac-toe, pixel-paint, pixel-duel", () => {
  assert.deepEqual(
    AGENT_GAMES.map((g) => g.id),
    ["tictactoe", "pixel-paint", "pixel-duel"],
  );
});

test("pixel-paint is the turn-free rotation entry; tic-tac-toe stays turn-based", () => {
  const ttt = AGENT_GAMES.find((g) => g.id === "tictactoe");
  const paint = AGENT_GAMES.find((g) => g.id === "pixel-paint");
  assert.equal(ttt?.turnFree, undefined);
  assert.equal(paint?.turnFree, true);
  assert.equal(paint?.behavior, "pixelpaint");
});

test("tic-tac-toe and pixel-paint are NOT commit-reveal (their paths stay unchanged)", () => {
  const ttt = AGENT_GAMES.find((g) => g.id === "tictactoe");
  const paint = AGENT_GAMES.find((g) => g.id === "pixel-paint");
  assert.equal(ttt?.commitReveal, undefined);
  assert.equal(paint?.commitReveal, undefined);
});

test("pixel-duel is the turn-free, commit-reveal rotation entry", () => {
  const duel = AGENT_GAMES.find((g) => g.id === "pixel-duel");
  assert.equal(duel?.turnFree, true);
  assert.equal(duel?.commitReveal, true);
  assert.equal(duel?.stake, 500n);
});
