import test from "node:test";
import assert from "node:assert/strict";
import { makeBombItResumeAdapter } from "./bombItResumeAdapter.ts";
import {
  BombItProtocol,
  CELL_COUNT,
} from "../../../../sui-tunnel-ts/src/protocol/bombIt.ts";
import {
  stringifyWithBigint,
  parseWithBigint,
} from "../../pvp/resume.ts";

test("serializeState round-trips through JSON: bigints + grid Uint8Array", () => {
  const proto = new BombItProtocol();
  const s0 = proto.initialState({
    tunnelId: "0xfeed",
    initialBalances: { a: 100n, b: 100n },
  });
  const s1 = proto.applyMove(s0, { a: "bomb" }, "A"); // tick=1n + a live bomb
  const adapter = makeBombItResumeAdapter();
  // Use the codec that the persist layer uses (not plain JSON — bigints are native now).
  const revived = parseWithBigint(stringifyWithBigint(adapter.serializeState(s1)));
  const back = adapter.deserializeState(revived);
  assert.equal(back.tick, s1.tick);
  assert.equal(back.seed, s1.seed);
  assert.equal(back.balanceA, s1.balanceA);
  assert.equal(back.total, s1.total);
  assert.equal(typeof back.tick, "bigint");
  assert.ok(back.grid instanceof Uint8Array);
  assert.equal(back.grid.length, CELL_COUNT);
  assert.deepEqual(Array.from(back.grid), Array.from(s1.grid));
  assert.deepEqual(back.players, s1.players);
  assert.deepEqual(back.bombs, s1.bombs);
  assert.equal(back.winner, s1.winner);
});

test("bigint fields survive a stringifyWithBigint/parseWithBigint round-trip", () => {
  const proto = new BombItProtocol();
  const s = proto.initialState({
    tunnelId: "0xabc",
    initialBalances: { a: 100n, b: 100n },
  });
  const adapter = makeBombItResumeAdapter();
  const serialized = adapter.serializeState(s);
  const revived = parseWithBigint(stringifyWithBigint(serialized)) as typeof serialized;
  const back = adapter.deserializeState(revived);
  assert.equal(back.tick, s.tick);
  assert.equal(back.seed, s.seed);
  assert.equal(back.balanceA, s.balanceA);
  assert.equal(back.balanceB, s.balanceB);
  assert.equal(back.total, s.total);
  assert.equal(typeof back.tick, "bigint");
  assert.equal(typeof back.balanceA, "bigint");
});
