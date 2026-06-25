import test from "node:test";
import assert from "node:assert/strict";
import { makeCrossResumeAdapter } from "./crossResumeAdapter.ts";
import { CrossProtocol } from "../../../../sui-tunnel-ts/src/protocol/cross.ts";

test("serializeState round-trips through JSON and restores bigints", () => {
  const proto = new CrossProtocol();
  const s0 = proto.initialState({
    tunnelId: "0xfeed",
    initialBalances: { a: 500n, b: 500n },
  });
  const s1 = proto.applyMove(s0, { dirA: "north" }, "A"); // tick=1n, a real bigint state
  const adapter = makeCrossResumeAdapter();
  const json = JSON.parse(JSON.stringify(adapter.serializeState(s1))); // must be JSON-safe
  const back = adapter.deserializeState(json);
  assert.equal(back.tick, s1.tick);
  assert.equal(back.seed, s1.seed);
  assert.equal(back.balanceA, s1.balanceA);
  assert.equal(back.balanceB, s1.balanceB);
  assert.equal(back.total, s1.total);
  assert.equal(typeof back.tick, "bigint");
  assert.deepEqual(back.players, s1.players);
  assert.equal(back.winner, s1.winner);
});

test("serializeState emits no bigint values (localStorage-safe)", () => {
  const proto = new CrossProtocol();
  const s = proto.initialState({
    tunnelId: "0xabc",
    initialBalances: { a: 500n, b: 500n },
  });
  const j = makeCrossResumeAdapter().serializeState(s) as Record<
    string,
    unknown
  >;
  for (const k of ["tick", "seed", "balanceA", "balanceB", "total"])
    assert.equal(typeof j[k], "string", `${k} must serialize to string`);
});
