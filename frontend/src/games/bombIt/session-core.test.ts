import { test } from "node:test";
import assert from "node:assert/strict";
// Runtime SDK imports use RELATIVE .ts paths (tsx ignores the vite alias / tsconfig paths).
import { BombItProtocol, BOMB_IT_MIN_STAKE } from "../../../../sui-tunnel-ts/src/protocol/bombIt.ts";
import { deriveView, sessionResult } from "./session-core.ts";

const CTX = { tunnelId: "0xfeed", initialBalances: { a: BOMB_IT_MIN_STAKE, b: BOMB_IT_MIN_STAKE } };

test("deriveView flattens grid, players, bombs, and balances to plain values", () => {
  const p = new BombItProtocol();
  const v = deriveView(p.initialState(CTX));
  assert.equal(v.grid.length, 81);
  assert.equal(v.players.length, 2);
  assert.equal(typeof v.balanceA, "number");
  assert.equal(v.bombs.length, 0);
  assert.equal(v.winner, null);
});

test("sessionResult reports the winning seat (and draws as draw)", () => {
  const p = new BombItProtocol();
  const s = p.initialState(CTX);
  assert.equal(sessionResult({ ...s, winner: "A" }), "A");
  assert.equal(sessionResult({ ...s, winner: "draw" }), "draw");
});
