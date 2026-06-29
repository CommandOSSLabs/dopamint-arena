import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultAuto, rememberAuto } from "./autoPreference";

// The contract: a player watches a bot on their FIRST match, then their last toggle sticks for the
// next game. These encode WHY the default is ON and WHY it must change once the player opts out —
// not just the Map mechanics. Each test uses a unique game key so the shared module state can't leak
// between them.

test("a game never played defaults to auto ON (first-match attract)", () => {
  assert.equal(defaultAuto("first-time-game"), true);
});

test("after the player turns auto off, new games default OFF (sticky opt-out)", () => {
  rememberAuto("opted-out-game", false);
  assert.equal(defaultAuto("opted-out-game"), false);
});

test("after the player turns auto back on, new games default ON again", () => {
  rememberAuto("toggled-game", false);
  rememberAuto("toggled-game", true);
  assert.equal(defaultAuto("toggled-game"), true);
});

test("one game's choice does not change another game's default", () => {
  rememberAuto("game-a", false);
  assert.equal(defaultAuto("game-b"), true);
});
