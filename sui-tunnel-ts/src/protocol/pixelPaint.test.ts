import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PixelPaintProtocol,
  PixelPaintState,
  NUM_COLORS,
  EMPTY,
  OWNER_A,
  OWNER_B,
  MODE_WAR,
  MODE_SCENE,
  MODE_FREE,
} from "./pixelPaint";
import { protocolDomain } from "./Protocol";
import { blake2b256 } from "../core/crypto";
import { concatBytes, toHex } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";

const ctx = { tunnelId: "0xab", initialBalances: { a: 1000n, b: 1000n } };

/** A small board keeps the cap reachable and the canvas easy to reason about. */
function fresh(
  cfg: { width?: number; height?: number; cap?: number; overwriteLimit?: number } = {},
): { proto: PixelPaintProtocol; s: PixelPaintState } {
  const proto = new PixelPaintProtocol({ width: 4, height: 4, cap: 8, ...cfg });
  return { proto, s: proto.initialState(ctx) };
}

test("initial canvas is empty, unowned, and dimensioned from config", () => {
  const { s } = fresh();
  assert.equal(s.width, 4);
  assert.equal(s.canvas.length, 16);
  assert.ok(s.canvas.every((c) => c === EMPTY));
  assert.ok(s.owner.every((o) => o === 0));
  assert.ok(s.paints.every((p) => p === 0));
  assert.equal(s.placed, 0);
  assert.equal(s.ownedA, 0);
  assert.equal(s.ownedB, 0);
  assert.equal(s.locked, 0);
  assert.equal(s.winner, 0);
});

test("either party may place a pixel — there are no turns", () => {
  const { proto, s } = fresh();
  const s1 = proto.applyMove(s, { x: 0, y: 0, color: 1 }, "A");
  const s2 = proto.applyMove(s1, { x: 1, y: 0, color: 2 }, "B");
  assert.equal(s2.canvas[0], 1);
  assert.equal(s2.canvas[1], 2);
  assert.equal(s2.ownedA, 1);
  assert.equal(s2.ownedB, 1);
  assert.equal(s2.placed, 2);
});

test("an overwrite transfers ownership to the last painter", () => {
  const { proto, s } = fresh();
  const s1 = proto.applyMove(s, { x: 2, y: 2, color: 5 }, "A");
  const s2 = proto.applyMove(s1, { x: 2, y: 2, color: 9 }, "B");
  const idx = 2 * 4 + 2;
  assert.equal(s2.canvas[idx], 9);
  assert.equal(s2.owner[idx], OWNER_B);
  assert.equal(s2.paints[idx], 2);
  assert.equal(s2.ownedA, 0);
  assert.equal(s2.ownedB, 1);
});

test("rejects a pixel outside the canvas bounds", () => {
  const { proto, s } = fresh();
  assert.throws(() => proto.applyMove(s, { x: 4, y: 0, color: 1 }, "A"));
  assert.throws(() => proto.applyMove(s, { x: 0, y: -1, color: 1 }, "A"));
});

test("rejects an invalid palette color", () => {
  const { proto, s } = fresh();
  assert.throws(() => proto.applyMove(s, { x: 0, y: 0, color: 0 }, "A"));
  assert.throws(() => proto.applyMove(s, { x: 0, y: 0, color: NUM_COLORS + 1 }, "A"));
});

test("a locked cell rejects every painter, including its owner", () => {
  const { proto, s } = fresh({ overwriteLimit: 2, cap: 999 });
  const s1 = proto.applyMove(s, { x: 0, y: 0, color: 3 }, "A");
  assert.equal(s1.locked, 0); // 1 paint, not yet locked
  const s2 = proto.applyMove(s1, { x: 0, y: 0, color: 4 }, "B");
  assert.equal(s2.paints[0], 2);
  assert.equal(s2.locked, 1); // hit the limit → locked
  assert.throws(() => proto.applyMove(s2, { x: 0, y: 0, color: 5 }, "B"), /locked/);
  assert.throws(() => proto.applyMove(s2, { x: 0, y: 0, color: 5 }, "A"), /locked/);
});

test("balances are unchanged while the game is ongoing", () => {
  const { proto, s } = fresh();
  const s1 = proto.applyMove(s, { x: 0, y: 0, color: 3 }, "A");
  const s2 = proto.applyMove(s1, { x: 3, y: 3, color: 7 }, "B");
  assert.equal(s2.winner, 0);
  const bal = proto.balances(s2);
  assert.equal(bal.a, ctx.initialBalances.a);
  assert.equal(bal.b, ctx.initialBalances.b);
  assert.equal(bal.a + bal.b, s2.total);
});

test("a decisive territory majority shifts the stake to the winner", () => {
  // 3 cells, each locks after one paint → board fully locks, A owns 2 of 3.
  const proto = new PixelPaintProtocol({ width: 3, height: 1, cap: 999, overwriteLimit: 1 });
  let s = proto.initialState(ctx);
  s = proto.applyMove(s, { x: 0, y: 0, color: 1 }, "A");
  s = proto.applyMove(s, { x: 1, y: 0, color: 1 }, "A");
  s = proto.applyMove(s, { x: 2, y: 0, color: 2 }, "B");
  assert.equal(s.winner, 1);
  assert.ok(proto.isTerminal(s));
  assert.equal(s.ownedA, 2);
  assert.equal(s.ownedB, 1);
  const bal = proto.balances(s);
  assert.equal(bal.a, ctx.initialBalances.a + s.stake);
  assert.equal(bal.b, ctx.initialBalances.b - s.stake);
  assert.equal(bal.a + bal.b, s.total);
});

test("tied territory is a draw and leaves balances unchanged", () => {
  const proto = new PixelPaintProtocol({ width: 2, height: 1, cap: 999, overwriteLimit: 1 });
  let s = proto.initialState(ctx);
  s = proto.applyMove(s, { x: 0, y: 0, color: 1 }, "A");
  s = proto.applyMove(s, { x: 1, y: 0, color: 2 }, "B");
  assert.equal(s.winner, 3);
  assert.ok(proto.isTerminal(s));
  const bal = proto.balances(s);
  assert.equal(bal.a, ctx.initialBalances.a);
  assert.equal(bal.b, ctx.initialBalances.b);
});

test("the stake clamps to the loser's available balance", () => {
  const poorCtx = { tunnelId: "0xcd", initialBalances: { a: 5n, b: 1000n } };
  const proto = new PixelPaintProtocol({ width: 3, height: 1, cap: 999, overwriteLimit: 1 });
  let s = proto.initialState(poorCtx); // stake = min(100, 5) = 5
  assert.equal(s.stake, 5n);
  s = proto.applyMove(s, { x: 0, y: 0, color: 1 }, "B");
  s = proto.applyMove(s, { x: 1, y: 0, color: 1 }, "B");
  s = proto.applyMove(s, { x: 2, y: 0, color: 2 }, "A");
  assert.equal(s.winner, 2); // B owns 2 of 3
  const bal = proto.balances(s);
  assert.equal(bal.a, 0n); // 5 - 5 clamp
  assert.equal(bal.b, 1005n);
  assert.equal(bal.a + bal.b, s.total);
});

test("a fully locked board is terminal even below the placement cap", () => {
  const proto = new PixelPaintProtocol({ width: 2, height: 1, cap: 999, overwriteLimit: 2 });
  let s = proto.initialState(ctx);
  s = proto.applyMove(s, { x: 0, y: 0, color: 1 }, "A");
  s = proto.applyMove(s, { x: 0, y: 0, color: 2 }, "B"); // (0,0) locks
  s = proto.applyMove(s, { x: 1, y: 0, color: 1 }, "A");
  s = proto.applyMove(s, { x: 1, y: 0, color: 2 }, "B"); // (1,0) locks → board full
  assert.equal(s.locked, 2);
  assert.ok(proto.isTerminal(s));
  assert.notEqual(s.winner, 0);
  assert.ok(s.placed < s.cap);
});

test("the session is terminal once the placement cap is reached", () => {
  const { proto, s } = fresh({ cap: 3 });
  let cur = s;
  for (let i = 0; i < 3; i++) {
    cur = proto.applyMove(cur, { x: i, y: 0, color: 1 }, i % 2 ? "B" : "A");
  }
  assert.ok(proto.isTerminal(cur));
  assert.notEqual(cur.winner, 0);
  assert.throws(() => proto.applyMove(cur, { x: 0, y: 1, color: 1 }, "A"));
});

test("encodeState is stable for equal states and changes when a cell changes", () => {
  const { proto, s } = fresh();
  const a = proto.applyMove(s, { x: 1, y: 1, color: 4 }, "A");
  const b = proto.applyMove(s, { x: 1, y: 1, color: 4 }, "A");
  assert.equal(toHex(proto.encodeState(a)), toHex(proto.encodeState(b)));
  const c = proto.applyMove(s, { x: 1, y: 1, color: 5 }, "A");
  assert.notEqual(toHex(proto.encodeState(a)), toHex(proto.encodeState(c)));
});

test("encodeState distinguishes ownership even with an identical canvas", () => {
  const { proto, s } = fresh();
  const a = proto.applyMove(s, { x: 0, y: 0, color: 5 }, "A");
  const b = proto.applyMove(s, { x: 0, y: 0, color: 5 }, "B");
  assert.equal(a.canvas[0], b.canvas[0]); // same color
  assert.notEqual(a.owner[0], b.owner[0]); // different owner
  assert.notEqual(toHex(proto.encodeState(a)), toHex(proto.encodeState(b)));
});

test("no accepted move is a no-op — repainting still advances the hash", () => {
  const { proto, s } = fresh();
  const a = proto.applyMove(s, { x: 2, y: 2, color: 6 }, "A");
  const b = proto.applyMove(a, { x: 2, y: 2, color: 6 }, "A"); // same cell, same color
  assert.notEqual(toHex(proto.encodeState(a)), toHex(proto.encodeState(b)));
});

test("applyMove does not mutate the input state", () => {
  const { proto, s } = fresh();
  const before = toHex(proto.encodeState(s));
  proto.applyMove(s, { x: 0, y: 0, color: 1 }, "A");
  assert.equal(toHex(proto.encodeState(s)), before);
  assert.equal(s.placed, 0);
});

test("randomMove yields a legal move until terminal, then null", () => {
  const { proto, s } = fresh({ cap: 5 });
  let cur = s;
  let seed = 0.123;
  const rng = () => (seed = (seed * 9301 + 49297) % 1) || 0.5;
  for (let i = 0; i < 5; i++) {
    const mv = proto.randomMove(cur, i % 2 ? "B" : "A", rng);
    assert.ok(mv, "expected a legal move before terminal");
    assert.ok(mv!.x >= 0 && mv!.x < cur.width);
    assert.ok(mv!.color >= 1 && mv!.color <= NUM_COLORS);
    cur = proto.applyMove(cur, mv!, i % 2 ? "B" : "A");
  }
  assert.equal(proto.randomMove(cur, "A", rng), null);
});

// ============================================================================
// MODE: war is the default and the historical behavior is preserved.
// ============================================================================

test("the default mode is war and encodes the war mode byte", () => {
  const { proto, s } = fresh();
  assert.equal(proto.name, "pixel_paint.war.v1");
  assert.equal(s.mode, MODE_WAR);
  assert.equal(s.targetCellCount, 0);
  assert.ok(s.targetCommit.every((b) => b === 0)); // war binds no stencil
  assert.equal(s.correctA, 0);
  assert.equal(s.correctB, 0);
});

// ============================================================================
// MODE: free — cooperative free-paint, forced draw, no stake shift.
// ============================================================================

function freeProto(
  cfg: { width?: number; height?: number; cap?: number; overwriteLimit?: number } = {},
): { proto: PixelPaintProtocol; s: PixelPaintState } {
  const proto = new PixelPaintProtocol({ mode: "free", width: 4, height: 4, cap: 8, ...cfg });
  return { proto, s: proto.initialState(ctx) };
}

test("free mode names itself free.v1 and carries no stencil", () => {
  const { proto, s } = freeProto();
  assert.equal(proto.name, "pixel_paint.free.v1");
  assert.equal(s.mode, MODE_FREE);
  assert.equal(s.targetCellCount, 0);
  assert.ok(s.targetCommit.every((b) => b === 0));
});

test("free mode accepts any color on any cell — no scene gate", () => {
  const { proto, s } = freeProto({ overwriteLimit: 3, cap: 999 });
  const s1 = proto.applyMove(s, { x: 0, y: 0, color: 7 }, "A");
  const s2 = proto.applyMove(s1, { x: 0, y: 0, color: 13 }, "B"); // overwrite, new color
  assert.equal(s2.canvas[0], 13);
  assert.equal(s2.owner[0], OWNER_B);
  assert.equal(s2.paints[0], 2);
});

test("free mode never scores scene correctness", () => {
  const { proto, s } = freeProto({ overwriteLimit: 1, cap: 999 });
  let cur = s;
  for (let i = 0; i < 4; i++) {
    cur = proto.applyMove(cur, { x: i, y: 0, color: 1 + i }, i % 2 ? "B" : "A");
  }
  assert.equal(cur.correctA, 0);
  assert.equal(cur.correctB, 0);
});

test("free mode is a no-stake draw once the placement cap is reached", () => {
  const { proto, s } = freeProto({ cap: 3, overwriteLimit: 3 });
  let cur = s;
  for (let i = 0; i < 3; i++) {
    cur = proto.applyMove(cur, { x: i, y: 0, color: 2 }, i % 2 ? "B" : "A");
  }
  assert.equal(cur.winner, 3); // forced draw
  assert.ok(proto.isTerminal(cur));
  const bal = proto.balances(cur);
  assert.equal(bal.a, ctx.initialBalances.a);
  assert.equal(bal.b, ctx.initialBalances.b);
  assert.equal(bal.a + bal.b, cur.total);
  assert.throws(() => proto.applyMove(cur, { x: 3, y: 0, color: 1 }, "A"));
});

test("free mode draws even when one seat owns the whole locked board", () => {
  // A owns both cells, yet free mode forces a draw (cooperative, no winner).
  const proto = new PixelPaintProtocol({ mode: "free", width: 2, height: 1, cap: 999, overwriteLimit: 1 });
  let s = proto.initialState(ctx);
  s = proto.applyMove(s, { x: 0, y: 0, color: 1 }, "A");
  s = proto.applyMove(s, { x: 1, y: 0, color: 1 }, "A");
  assert.equal(s.locked, 2);
  assert.ok(proto.isTerminal(s));
  assert.equal(s.ownedA, 2);
  assert.equal(s.winner, 3);
  const bal = proto.balances(s);
  assert.equal(bal.a, ctx.initialBalances.a);
  assert.equal(bal.b, ctx.initialBalances.b);
});

// ============================================================================
// MODE: scene — shared stencil race, scored at the locking paint.
// ============================================================================

/** Build a scene protocol over a tiny stencil. target is row-major, 0 = background. */
function sceneProto(
  target: Uint8Array,
  cfg: { width: number; height: number; cap?: number; overwriteLimit?: number },
): { proto: PixelPaintProtocol; s: PixelPaintState } {
  const proto = new PixelPaintProtocol({ mode: "scene", cap: 999, overwriteLimit: 1, ...cfg, target });
  return { proto, s: proto.initialState(ctx) };
}

test("scene construction requires a valid stencil", () => {
  // missing target
  assert.throws(() => new PixelPaintProtocol({ mode: "scene", width: 2, height: 1 }));
  // wrong length
  assert.throws(
    () => new PixelPaintProtocol({ mode: "scene", width: 2, height: 1, target: Uint8Array.of(1) }),
  );
  // all-background (no required cell)
  assert.throws(
    () => new PixelPaintProtocol({ mode: "scene", width: 2, height: 1, target: Uint8Array.of(0, 0) }),
  );
  // color out of palette range
  assert.throws(
    () =>
      new PixelPaintProtocol({
        mode: "scene",
        width: 2,
        height: 1,
        target: Uint8Array.of(1, NUM_COLORS + 1),
      }),
  );
});

test("scene state names itself scene.v1 and commits to the stencil", () => {
  const { proto, s } = sceneProto(Uint8Array.of(1, 2, 0), { width: 3, height: 1 });
  assert.equal(proto.name, "pixel_paint.scene.v1");
  assert.equal(s.mode, MODE_SCENE);
  assert.equal(s.targetCellCount, 2); // two non-background cells
  const expected = blake2b256(
    concatBytes([
      protocolDomain("pixel_paint.scene.v1"),
      u64ToBeBytes(3n),
      u64ToBeBytes(1n),
      Uint8Array.of(1, 2, 0),
    ]),
  );
  assert.equal(toHex(s.targetCommit), toHex(expected));
});

test("scene gate rejects an off-scene (background) cell", () => {
  const { proto, s } = sceneProto(Uint8Array.of(1, 0), { width: 2, height: 1 });
  assert.throws(() => proto.applyMove(s, { x: 1, y: 0, color: 1 }, "A"), /off-scene/);
});

test("scene gate rejects the wrong color on a stencil cell", () => {
  const { proto, s } = sceneProto(Uint8Array.of(3, 0), { width: 2, height: 1 });
  assert.throws(() => proto.applyMove(s, { x: 0, y: 0, color: 4 }, "A"), /scene color/);
  // the required color is accepted
  const ok = proto.applyMove(s, { x: 0, y: 0, color: 3 }, "A");
  assert.equal(ok.canvas[0], 3);
});

test("scene correctness banks at the lock, not before, and the locker scores", () => {
  // overwriteLimit 2: a stencil cell needs two paints to lock. The painter who
  // lays the LOCKING paint banks the correctness — even if the other painted first.
  const { proto, s } = sceneProto(Uint8Array.of(3, 0), {
    width: 2,
    height: 1,
    overwriteLimit: 2,
  });
  const s1 = proto.applyMove(s, { x: 0, y: 0, color: 3 }, "A"); // paint 1/2 — not locked
  assert.equal(s1.paints[0], 1);
  assert.equal(s1.correctA, 0);
  assert.equal(s1.correctB, 0);
  assert.equal(s1.winner, 0);
  const s2 = proto.applyMove(s1, { x: 0, y: 0, color: 3 }, "B"); // paint 2/2 — locks
  assert.equal(s2.correctA, 0);
  assert.equal(s2.correctB, 1); // B sniped the lock
  assert.ok(proto.isTerminal(s2)); // stencil (1 cell) fully locked
  assert.equal(s2.winner, 2);
  const bal = proto.balances(s2);
  assert.equal(bal.a, ctx.initialBalances.a - s2.stake);
  assert.equal(bal.b, ctx.initialBalances.b + s2.stake);
  assert.equal(bal.a + bal.b, s2.total);
});

test("scene settles when the stencil is fully locked and most-correct wins", () => {
  // A locks both required cells; the background cell is never touched.
  const { proto, s } = sceneProto(Uint8Array.of(1, 2, 0), { width: 3, height: 1 });
  let cur = proto.applyMove(s, { x: 0, y: 0, color: 1 }, "A");
  assert.equal(cur.winner, 0); // 1 of 2 stencil cells locked
  cur = proto.applyMove(cur, { x: 1, y: 0, color: 2 }, "A");
  assert.equal(cur.locked, 2);
  assert.equal(cur.correctA, 2);
  assert.equal(cur.correctB, 0);
  assert.ok(proto.isTerminal(cur));
  assert.equal(cur.winner, 1);
  assert.equal(cur.canvas[2], EMPTY); // background untouched
  const bal = proto.balances(cur);
  assert.equal(bal.a, ctx.initialBalances.a + cur.stake);
  assert.equal(bal.b, ctx.initialBalances.b - cur.stake);
});

test("scene with equal correctness is a draw and shifts no stake", () => {
  const { proto, s } = sceneProto(Uint8Array.of(1, 2), { width: 2, height: 1 });
  let cur = proto.applyMove(s, { x: 0, y: 0, color: 1 }, "A"); // A banks idx0
  cur = proto.applyMove(cur, { x: 1, y: 0, color: 2 }, "B"); // B banks idx1
  assert.equal(cur.correctA, 1);
  assert.equal(cur.correctB, 1);
  assert.ok(proto.isTerminal(cur));
  assert.equal(cur.winner, 3);
  const bal = proto.balances(cur);
  assert.equal(bal.a, ctx.initialBalances.a);
  assert.equal(bal.b, ctx.initialBalances.b);
});

test("scene: no accepted move is a no-op — a re-paint advances the hash", () => {
  const { proto, s } = sceneProto(Uint8Array.of(5, 0), {
    width: 2,
    height: 1,
    overwriteLimit: 3,
  });
  const a = proto.applyMove(s, { x: 0, y: 0, color: 5 }, "A");
  const b = proto.applyMove(a, { x: 0, y: 0, color: 5 }, "A"); // same cell & color
  assert.equal(a.winner, 0);
  assert.equal(b.winner, 0);
  assert.notEqual(toHex(proto.encodeState(a)), toHex(proto.encodeState(b)));
});

test("scene encodeState is deterministic for equal states", () => {
  const { proto, s } = sceneProto(Uint8Array.of(1, 2, 0), {
    width: 3,
    height: 1,
    overwriteLimit: 2,
  });
  const a = proto.applyMove(s, { x: 0, y: 0, color: 1 }, "A");
  const b = proto.applyMove(s, { x: 0, y: 0, color: 1 }, "A");
  assert.equal(toHex(proto.encodeState(a)), toHex(proto.encodeState(b)));
  const c = proto.applyMove(s, { x: 1, y: 0, color: 2 }, "B");
  assert.notEqual(toHex(proto.encodeState(a)), toHex(proto.encodeState(c)));
});

test("scene randomMove only paints stencil cells at the required color, then null", () => {
  const target = Uint8Array.of(1, 0, 3, 0, 5, 6);
  const { proto, s } = sceneProto(target, { width: 3, height: 2, overwriteLimit: 1 });
  let cur = s;
  let seed = 0.321;
  const rng = () => (seed = (seed * 9301 + 49297) % 1) || 0.5;
  let moves = 0;
  for (let mv = proto.randomMove(cur, "A", rng); mv; mv = proto.randomMove(cur, moves % 2 ? "B" : "A", rng)) {
    const idx = mv.y * cur.width + mv.x;
    assert.notEqual(target[idx], 0, "randomMove must pick a stencil cell");
    assert.equal(mv.color, target[idx], "randomMove must use the required color");
    cur = proto.applyMove(cur, mv, moves % 2 ? "B" : "A");
    moves++;
    assert.ok(moves <= 4, "scene must terminate within targetCellCount paints");
  }
  assert.ok(proto.isTerminal(cur));
  assert.equal(cur.locked, cur.targetCellCount);
});
