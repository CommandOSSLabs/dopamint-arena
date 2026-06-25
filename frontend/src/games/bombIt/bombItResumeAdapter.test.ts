import test from "node:test";
import assert from "node:assert/strict";
import { makeBombItResumeAdapter } from "./bombItResumeAdapter.ts";
import {
  BombItProtocol,
  CELL_COUNT,
} from "../../../../sui-tunnel-ts/src/protocol/bombIt.ts";

test("serializeState round-trips through JSON: bigints + grid Uint8Array", () => {
  const proto = new BombItProtocol();
  const s0 = proto.initialState({
    tunnelId: "0xfeed",
    initialBalances: { a: 100n, b: 100n },
  });
  const s1 = proto.applyMove(s0, { a: "bomb" }, "A"); // tick=1n + a live bomb
  const adapter = makeBombItResumeAdapter();
  const back = adapter.deserializeState(
    JSON.parse(JSON.stringify(adapter.serializeState(s1))),
  );
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

test("serializeState is JSON-safe (no bigint, grid as number[])", () => {
  const proto = new BombItProtocol();
  const s = proto.initialState({
    tunnelId: "0xabc",
    initialBalances: { a: 100n, b: 100n },
  });
  const j = makeBombItResumeAdapter().serializeState(s) as Record<
    string,
    unknown
  >;
  for (const k of ["tick", "seed", "balanceA", "balanceB", "total"])
    assert.equal(typeof j[k], "string");
  assert.ok(Array.isArray(j.grid));
});
