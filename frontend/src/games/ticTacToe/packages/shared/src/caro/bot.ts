/**
 * Heuristic caro bot: a one-ply threat score (no minimax, which cannot scale to a large
 * board). Candidate cells are limited to the neighborhood of existing stones, and each is
 * scored by the best run it makes for the mover plus the best it denies the opponent.
 */

import { inBounds, DIRS } from "./board";
import type { CaroState } from "./protocol";

export type BotStrength = "strong" | "weak";

// Run length and its two ends, treating `idx` as if it held `mark`. `openEnds` (empty
// neighbour, edge excluded) drives extension scoring; `oppBlockedEnds` (an opponent stone,
// edge excluded) decides whether a five actually wins — matching the protocol's win rule.
function lineInfo(
  board: number[],
  size: number,
  idx: number,
  dr: number,
  dc: number,
  mark: number,
): { run: number; openEnds: number; oppBlockedEnds: number } {
  const r0 = Math.floor(idx / size);
  const c0 = idx % size;
  let run = 1;
  let r = r0 + dr;
  let c = c0 + dc;
  while (inBounds(size, r, c) && board[r * size + c] === mark) {
    run++;
    r += dr;
    c += dc;
  }
  const fwdOpen = inBounds(size, r, c) && board[r * size + c] === 0;
  const fwdOpp = inBounds(size, r, c) && board[r * size + c] !== 0;
  r = r0 - dr;
  c = c0 - dc;
  while (inBounds(size, r, c) && board[r * size + c] === mark) {
    run++;
    r -= dr;
    c -= dc;
  }
  const bwdOpen = inBounds(size, r, c) && board[r * size + c] === 0;
  const bwdOpp = inBounds(size, r, c) && board[r * size + c] !== 0;
  return {
    run,
    openEnds: (fwdOpen ? 1 : 0) + (bwdOpen ? 1 : 0),
    oppBlockedEnds: (fwdOpp ? 1 : 0) + (bwdOpp ? 1 : 0),
  };
}

function patternValue(
  run: number,
  openEnds: number,
  oppBlockedEnds: number,
): number {
  // Standard caro: only an exactly-five not flanked by the opponent on both ends wins.
  if (run === 5) return oppBlockedEnds < 2 ? 100000 : 200;
  if (run > 5) return 200; // overline: no win, just a dead cluster
  if (run === 4) return openEnds >= 1 ? 9000 : 200; // four (open or single-blocked)
  if (run === 3) return openEnds === 2 ? 1500 : 150; // open three vs blocked three
  if (run === 2) return openEnds === 2 ? 200 : 30;
  return openEnds === 2 ? 20 : 5; // lone stone, prefer open space
}

// Best single-axis pattern value for placing `mark` at `idx`.
function moveScore(
  board: number[],
  size: number,
  idx: number,
  mark: number,
): number {
  let best = 0;
  for (const [dr, dc] of DIRS) {
    const { run, openEnds, oppBlockedEnds } = lineInfo(
      board,
      size,
      idx,
      dr,
      dc,
      mark,
    );
    best = Math.max(best, patternValue(run, openEnds, oppBlockedEnds));
  }
  return best;
}

// Empty cells within Chebyshev distance `radius` of any stone.
function candidates(board: number[], size: number, radius: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== 0) continue;
    const r0 = Math.floor(i / size);
    const c0 = i % size;
    let near = false;
    for (let dr = -radius; dr <= radius && !near; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = r0 + dr;
        const c = c0 + dc;
        if (inBounds(size, r, c) && board[r * size + c] !== 0) {
          near = true;
          break;
        }
      }
    }
    if (near) out.push(i);
  }
  return out;
}

/**
 * Pick a move (flat index) for `by`. `strong` searches radius 2 and weighs offense+defense;
 * `weak` searches radius 1 with slightly less defensive weight. `rng` only breaks ties so
 * equal-scoring openings vary between games.
 */
export function pickCaroMove(
  state: CaroState,
  by: "A" | "B",
  rng: () => number,
  strength: BotStrength,
): number {
  const { board, size } = state;
  const me = by === "A" ? 1 : 2;
  const opp = me === 1 ? 2 : 1;

  if (state.movesCount === 0) return Math.floor((size * size) / 2); // center opening

  const radius = strength === "strong" ? 2 : 1;
  const defenseWeight = strength === "strong" ? 0.95 : 0.85;
  let cells = candidates(board, size, radius);
  if (cells.length === 0)
    cells = board.map((_, i) => i).filter((i) => board[i] === 0);
  if (cells.length === 0)
    throw new Error("pickCaroMove called with no legal move (full board)");

  let bestCell = cells[0];
  let bestScore = -Infinity;
  for (const i of cells) {
    const score =
      moveScore(board, size, i, me) +
      defenseWeight * moveScore(board, size, i, opp);
    // Tie-break with a small rng jitter so identical scores diversify.
    const jittered = score + rng() * 0.5;
    if (jittered > bestScore) {
      bestScore = jittered;
      bestCell = i;
    }
  }
  return bestCell;
}
