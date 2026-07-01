import test from "node:test";
import assert from "node:assert/strict";

import { arenaIdsExcludingResuming } from "./arenaAllocationSkip";

// The resume flow keys games by the hook's kebab resume key; allocation enumerates underscore arena
// ids. A game being resumed must be dropped from the allocate set despite the separator difference —
// otherwise the reload opens a second tunnel and strands its stake. This is the underscore/kebab
// footgun the whole helper exists to get right.
test("drops a resuming game whose resume key differs only by separator", () => {
  const arenaIds = ["quantum_poker", "bomb_it", "blackjack"];
  // quantum-poker is mid-match (kebab resume key); the other two are not.
  const kept = arenaIdsExcludingResuming(arenaIds, ["quantum-poker"]);
  assert.deepEqual(
    kept,
    ["bomb_it", "blackjack"],
    "quantum_poker is resuming → not re-allocated; others still allocate",
  );
});

test("keeps every game when nothing is resuming", () => {
  const arenaIds = ["quantum_poker", "bomb_it", "caro"];
  assert.deepEqual(arenaIdsExcludingResuming(arenaIds, []), arenaIds);
});

// caro's arena id and resume key are identical (`caro`) — the match must still hold with no separator
// to strip, and it is the only tic-tac-toe-module variant the batch enumerates.
test("drops caro (arena id == resume key, no separator)", () => {
  assert.deepEqual(arenaIdsExcludingResuming(["caro", "bomb_it"], ["caro"]), [
    "bomb_it",
  ]);
});

// An unrelated resume key must not accidentally suppress a different game (e.g. `caro` must not drop
// `chicken_cross` just because canonicalization collapses separators).
test("a resume key never suppresses an unrelated game", () => {
  assert.deepEqual(
    arenaIdsExcludingResuming(["chicken_cross", "world_canvas"], ["caro"]),
    ["chicken_cross", "world_canvas"],
  );
});
