import test from "node:test";
import assert from "node:assert/strict";
import { makeCrossResumeAdapter } from "./crossResumeAdapter.ts";
import { CrossProtocol } from "../../../../sui-tunnel-ts/src/protocol/cross.ts";
import { stringifyWithBigint, parseWithBigint } from "../../pvp/resume.ts";

test("serializeState round-trips through JSON and restores bigints", () => {
  const proto = new CrossProtocol();
  const s0 = proto.initialState({
    tunnelId: "0xfeed",
    initialBalances: { a: 500n, b: 500n },
  });
  const s1 = proto.applyMove(s0, { dirA: "north" }, "A"); // tick=1n, a real bigint state
  const adapter = makeCrossResumeAdapter();
  // Use the codec that the persist layer uses (not plain JSON — bigints are native now).
  const back = adapter.deserializeState(
    parseWithBigint(stringifyWithBigint(adapter.serializeState(s1))),
  );
  assert.equal(back.tick, s1.tick);
  assert.equal(back.seed, s1.seed);
  assert.equal(back.balanceA, s1.balanceA);
  assert.equal(back.balanceB, s1.balanceB);
  assert.equal(back.total, s1.total);
  assert.equal(typeof back.tick, "bigint");
  assert.deepEqual(back.players, s1.players);
  assert.equal(back.winner, s1.winner);
});

test("bigint fields survive a peer round-trip (stringifyWithBigint/parseWithBigint)", () => {
  const proto = new CrossProtocol();
  const s = proto.initialState({
    tunnelId: "0xabc",
    initialBalances: { a: 500n, b: 500n },
  });
  const adapter = makeCrossResumeAdapter();
  const serialized = adapter.serializeState(s);
  const revived = parseWithBigint(
    stringifyWithBigint(serialized),
  ) as typeof serialized;
  const back = adapter.deserializeState(revived);
  assert.equal(back.tick, s.tick);
  assert.equal(back.seed, s.seed);
  assert.equal(back.balanceA, s.balanceA);
  assert.equal(back.balanceB, s.balanceB);
  assert.equal(back.total, s.total);
  assert.equal(typeof back.tick, "bigint");
  assert.equal(typeof back.balanceA, "bigint");
});
