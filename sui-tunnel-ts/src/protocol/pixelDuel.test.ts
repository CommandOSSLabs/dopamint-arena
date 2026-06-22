import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PixelDuelProtocol,
  PixelDuelState,
  PixelDuelMove,
  OWNER_A,
  OWNER_B,
  COLOR_A,
  COLOR_B,
  NUM_COLORS,
  PHASE_PLAY,
  PHASE_REVEAL,
  PHASE_OVER,
} from "./pixelDuel";
import { computeCommitment } from "../core/commitment";
import { toHex } from "../core/bytes";

const ctx = { tunnelId: "0xab", initialBalances: { a: 1000n, b: 1000n } };

/** A fixed 16-byte salt (>= MIN_SALT_LEN) for deterministic commits. */
function salt(seed: number): Uint8Array {
  return Uint8Array.from({ length: 16 }, (_, i) => (seed + i) & 0xff);
}

/**
 * A w*h 0/1 template with `cells` ones packed from index `start`. Lets a test
 * place a seat's "shape" anywhere on the board and know its exact coverage.
 */
function template(size: number, start: number, cells: number): Uint8Array {
  const t = new Uint8Array(size);
  for (let i = 0; i < cells; i++) t[start + i] = 1;
  return t;
}

/**
 * Build a duel over a small board with both seats committed. minTemplateCells is
 * lowered so tiny boards can carry a legal template.
 */
function duel(cfg: {
  width: number;
  height: number;
  cap?: number;
  overwriteLimit?: number;
  templateA: Uint8Array;
  saltA: Uint8Array;
  templateB: Uint8Array;
  saltB: Uint8Array;
  minCells?: number;
  maxCells?: number;
  initialBalances?: { a: bigint; b: bigint };
}): { proto: PixelDuelProtocol; s: PixelDuelState } {
  const proto = new PixelDuelProtocol({
    width: cfg.width,
    height: cfg.height,
    cap: cfg.cap ?? 999,
    overwriteLimit: cfg.overwriteLimit ?? 1,
    templateCommitA: computeCommitment(cfg.templateA, cfg.saltA),
    templateCommitB: computeCommitment(cfg.templateB, cfg.saltB),
    minTemplateCells: cfg.minCells ?? 1,
    maxTemplateCells: cfg.maxCells ?? cfg.width * cfg.height,
  });
  const useCtx = cfg.initialBalances
    ? { tunnelId: "0xab", initialBalances: cfg.initialBalances }
    : ctx;
  return { proto, s: proto.initialState(useCtx) };
}

const paint = (x: number, y: number, color: number): PixelDuelMove => ({
  kind: "paint",
  x,
  y,
  color,
});

// ============================================================================
// Construction + initial state
// ============================================================================

test("initial state is play phase, empty board, with both template commitments", () => {
  const tA = template(16, 0, 4);
  const tB = template(16, 8, 4);
  const sA = salt(1);
  const sB = salt(2);
  const { s } = duel({ width: 4, height: 4, templateA: tA, saltA: sA, templateB: tB, saltB: sB });
  assert.equal(s.phase, "play");
  assert.equal(s.canvas.length, 16);
  assert.ok(s.canvas.every((c) => c === 0));
  assert.equal(s.placed, 0);
  assert.equal(s.winner, 0);
  assert.equal(s.revealedA, null);
  assert.equal(s.revealedB, null);
  // commit binds the hash: it is exactly computeCommitment(template, salt).
  assert.equal(toHex(s.templateCommitA), toHex(computeCommitment(tA, sA)));
  assert.equal(toHex(s.templateCommitB), toHex(computeCommitment(tB, sB)));
});

test("default geometry is the 48x40 duel board", () => {
  const proto = new PixelDuelProtocol();
  const s = proto.initialState(ctx);
  assert.equal(s.width, 48);
  assert.equal(s.height, 40);
  assert.equal(s.canvas.length, 48 * 40);
  assert.equal(s.cap, 1200);
  assert.equal(s.overwriteLimit, 3);
});

// ============================================================================
// Play phase: the war paint/own/lock mechanic
// ============================================================================

test("play moves use the war paint/own/lock mechanic", () => {
  const { proto, s } = duel({
    width: 4,
    height: 4,
    overwriteLimit: 2,
    templateA: template(16, 0, 4),
    saltA: salt(1),
    templateB: template(16, 8, 4),
    saltB: salt(2),
  });
  const s1 = proto.applyMove(s, paint(0, 0, COLOR_A), "A");
  assert.equal(s1.canvas[0], COLOR_A);
  assert.equal(s1.owner[0], OWNER_A);
  assert.equal(s1.paints[0], 1);
  assert.equal(s1.ownedA, 1);
  assert.equal(s1.locked, 0);
  // overwrite transfers ownership to the last painter, then locks at the limit.
  const s2 = proto.applyMove(s1, paint(0, 0, COLOR_B), "B");
  assert.equal(s2.owner[0], OWNER_B);
  assert.equal(s2.ownedA, 0);
  assert.equal(s2.ownedB, 1);
  assert.equal(s2.paints[0], 2);
  assert.equal(s2.locked, 1);
  // a locked cell rejects every painter, including its owner.
  assert.throws(() => proto.applyMove(s2, paint(0, 0, COLOR_B), "B"), /locked/);
  assert.throws(() => proto.applyMove(s2, paint(0, 0, COLOR_A), "A"), /locked/);
});

test("play rejects out-of-bounds and invalid palette colors", () => {
  const { proto, s } = duel({
    width: 4,
    height: 4,
    templateA: template(16, 0, 4),
    saltA: salt(1),
    templateB: template(16, 8, 4),
    saltB: salt(2),
  });
  assert.throws(() => proto.applyMove(s, paint(4, 0, COLOR_A), "A"));
  assert.throws(() => proto.applyMove(s, paint(0, -1, COLOR_A), "A"));
  assert.throws(() => proto.applyMove(s, paint(0, 0, 0), "A"));
  assert.throws(() => proto.applyMove(s, paint(0, 0, NUM_COLORS + 1), "A"));
});

test("play reaches terminal at the placement cap and transitions to reveal", () => {
  const { proto, s } = duel({
    width: 4,
    height: 4,
    cap: 3,
    overwriteLimit: 3,
    templateA: template(16, 0, 4),
    saltA: salt(1),
    templateB: template(16, 8, 4),
    saltB: salt(2),
  });
  let cur = s;
  for (let i = 0; i < 3; i++) {
    cur = proto.applyMove(cur, paint(i, 0, COLOR_A), i % 2 ? "B" : "A");
  }
  assert.equal(cur.phase, "reveal");
  assert.equal(cur.winner, 0); // no winner until both reveal
  // paint is now illegal — only reveal is accepted.
  assert.throws(() => proto.applyMove(cur, paint(3, 0, COLOR_A), "A"), /play/);
});

test("a fully locked board transitions to reveal below the cap", () => {
  const { proto, s } = duel({
    width: 2,
    height: 1,
    cap: 999,
    overwriteLimit: 1,
    templateA: template(2, 0, 1),
    saltA: salt(1),
    templateB: template(2, 1, 1),
    saltB: salt(2),
  });
  let cur = proto.applyMove(s, paint(0, 0, COLOR_A), "A");
  assert.equal(cur.phase, "play");
  cur = proto.applyMove(cur, paint(1, 0, COLOR_B), "B");
  assert.equal(cur.locked, 2);
  assert.equal(cur.phase, "reveal");
  assert.ok(cur.placed < cur.cap);
});

// ============================================================================
// No-op proof + determinism
// ============================================================================

test("every accepted paint strictly changes encodeState (no no-op)", () => {
  const { proto, s } = duel({
    width: 4,
    height: 4,
    overwriteLimit: 3,
    templateA: template(16, 0, 4),
    saltA: salt(1),
    templateB: template(16, 8, 4),
    saltB: salt(2),
  });
  const a = proto.applyMove(s, paint(2, 2, COLOR_A), "A");
  const b = proto.applyMove(a, paint(2, 2, COLOR_A), "A"); // same cell, same color
  assert.notEqual(toHex(proto.encodeState(a)), toHex(proto.encodeState(b)));
});

test("encodeState is deterministic for equal states and applyMove does not mutate", () => {
  const { proto, s } = duel({
    width: 4,
    height: 4,
    templateA: template(16, 0, 4),
    saltA: salt(1),
    templateB: template(16, 8, 4),
    saltB: salt(2),
  });
  const before = toHex(proto.encodeState(s));
  const a = proto.applyMove(s, paint(1, 1, COLOR_A), "A");
  const b = proto.applyMove(s, paint(1, 1, COLOR_A), "A");
  assert.equal(toHex(proto.encodeState(a)), toHex(proto.encodeState(b)));
  // input state untouched
  assert.equal(toHex(proto.encodeState(s)), before);
  assert.equal(s.placed, 0);
});

test("two clients with different secret templates produce identical encodeState during play", () => {
  // Same public moves + same two commitments, but each client's view of the
  // OPPONENT template is irrelevant: encodeState hashes only public state.
  const tA = template(16, 0, 4);
  const tB = template(16, 8, 4);
  const sA = salt(1);
  const sB = salt(2);
  const commitA = computeCommitment(tA, sA);
  const commitB = computeCommitment(tB, sB);
  const make = () =>
    new PixelDuelProtocol({
      width: 4,
      height: 4,
      cap: 999,
      overwriteLimit: 3,
      templateCommitA: commitA,
      templateCommitB: commitB,
      minTemplateCells: 1,
      maxTemplateCells: 16,
    });
  const p1 = make();
  const p2 = make();
  let s1 = p1.initialState(ctx);
  let s2 = p2.initialState(ctx);
  const moves: [PixelDuelMove, "A" | "B"][] = [
    [paint(0, 0, COLOR_A), "A"],
    [paint(1, 1, COLOR_B), "B"],
    [paint(2, 0, COLOR_A), "A"],
  ];
  for (const [m, by] of moves) {
    s1 = p1.applyMove(s1, m, by);
    s2 = p2.applyMove(s2, m, by);
    assert.equal(toHex(p1.encodeState(s1)), toHex(p2.encodeState(s2)));
  }
});

// ============================================================================
// Reveal: commit binding, honest scoring + settlement, mismatch rejection
// ============================================================================

/** Drive play to terminal (reveal phase) without painting any template cell. */
function playToReveal(
  proto: PixelDuelProtocol,
  s: PixelDuelState,
): PixelDuelState {
  let cur = s;
  // Lock the whole board with neutral paints away from template regions where
  // possible; here we just paint everything to reach the lock terminal.
  const w = cur.width;
  const h = cur.height;
  let by: "A" | "B" = "A";
  while (cur.phase === "play") {
    let painted = false;
    for (let y = 0; y < h && cur.phase === "play"; y++) {
      for (let x = 0; x < w && cur.phase === "play"; x++) {
        const idx = y * w + x;
        if (cur.paints[idx] < cur.overwriteLimit) {
          cur = proto.applyMove(cur, paint(x, y, by === "A" ? COLOR_A : COLOR_B), by);
          by = by === "A" ? "B" : "A";
          painted = true;
        }
      }
    }
    if (!painted) break;
  }
  return cur;
}

test("commit binds the hash: an honest reveal scores coverage and settles", () => {
  // 1x4 board. A's template = the two left cells; B's = the two right cells.
  const tA = Uint8Array.of(1, 1, 0, 0);
  const tB = Uint8Array.of(0, 0, 1, 1);
  const sA = salt(3);
  const sB = salt(4);
  const proto = new PixelDuelProtocol({
    width: 4,
    height: 1,
    cap: 999,
    overwriteLimit: 1,
    templateCommitA: computeCommitment(tA, sA),
    templateCommitB: computeCommitment(tB, sB),
    minTemplateCells: 1,
    maxTemplateCells: 4,
  });
  let s = proto.initialState(ctx);
  // A paints + locks both of its own cells in its color (2/2 coverage).
  s = proto.applyMove(s, paint(0, 0, COLOR_A), "A");
  s = proto.applyMove(s, paint(1, 0, COLOR_A), "A");
  // B paints + locks only one of its two cells (1/2 coverage). The board locks.
  s = proto.applyMove(s, paint(2, 0, COLOR_B), "B");
  s = proto.applyMove(s, paint(3, 0, COLOR_A), "B"); // B paints its cell the WRONG color
  assert.equal(s.phase, "reveal");

  s = proto.applyMove(s, { kind: "reveal", template: tA, salt: sA }, "A");
  assert.equal(s.phase, "reveal"); // waiting for B
  assert.equal(s.winner, 0);
  s = proto.applyMove(s, { kind: "reveal", template: tB, salt: sB }, "B");

  assert.equal(s.phase, "over");
  assert.equal(s.scoreNumA, 2); // both A cells painted COLOR_A
  assert.equal(s.scoreNumB, 1); // only one B cell painted COLOR_B (other was wrong color)
  assert.equal(s.templateCellsA, 2);
  assert.equal(s.templateCellsB, 2);
  assert.equal(s.winner, 1); // 2/2 > 1/2
  assert.ok(proto.isTerminal(s));
  const bal = proto.balances(s);
  assert.equal(bal.a, ctx.initialBalances.a + s.stake);
  assert.equal(bal.b, ctx.initialBalances.b - s.stake);
  assert.equal(bal.a + bal.b, s.total);
});

test("a mismatched reveal is rejected (commit-reveal binding)", () => {
  const tA = Uint8Array.of(1, 1, 0, 0);
  const tB = Uint8Array.of(0, 0, 1, 1);
  const sA = salt(3);
  const sB = salt(4);
  const { proto, s } = duel({
    width: 4,
    height: 1,
    templateA: tA,
    saltA: sA,
    templateB: tB,
    saltB: sB,
  });
  let cur = playToReveal(proto, s);
  // wrong template bytes
  assert.throws(
    () => proto.applyMove(cur, { kind: "reveal", template: Uint8Array.of(1, 0, 1, 0), salt: sA }, "A"),
    /commitment/,
  );
  // wrong salt
  assert.throws(
    () => proto.applyMove(cur, { kind: "reveal", template: tA, salt: salt(99) }, "A"),
    /commitment/,
  );
  // a too-short salt is rejected before the hash check
  assert.throws(
    () => proto.applyMove(cur, { kind: "reveal", template: tA, salt: new Uint8Array(8) }, "A"),
    /salt/,
  );
});

test("reveal with non-0/1 bytes or out-of-range cell count is rejected", () => {
  const tA = Uint8Array.of(1, 1, 0, 0);
  const sA = salt(3);
  const tB = Uint8Array.of(0, 0, 1, 1);
  const sB = salt(4);
  // bad layout: a byte equal to 2
  const badLayout = Uint8Array.of(1, 2, 0, 0);
  const proto = new PixelDuelProtocol({
    width: 4,
    height: 1,
    cap: 999,
    overwriteLimit: 1,
    templateCommitA: computeCommitment(badLayout, sA),
    templateCommitB: computeCommitment(tB, sB),
    minTemplateCells: 1,
    maxTemplateCells: 4,
  });
  let cur = proto.initialState(ctx);
  cur = playToReveal(proto, cur);
  assert.throws(
    () => proto.applyMove(cur, { kind: "reveal", template: badLayout, salt: sA }, "A"),
    /not 0\/1/,
  );

  // out-of-range cell count: a 1-cell template under a min of 2.
  const tiny = Uint8Array.of(1, 0, 0, 0);
  const proto2 = new PixelDuelProtocol({
    width: 4,
    height: 1,
    cap: 999,
    overwriteLimit: 1,
    templateCommitA: computeCommitment(tiny, sA),
    templateCommitB: computeCommitment(tB, sB),
    minTemplateCells: 2,
    maxTemplateCells: 4,
  });
  let cur2 = playToReveal(proto2, proto2.initialState(ctx));
  assert.throws(
    () => proto2.applyMove(cur2, { kind: "reveal", template: tiny, salt: sA }, "A"),
    /cell count/,
  );
});

test("equal coverage fractions are a draw and shift no stake", () => {
  // Both seats lock exactly one of their two own-color cells: 1/2 vs 1/2.
  const tA = Uint8Array.of(1, 1, 0, 0);
  const tB = Uint8Array.of(0, 0, 1, 1);
  const sA = salt(5);
  const sB = salt(6);
  const proto = new PixelDuelProtocol({
    width: 4,
    height: 1,
    cap: 999,
    overwriteLimit: 1,
    templateCommitA: computeCommitment(tA, sA),
    templateCommitB: computeCommitment(tB, sB),
    minTemplateCells: 1,
    maxTemplateCells: 4,
  });
  let s = proto.initialState(ctx);
  s = proto.applyMove(s, paint(0, 0, COLOR_A), "A"); // A: 1 of 2 right
  s = proto.applyMove(s, paint(1, 0, COLOR_B), "B"); // A cell painted wrong → no A score
  s = proto.applyMove(s, paint(2, 0, COLOR_B), "B"); // B: 1 of 2 right
  s = proto.applyMove(s, paint(3, 0, COLOR_A), "A"); // B cell painted wrong → no B score
  assert.equal(s.phase, "reveal");
  s = proto.applyMove(s, { kind: "reveal", template: tA, salt: sA }, "A");
  s = proto.applyMove(s, { kind: "reveal", template: tB, salt: sB }, "B");
  assert.equal(s.scoreNumA, 1);
  assert.equal(s.scoreNumB, 1);
  assert.equal(s.winner, 3); // 1/2 == 1/2
  const bal = proto.balances(s);
  assert.equal(bal.a, ctx.initialBalances.a);
  assert.equal(bal.b, ctx.initialBalances.b);
  assert.equal(bal.a + bal.b, s.total);
});

test("coverage is a fraction: a higher ratio wins even with fewer raw hits", () => {
  // A: 2 hits out of 2 cells (100%). B: 3 hits out of 6 cells (50%). A wins.
  const tA = template(8, 0, 2); // cells 0,1
  const tB = template(8, 2, 6); // cells 2..7
  const sA = salt(7);
  const sB = salt(8);
  const proto = new PixelDuelProtocol({
    width: 8,
    height: 1,
    cap: 999,
    overwriteLimit: 1,
    templateCommitA: computeCommitment(tA, sA),
    templateCommitB: computeCommitment(tB, sB),
    minTemplateCells: 1,
    maxTemplateCells: 8,
  });
  let s = proto.initialState(ctx);
  s = proto.applyMove(s, paint(0, 0, COLOR_A), "A");
  s = proto.applyMove(s, paint(1, 0, COLOR_A), "A"); // A: 2/2
  s = proto.applyMove(s, paint(2, 0, COLOR_B), "B");
  s = proto.applyMove(s, paint(3, 0, COLOR_B), "B");
  s = proto.applyMove(s, paint(4, 0, COLOR_B), "B"); // B: 3/6
  s = proto.applyMove(s, paint(5, 0, COLOR_A), "A");
  s = proto.applyMove(s, paint(6, 0, COLOR_A), "A");
  s = proto.applyMove(s, paint(7, 0, COLOR_A), "A");
  assert.equal(s.phase, "reveal");
  s = proto.applyMove(s, { kind: "reveal", template: tA, salt: sA }, "A");
  s = proto.applyMove(s, { kind: "reveal", template: tB, salt: sB }, "B");
  assert.equal(s.scoreNumA, 2);
  assert.equal(s.templateCellsA, 2);
  assert.equal(s.scoreNumB, 3);
  assert.equal(s.templateCellsB, 6);
  // 2/2 > 3/6  ⇔  2*6 > 3*2  ⇔  12 > 6
  assert.equal(s.winner, 1);
});

test("a wasted cross-color paint scores for neither side", () => {
  // A paints its own template cell with B's color. It cannot score for A (wrong
  // color) and cannot score for B (not B's template). Self-harm, not a steal.
  const tA = Uint8Array.of(1, 1, 0, 0);
  const tB = Uint8Array.of(0, 0, 1, 1);
  const sA = salt(9);
  const sB = salt(10);
  const proto = new PixelDuelProtocol({
    width: 4,
    height: 1,
    cap: 999,
    overwriteLimit: 1,
    templateCommitA: computeCommitment(tA, sA),
    templateCommitB: computeCommitment(tB, sB),
    minTemplateCells: 1,
    maxTemplateCells: 4,
  });
  let s = proto.initialState(ctx);
  s = proto.applyMove(s, paint(0, 0, COLOR_B), "A"); // A wastes: own cell, B's color
  s = proto.applyMove(s, paint(1, 0, COLOR_A), "A"); // A scores this one
  s = proto.applyMove(s, paint(2, 0, COLOR_B), "B"); // B scores
  s = proto.applyMove(s, paint(3, 0, COLOR_B), "B"); // B scores
  s = proto.applyMove(s, { kind: "reveal", template: tA, salt: sA }, "A");
  s = proto.applyMove(s, { kind: "reveal", template: tB, salt: sB }, "B");
  assert.equal(s.scoreNumA, 1); // the wasted cell did NOT count for A
  assert.equal(s.scoreNumB, 2); // and did NOT count for B either
  assert.equal(s.winner, 2); // 1/2 < 2/2
});

test("the stake clamps to the loser's available balance", () => {
  const tA = Uint8Array.of(1, 1, 0, 0);
  const tB = Uint8Array.of(0, 0, 1, 1);
  const sA = salt(11);
  const sB = salt(12);
  const proto = new PixelDuelProtocol({
    width: 4,
    height: 1,
    cap: 999,
    overwriteLimit: 1,
    templateCommitA: computeCommitment(tA, sA),
    templateCommitB: computeCommitment(tB, sB),
    minTemplateCells: 1,
    maxTemplateCells: 4,
  });
  // A starts poor: stake = min(100, 5) = 5.
  let s = proto.initialState({ tunnelId: "0xcd", initialBalances: { a: 5n, b: 1000n } });
  assert.equal(s.stake, 5n);
  s = proto.applyMove(s, paint(0, 0, COLOR_A), "A"); // A: 1/2
  s = proto.applyMove(s, paint(1, 0, COLOR_B), "B");
  s = proto.applyMove(s, paint(2, 0, COLOR_B), "B"); // B: 2/2
  s = proto.applyMove(s, paint(3, 0, COLOR_B), "B");
  s = proto.applyMove(s, { kind: "reveal", template: tA, salt: sA }, "A");
  s = proto.applyMove(s, { kind: "reveal", template: tB, salt: sB }, "B");
  assert.equal(s.winner, 2); // B wins
  const bal = proto.balances(s);
  assert.equal(bal.a, 0n); // 5 - 5 clamp
  assert.equal(bal.b, 1005n);
  assert.equal(bal.a + bal.b, s.total);
});

// ============================================================================
// Phase guards + randomMove + commitment golden parity
// ============================================================================

test("paint is illegal in reveal phase and reveal is illegal in play phase", () => {
  const tA = Uint8Array.of(1, 1, 0, 0);
  const tB = Uint8Array.of(0, 0, 1, 1);
  const sA = salt(13);
  const sB = salt(14);
  const { proto, s } = duel({
    width: 4,
    height: 1,
    templateA: tA,
    saltA: sA,
    templateB: tB,
    saltB: sB,
  });
  // reveal during play
  assert.throws(
    () => proto.applyMove(s, { kind: "reveal", template: tA, salt: sA }, "A"),
    /reveal phase/,
  );
  const reveal = playToReveal(proto, s);
  // paint during reveal
  assert.throws(() => proto.applyMove(reveal, paint(0, 0, COLOR_A), "A"), /play/);
});

test("phase codes encode play, reveal, and over distinctly", () => {
  // Sanity that the exported phase codes are the three distinct bytes used.
  assert.equal(PHASE_PLAY, 0);
  assert.equal(PHASE_REVEAL, 1);
  assert.equal(PHASE_OVER, 2);
});

test("randomMove yields a legal seat-colored paint in play and null otherwise", () => {
  const { proto, s } = duel({
    width: 4,
    height: 4,
    cap: 5,
    overwriteLimit: 3,
    templateA: template(16, 0, 4),
    saltA: salt(1),
    templateB: template(16, 8, 4),
    saltB: salt(2),
  });
  let cur = s;
  let seed = 0.123;
  const rng = () => (seed = (seed * 9301 + 49297) % 1) || 0.5;
  for (let i = 0; i < 5; i++) {
    const by = i % 2 ? "B" : "A";
    const mv = proto.randomMove(cur, by, rng);
    assert.ok(mv, "expected a legal move before terminal");
    assert.equal(mv!.kind, "paint");
    if (mv!.kind === "paint") {
      assert.equal(mv!.color, by === "A" ? COLOR_A : COLOR_B); // monochrome bot
      assert.ok(mv!.x >= 0 && mv!.x < cur.width);
    }
    cur = proto.applyMove(cur, mv!, by);
  }
  // now in reveal phase → randomMove cannot produce a reveal, returns null
  assert.equal(cur.phase, "reveal");
  assert.equal(proto.randomMove(cur, "A", rng), null);
});

test("balanceA + balanceB === total for every reachable state in a full game", () => {
  const tA = Uint8Array.of(1, 1, 0, 0);
  const tB = Uint8Array.of(0, 0, 1, 1);
  const sA = salt(15);
  const sB = salt(16);
  const proto = new PixelDuelProtocol({
    width: 4,
    height: 1,
    cap: 999,
    overwriteLimit: 1,
    templateCommitA: computeCommitment(tA, sA),
    templateCommitB: computeCommitment(tB, sB),
    minTemplateCells: 1,
    maxTemplateCells: 4,
  });
  let s = proto.initialState(ctx);
  const check = (st: PixelDuelState) => {
    const b = proto.balances(st);
    assert.equal(b.a + b.b, st.total);
  };
  check(s);
  const seq: [PixelDuelMove, "A" | "B"][] = [
    [paint(0, 0, COLOR_A), "A"],
    [paint(1, 0, COLOR_A), "A"],
    [paint(2, 0, COLOR_B), "B"],
    [paint(3, 0, COLOR_A), "B"],
    [{ kind: "reveal", template: tA, salt: sA }, "A"],
    [{ kind: "reveal", template: tB, salt: sB }, "B"],
  ];
  for (const [m, by] of seq) {
    s = proto.applyMove(s, m, by);
    check(s);
  }
  assert.ok(proto.isTerminal(s));
});

test("golden byte-parity: the reveal commit equals randomness::create_commitment", () => {
  // Mirrors core/commitment.test.ts's golden vector. The duel binds the template
  // with the SAME commitment primitive, so it verifies on-chain identically.
  const value = Uint8Array.of(7);
  const fixedSalt = Uint8Array.from({ length: 16 }, (_, i) => i + 1); // 1..16
  const G_COMMITMENT =
    "9c5d7de7c93e176f232424794b460112bbc1e3edad6af9da200a121e7033f9f9";
  assert.equal(toHex(computeCommitment(value, fixedSalt)), G_COMMITMENT);
});
