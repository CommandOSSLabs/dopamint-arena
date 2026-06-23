import { describe, it } from "node:test";
import assert from "node:assert";
import { scoreDuel, scoreDuelFog } from "./duelScore";
import { PixelPaintProtocol } from "sui-tunnel-ts/protocol/pixelPaint";
import {
  attackCooldownMs,
  classifyPaint,
  placementColor,
  planBotMove,
} from "./usePaintDuel";
import { COOLDOWN_MS } from "./ui/tokens";

const MISS_PENALTY_MS = 3000; // mirrors usePaintDuel's whiff tax

// ---------------------------------------------------------------------------
// Headless duel sim for the FAIRNESS contract: the bot's probe-aim must use ONLY
// public intel (revealed/blocked), never the foe's secret shape. We replay whole
// duels with a seeded RNG and inspect early probe hit-rate + termination.
// ---------------------------------------------------------------------------

/** Mulberry32 — same seeded PRNG family the hook uses, so sims are replayable. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIM_BOARD = { width: 96, height: 56 };
const SEAT_A_COLOR = 14;
const SEAT_B_COLOR = 5;
const PROBE_COLOR = 3;

/** Mirror of the hook's BOT_PROFILES (tickMs is irrelevant to a headless sim). */
const PROFILE = {
  easy: { tickMs: 0, attackRate: 0.18, skipRate: 0.28, huntSloppiness: 0.5, paritySearch: false },
  normal: { tickMs: 0, attackRate: 0.3, skipRate: 0, huntSloppiness: 0.15, paritySearch: false },
  hard: { tickMs: 0, attackRate: 0.42, skipRate: 0, huntSloppiness: 0, paritySearch: true },
} as const;

/** Paint a solid rectangle of `color` into a fresh stencil — a stand-in secret
 *  shape spread to one side of the board (left for A, right for B). */
function rectTarget(
  color: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): Uint8Array {
  const t = new Uint8Array(SIM_BOARD.width * SIM_BOARD.height);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) t[y * SIM_BOARD.width + x] = color;
  }
  return t;
}

/**
 * Drive one full bot-vs-bot duel to terminal (or a hard step cap), applying the
 * same fog rules the hook applies: an attack reveals; a hit (probe lands in the
 * FOE shape) blocks. Records, per seat, every probe and whether it hit. The
 * planner is fed ONLY (ownTarget, revealed, blocked) — never the foe shape — so
 * any hits it lands are earned by blind search/hunt, the behavior under test.
 */
function simDuel(
  seed: number,
  difficulty: "easy" | "normal" | "hard",
  maxSteps = 20000,
) {
  const proto = new PixelPaintProtocol({
    ...SIM_BOARD,
    cap: 2400,
    overwriteLimit: 3,
    stake: 10n,
    mode: "war",
  });
  let state = proto.initialState({
    tunnelId: "0xsim",
    initialBalances: { a: 100n, b: 100n },
  });
  const size = SIM_BOARD.width * SIM_BOARD.height;
  // Spread-apart shapes: A on the left, B on the right, with a wide center gap.
  const aTarget = rectTarget(SEAT_A_COLOR, 6, 18, 10, 8);
  const bTarget = rectTarget(SEAT_B_COLOR, 80, 30, 10, 8);
  const revealed = new Uint8Array(size);
  const blocked = new Uint8Array(size);
  const rngA = mulberry32((seed ^ 0x85ebca6b) >>> 0);
  const rngB = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const profile = PROFILE[difficulty];

  const probes: Record<"A" | "B", { idx: number; hit: boolean }[]> = {
    A: [],
    B: [],
  };

  /** Apply the hook's fog classification for a placed move. Returns its kind. */
  const applyFog = (idx: number, seat: "A" | "B") => {
    const own = seat === "A" ? aTarget : bTarget;
    const foe = seat === "A" ? bTarget : aTarget;
    const kind = classifyPaint(idx, own, foe);
    if (kind === "build") return kind;
    revealed[idx] = 1;
    if (kind === "hit") blocked[idx] = 1;
    return kind;
  };

  let steps = 0;
  for (; steps < maxSteps && !proto.isTerminal(state); steps++) {
    const seat: "A" | "B" = steps % 2 === 0 ? "A" : "B";
    const own = seat === "A" ? aTarget : bTarget;
    const rng = seat === "A" ? rngA : rngB;
    const color = seat === "A" ? SEAT_A_COLOR : SEAT_B_COLOR;
    const mv = planBotMove(state, own, revealed, blocked, rng, profile, color);
    if (!mv) {
      // A null is a SKIP, not necessarily an end: easy bots dawdle (skipRate),
      // and a bot with nothing to probe still returns null without building if it
      // has finished its shape. The duel is only truly over when BOTH seats have
      // resolved every winnable own cell — building always terminates, so this is
      // the real deadlock guard (mirrors the hook's targetResolved check).
      if (
        bothResolved(state.canvas, aTarget, blocked, SEAT_A_COLOR) &&
        bothResolved(state.canvas, bTarget, blocked, SEAT_B_COLOR)
      ) {
        break;
      }
      continue;
    }
    const idx = mv.y * SIM_BOARD.width + mv.x;
    try {
      state = proto.applyMove(state, mv, seat);
    } catch {
      continue; // locked/illegal between plan and apply — skip
    }
    const kind = applyFog(idx, seat);
    if (mv.color === PROBE_COLOR) {
      // A probe is an attack; it HIT iff it landed in the foe's actual shape.
      probes[seat].push({ idx, hit: kind === "hit" });
    }
  }

  return { state, proto, probes, revealed, blocked, aTarget, bTarget, steps };
}

describe("planBotMove fairness (no foe-shape aim)", () => {
  it("does not concentrate EARLY probes on the foe's actual cells", () => {
    // Aggregate the first few probes across many seeded duels. A cheating bot
    // (reading foeTarget) would hit ~100% from move one; a fair blind bot lands
    // its first probes at roughly the foe's board density — far below 1.0.
    const EARLY = 4; // first N probes per seat per duel
    let earlyTotal = 0;
    let earlyHits = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { probes } = simDuel(seed, "hard");
      for (const seat of ["A", "B"] as const) {
        for (const p of probes[seat].slice(0, EARLY)) {
          earlyTotal++;
          if (p.hit) earlyHits++;
        }
      }
    }
    assert.ok(earlyTotal > 50, `expected a real probe sample, got ${earlyTotal}`);
    const earlyRate = earlyHits / earlyTotal;
    // The foe shape (80 cells) covers ~1.5% of the 96x56 board; even with the
    // opposite-half search bias the early hit-rate stays well under a fifth.
    // A foeTarget-aiming bot would sit at ~1.0 here.
    assert.ok(
      earlyRate < 0.2,
      `early probe hit-rate ${earlyRate.toFixed(3)} too high — bot may be aiming at the secret shape`,
    );
  });

  it("HUNTS: after a confirmed hit, later probes hit far more often than early ones", () => {
    // Fairness doesn't mean uselessness. Once `blocked` marks a real hit, the
    // blind bot concentrates fire on neighbors, so its LATE hit-rate should beat
    // its EARLY hit-rate — evidence the search-then-hunt loop actually works off
    // the public mask.
    let earlyHits = 0;
    let earlyTot = 0;
    let lateHits = 0;
    let lateTot = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { probes } = simDuel(seed, "hard");
      for (const seat of ["A", "B"] as const) {
        const ps = probes[seat];
        ps.slice(0, 4).forEach((p) => {
          earlyTot++;
          if (p.hit) earlyHits++;
        });
        // "Late" = probes once the bot has had time to find and exploit a hit.
        ps.slice(8).forEach((p) => {
          lateTot++;
          if (p.hit) lateHits++;
        });
      }
    }
    assert.ok(lateTot > 20 && earlyTot > 20, "need both samples populated");
    const early = earlyHits / earlyTot;
    const late = lateHits / lateTot;
    assert.ok(
      late > early,
      `hunt did not improve hit-rate: early ${early.toFixed(3)} vs late ${late.toFixed(3)}`,
    );
  });

  it("reaches a terminal duel for every difficulty (no deadlock)", () => {
    for (const diff of ["easy", "normal", "hard"] as const) {
      for (let seed = 1; seed <= 8; seed++) {
        const { state, proto, aTarget, bTarget, blocked, steps } = simDuel(
          seed,
          diff,
        );
        // Either the protocol settled, or both seats finished every winnable own
        // cell (the build half always terminates regardless of probing).
        const aBuilt = bothResolved(state.canvas, aTarget, blocked, SEAT_A_COLOR);
        const bBuilt = bothResolved(state.canvas, bTarget, blocked, SEAT_B_COLOR);
        assert.ok(
          proto.isTerminal(state) || (aBuilt && bBuilt),
          `${diff} seed ${seed}: not terminal after ${steps} steps`,
        );
      }
    }
  });

  it("scores BOTH seats to a real, completable shape (sim sanity)", () => {
    // A full hard duel should leave each seat having BUILT most of its own shape
    // (probing never starves building), so the fog score is meaningfully > 0.
    const { state, aTarget, bTarget, blocked } = simDuel(7, "hard");
    const a = scoreDuelFog(state.canvas, aTarget, blocked);
    const b = scoreDuelFog(state.canvas, bTarget, blocked);
    assert.ok(a.pct > 0.5, `seat A only reached ${a.pct.toFixed(2)} of its shape`);
    assert.ok(b.pct > 0.5, `seat B only reached ${b.pct.toFixed(2)} of its shape`);
  });
});

describe("symmetric build-free / attack-gated cooldown", () => {
  // own[0] is in MY shape (build), own[1]/own[2] are empty for me; foe[1] is in
  // the foe shape (so painting cell 1 = a HIT), foe[2] is empty for both (a MISS).
  const own = Uint8Array.of(SEAT_A_COLOR, 0, 0);
  const foe = Uint8Array.of(0, SEAT_B_COLOR, 0);

  it("charges NO cooldown for a build (cell in the painter's own shape)", () => {
    assert.strictEqual(classifyPaint(0, own, foe), "build");
    assert.strictEqual(attackCooldownMs("build"), 0);
    // The whole point: building never pays, so it's never blocked by a pending
    // attack cooldown — same for human and bot.
    assert.strictEqual(attackCooldownMs(classifyPaint(0, own, foe)), 0);
  });

  it("charges exactly COOLDOWN_MS for a hit (attack landing in the foe shape)", () => {
    assert.strictEqual(classifyPaint(1, own, foe), "hit");
    assert.strictEqual(attackCooldownMs("hit"), COOLDOWN_MS);
    assert.strictEqual(attackCooldownMs(classifyPaint(1, own, foe)), COOLDOWN_MS);
  });

  it("charges COOLDOWN_MS + MISS_PENALTY_MS for a miss (attack into empty space)", () => {
    assert.strictEqual(classifyPaint(2, own, foe), "miss");
    assert.strictEqual(
      attackCooldownMs("miss"),
      COOLDOWN_MS + MISS_PENALTY_MS,
    );
    assert.strictEqual(
      attackCooldownMs(classifyPaint(2, own, foe)),
      COOLDOWN_MS + MISS_PENALTY_MS,
    );
  });

  it("applies the SAME rule regardless of seat (build free, attacks gated)", () => {
    // Swap the roles: now the foe's stencil is the painter's own. A cell in the
    // new owner's shape must still be a free build; the rule is seat-agnostic.
    assert.strictEqual(attackCooldownMs(classifyPaint(1, foe, own)), 0); // build
    assert.strictEqual(attackCooldownMs(classifyPaint(0, foe, own)), COOLDOWN_MS); // hit
  });
});

describe("player placement color (symmetric probes)", () => {
  // Seat A wants color 14 at cell 0; cells 1 (in the foe shape) and 2 (empty)
  // are OFF A's own shape, so painting either is an ATTACK.
  const ownA = Uint8Array.of(SEAT_A_COLOR, 0, 0);

  it("paints a BUILD (cell in your own shape) in your seat color", () => {
    assert.strictEqual(classifyPaint(0, ownA, ownA), "build");
    assert.strictEqual(placementColor(0, ownA, SEAT_A_COLOR), SEAT_A_COLOR);
  });

  it("paints an ATTACK (cell off your shape) in the neutral probe color", () => {
    // A HIT and a MISS are both attacks — both land off your own target — so both
    // carry PROBE_COLOR, identical to the bot's probes and never your win color.
    assert.strictEqual(placementColor(1, ownA, SEAT_A_COLOR), PROBE_COLOR);
    assert.strictEqual(placementColor(2, ownA, SEAT_A_COLOR), PROBE_COLOR);
    assert.notStrictEqual(placementColor(1, ownA, SEAT_A_COLOR), SEAT_A_COLOR);
  });
});

/** Every winnable (wanted, unblocked) cell of `target` is painted `seatColor`. */
function bothResolved(
  canvas: Uint8Array,
  target: Uint8Array,
  blocked: Uint8Array,
  seatColor: number,
): boolean {
  for (let i = 0; i < target.length; i++) {
    if (target[i] === 0 || blocked[i]) continue;
    if (canvas[i] !== seatColor) return false;
  }
  return true;
}

describe("scoreDuel", () => {
  it("scores every wanted cell correct as 100%", () => {
    const target = Uint8Array.of(0, 6, 0, 14, 6);
    const canvas = Uint8Array.of(3, 6, 0, 14, 6); // off-target cell 0 ignored
    const s = scoreDuel(canvas, target);
    assert.strictEqual(s.total, 3);
    assert.strictEqual(s.correct, 3);
    assert.strictEqual(s.pct, 1);
  });

  it("counts only matching colors, not just any paint (partial)", () => {
    const target = Uint8Array.of(6, 6, 6, 6); // wants 4 cells, all color 6
    const canvas = Uint8Array.of(6, 6, 9, 0); // 2 right, 1 wrong color, 1 empty
    const s = scoreDuel(canvas, target);
    assert.strictEqual(s.total, 4);
    assert.strictEqual(s.correct, 2);
    assert.strictEqual(s.pct, 0.5);
  });

  it("ignores don't-care cells when computing the total", () => {
    const target = Uint8Array.of(0, 0, 14, 0, 14);
    const canvas = Uint8Array.of(6, 9, 14, 3, 1); // both wanted cells: 1 right
    const s = scoreDuel(canvas, target);
    assert.strictEqual(s.total, 2);
    assert.strictEqual(s.correct, 1);
    assert.strictEqual(s.pct, 0.5);
  });

  it("yields equal pct for a tie between two sides at different totals", () => {
    // You: 1 of 2 right (50%). Bot: 2 of 4 right (50%). Same pct, a draw.
    const you = scoreDuel(Uint8Array.of(6, 9, 0, 0), Uint8Array.of(6, 6, 0, 0));
    const bot = scoreDuel(
      Uint8Array.of(14, 14, 9, 0),
      Uint8Array.of(14, 14, 14, 14),
    );
    assert.strictEqual(you.pct, 0.5);
    assert.strictEqual(bot.pct, 0.5);
    assert.strictEqual(you.pct, bot.pct);
  });

  it("returns 0% (not NaN) for an empty target", () => {
    const s = scoreDuel(Uint8Array.of(6, 9, 14), Uint8Array.of(0, 0, 0));
    assert.strictEqual(s.total, 0);
    assert.strictEqual(s.correct, 0);
    assert.strictEqual(s.pct, 0);
  });

  it("throws on a canvas/target length mismatch", () => {
    assert.throws(() => scoreDuel(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2)));
  });
});

describe("scoreDuelFog", () => {
  it("counts painted seat-color cells that aren't enemy-blocked", () => {
    // Target wants 3 cells in seat color 14; none blocked; 2 painted right.
    const target = Uint8Array.of(14, 14, 14, 0);
    const canvas = Uint8Array.of(14, 14, 0, 5); // off-target cell 3 ignored
    const blocked = Uint8Array.of(0, 0, 0, 0);
    const s = scoreDuelFog(canvas, target, blocked);
    assert.strictEqual(s.total, 3);
    assert.strictEqual(s.correct, 2);
    assert.ok(Math.abs(s.pct - 2 / 3) < 1e-9);
  });

  it("excludes enemy-blocked cells from BOTH correct and the goal total", () => {
    // 4 wanted cells; the enemy blocked one (index 3). That cell drops from the
    // denominator entirely, so the achievable goal is the 3 unblocked cells.
    const target = Uint8Array.of(14, 14, 14, 14);
    const canvas = Uint8Array.of(14, 14, 0, 14); // cell 3 painted but blocked
    const blocked = Uint8Array.of(0, 0, 0, 1);
    const s = scoreDuelFog(canvas, target, blocked);
    assert.strictEqual(s.total, 3); // blocked cell 3 removed from the goal
    assert.strictEqual(s.correct, 2); // cell 3's paint can't count
    assert.ok(Math.abs(s.pct - 2 / 3) < 1e-9);
  });

  it("does not count a cell painted in the WRONG (enemy) color", () => {
    // Seat A wants color 14; an enemy overpaint left cell 1 as color 5.
    const target = Uint8Array.of(14, 14, 14, 0);
    const canvas = Uint8Array.of(14, 5, 14, 0);
    const blocked = Uint8Array.of(0, 0, 0, 0);
    const s = scoreDuelFog(canvas, target, blocked);
    assert.strictEqual(s.total, 3);
    assert.strictEqual(s.correct, 2);
  });

  it("reaches 100% once every UNBLOCKED target cell is seat-colored", () => {
    // 3 wanted, 1 blocked; the 2 unblocked are both painted -> a perfect run.
    const target = Uint8Array.of(5, 5, 5);
    const canvas = Uint8Array.of(5, 5, 0);
    const blocked = Uint8Array.of(0, 0, 1);
    const s = scoreDuelFog(canvas, target, blocked);
    assert.strictEqual(s.total, 2);
    assert.strictEqual(s.correct, 2);
    assert.strictEqual(s.pct, 1);
  });

  it("returns 0% (not NaN) when every target cell is blocked", () => {
    const target = Uint8Array.of(14, 14);
    const canvas = Uint8Array.of(14, 14);
    const blocked = Uint8Array.of(1, 1);
    const s = scoreDuelFog(canvas, target, blocked);
    assert.strictEqual(s.total, 0);
    assert.strictEqual(s.correct, 0);
    assert.strictEqual(s.pct, 0);
  });

  it("throws on any array length mismatch", () => {
    assert.throws(() =>
      scoreDuelFog(
        Uint8Array.of(1, 2, 3),
        Uint8Array.of(1, 2, 3),
        Uint8Array.of(1, 2),
      ),
    );
  });
});
