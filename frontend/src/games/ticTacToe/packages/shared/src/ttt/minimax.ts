import { Board, legalMoves, winner } from "./board";
import { CELL_PLAYER, CELL_SERVER } from "../constants";

const other = (p: number): number => (p === CELL_PLAYER ? CELL_SERVER : CELL_PLAYER);

// Score from `me`'s perspective: faster wins score higher, faster losses lower.
function minimaxScore(board: Board, me: number, toMove: number, depth: number): number {
  const w = winner(board);
  if (w === me) return 10 - depth;
  if (w !== 0) return depth - 10;
  const moves = legalMoves(board);
  if (moves.length === 0) return 0; // draw
  if (toMove === me) {
    let best = -Infinity;
    for (const m of moves) {
      const b = board.slice(); b[m] = toMove;
      best = Math.max(best, minimaxScore(b, me, other(toMove), depth + 1));
    }
    return best;
  }
  let worst = Infinity;
  for (const m of moves) {
    const b = board.slice(); b[m] = toMove;
    worst = Math.min(worst, minimaxScore(b, me, other(toMove), depth + 1));
  }
  return worst;
}

// All empty cells that achieve the best minimax value for `player`, ascending.
export function optimalMoves(board: Board, player: number): number[] {
  const moves = legalMoves(board); // ascending
  let best = -Infinity;
  const scored: { cell: number; score: number }[] = [];
  for (const m of moves) {
    const b = board.slice(); b[m] = player;
    const score = minimaxScore(b, player, other(player), 1);
    scored.push({ cell: m, score });
    if (score > best) best = score;
  }
  return scored.filter((s) => s.score === best).map((s) => s.cell);
}
