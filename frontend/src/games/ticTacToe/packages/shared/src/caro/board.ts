/**
 * Caro (gomoku) board primitives. The board is a flat `size*size` array of marks
 * (0 empty, 1 party A, 2 party B). Win-check is O(1): it scans outward from the cell
 * just played, so it scales to any board size.
 */

export type CaroBoard = number[]; // length size*size, values 0|1|2

// The four axes to test for a run: horizontal, vertical, and both diagonals.
export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

export function inBounds(size: number, r: number, c: number): boolean {
  return r >= 0 && r < size && c >= 0 && c < size;
}

/** Pure: a copy of `board` with `idx` set to `mark`. */
export function applyMark(
  board: CaroBoard,
  idx: number,
  mark: number,
): CaroBoard {
  const next = board.slice();
  next[idx] = mark;
  return next;
}

export function isFull(board: CaroBoard): boolean {
  return board.every((v) => v !== 0);
}

/**
 * If the mark at `idx` completes a winning run along any axis, return that mark;
 * otherwise 0. Only scans around `idx`, so cost is O(1) per move. Returns 0 if `idx`
 * is out of range or empty.
 *
 * Standard caro rules (not free-style): the run must be EXACTLY five — an overline of
 * six or more does not win — and it must not be flanked by the opponent on BOTH ends.
 * The board edge is an open end, not a block: only an opponent stone blocks.
 */
export function winnerAround(
  board: CaroBoard,
  size: number,
  idx: number,
): number {
  if (idx < 0 || idx >= size * size) return 0;
  const mark = board[idx];
  if (mark === 0) return 0;
  const r0 = Math.floor(idx / size);
  const c0 = idx % size;
  for (const [dr, dc] of DIRS) {
    let count = 1;
    let r = r0 + dr;
    let c = c0 + dc;
    while (inBounds(size, r, c) && board[r * size + c] === mark) {
      count++;
      r += dr;
      c += dc;
    }
    // (r, c) is the cell just past the forward end. A non-empty cell here is the
    // opponent (the run stopped, so it is not `mark`); the edge leaves it in-bounds-false.
    const forwardBlocked = inBounds(size, r, c) && board[r * size + c] !== 0;
    r = r0 - dr;
    c = c0 - dc;
    while (inBounds(size, r, c) && board[r * size + c] === mark) {
      count++;
      r -= dr;
      c -= dc;
    }
    const backwardBlocked = inBounds(size, r, c) && board[r * size + c] !== 0;
    if (count === 5 && !(forwardBlocked && backwardBlocked)) return mark;
  }
  return 0;
}

/**
 * The cells of the winning five through `idx`, or `[]` if the last move does not win.
 * Matches {@link winnerAround}'s standard-caro rule (exactly five, not flanked on both
 * ends), so the UI can call it every render and only highlights an actual win.
 */
export function winningLine(
  board: CaroBoard,
  size: number,
  idx: number,
): number[] {
  if (idx < 0 || idx >= size * size) return [];
  const mark = board[idx];
  if (mark === 0) return [];
  const r0 = Math.floor(idx / size);
  const c0 = idx % size;
  for (const [dr, dc] of DIRS) {
    const line = [idx];
    let r = r0 + dr;
    let c = c0 + dc;
    while (inBounds(size, r, c) && board[r * size + c] === mark) {
      line.push(r * size + c);
      r += dr;
      c += dc;
    }
    const forwardBlocked = inBounds(size, r, c) && board[r * size + c] !== 0;
    r = r0 - dr;
    c = c0 - dc;
    while (inBounds(size, r, c) && board[r * size + c] === mark) {
      line.push(r * size + c);
      r -= dr;
      c -= dc;
    }
    const backwardBlocked = inBounds(size, r, c) && board[r * size + c] !== 0;
    if (line.length === 5 && !(forwardBlocked && backwardBlocked)) return line;
  }
  return [];
}
