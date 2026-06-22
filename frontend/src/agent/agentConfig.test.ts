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

test("rotation set is tic-tac-toe only until the move-trigger fix", () => {
  assert.deepEqual(
    AGENT_GAMES.map((g) => g.id),
    ["tictactoe"],
  );
});

test("parses ?arena with a key and leaves ?agent off", () => {
  const c = parseAgentConfig("http://x/?arena&key=suiprivkey1abc");
  assert.strictEqual(c.arena, true);
  assert.strictEqual(c.enabled, false); // not agent mode
  assert.strictEqual(c.secretKey, "suiprivkey1abc");
});

test("arena defaults false with no param", () => {
  assert.strictEqual(parseAgentConfig("http://x/").arena, false);
});
