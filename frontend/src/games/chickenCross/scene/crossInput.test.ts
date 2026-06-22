import { test } from "node:test";
import assert from "node:assert/strict";
import { keyToScreenDir, swipeToScreenDir } from "./crossInput.ts";

test("arrow + WASD keys map to screen directions", () => {
  assert.equal(keyToScreenDir("ArrowUp"), "north");
  assert.equal(keyToScreenDir("KeyW"), "north");
  assert.equal(keyToScreenDir("ArrowDown"), "south");
  assert.equal(keyToScreenDir("KeyS"), "south");
  assert.equal(keyToScreenDir("ArrowLeft"), "west");
  assert.equal(keyToScreenDir("KeyA"), "west");
  assert.equal(keyToScreenDir("ArrowRight"), "east");
  assert.equal(keyToScreenDir("KeyD"), "east");
  assert.equal(keyToScreenDir("Space"), null);
});

test("swipe resolves dominant axis past the threshold", () => {
  assert.equal(swipeToScreenDir(40, 5), "east");
  assert.equal(swipeToScreenDir(-40, 5), "west");
  assert.equal(swipeToScreenDir(5, 40), "south");
  assert.equal(swipeToScreenDir(5, -40), "north");
});

test("swipe below threshold is ignored", () => {
  assert.equal(swipeToScreenDir(10, 10), null);
});
