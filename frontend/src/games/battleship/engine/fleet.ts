/**
 * Battleship fleet model and board legality — pure geometry, no IO.
 *
 * A board is a flat `Uint8Array(100)`, row-major (index = row*10 + col), with
 * `1` = ship cell and `0` = water. Ships are placed by an anchor cell (the
 * top-most / left-most cell) plus an orientation. We enforce the classic Milton
 * Bradley rule that ships may not touch — not even diagonally — which makes a
 * board's decomposition into ships unambiguous (each 4-connected run of ship
 * cells is exactly one ship), so {@link isLegalBoard} can validate a revealed
 * board without trusting how it was built.
 */

export const BOARD_SIZE = 10;
export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;

export interface ShipSpec {
  /** Stable id, unique within the fleet (two size-3 ships need distinct ids). */
  readonly id: string;
  readonly name: string;
  readonly size: number;
}

/** Standard fleet: 5 ships, 17 cells total. */
export const FLEET: readonly ShipSpec[] = [
  { id: "carrier", name: "Carrier", size: 5 },
  { id: "battleship", name: "Battleship", size: 4 },
  { id: "cruiser", name: "Cruiser", size: 3 },
  { id: "submarine", name: "Submarine", size: 3 },
  { id: "destroyer", name: "Destroyer", size: 2 },
];

/** Total ship cells across the fleet — a player loses when all are hit. */
export const FLEET_CELLS = FLEET.reduce((n, s) => n + s.size, 0);

export type Orientation = "H" | "V";

export interface Placement {
  /** Matches a {@link ShipSpec.id}. */
  readonly id: string;
  /** Anchor cell (0..99); ship extends right (H) or down (V) from here. */
  readonly cell: number;
  readonly orient: Orientation;
}

export function rowOf(cell: number): number {
  return Math.floor(cell / BOARD_SIZE);
}
export function colOf(cell: number): number {
  return cell % BOARD_SIZE;
}
export function cellAt(row: number, col: number): number {
  return row * BOARD_SIZE + col;
}
export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function specOf(id: string): ShipSpec {
  const spec = FLEET.find((s) => s.id === id);
  if (!spec) throw new Error(`unknown ship id: ${id}`);
  return spec;
}

/**
 * Cells a placement occupies. Returns `null` if any cell is out of bounds, so
 * callers get one clear signal for "this placement doesn't fit".
 */
export function placementCells(p: Placement): number[] | null {
  const { size } = specOf(p.id);
  const r0 = rowOf(p.cell);
  const c0 = colOf(p.cell);
  const cells: number[] = [];
  for (let i = 0; i < size; i++) {
    const r = p.orient === "V" ? r0 + i : r0;
    const c = p.orient === "H" ? c0 + i : c0;
    if (!inBounds(r, c)) return null;
    cells.push(cellAt(r, c));
  }
  return cells;
}

/** True iff every cell within Chebyshev distance 1 of `cell` that is a ship belongs to a *different* placement than `cell`'s. */
function diagonalNeighbors(cell: number): number[] {
  const r = rowOf(cell);
  const c = colOf(cell);
  const out: number[] = [];
  for (const [dr, dc] of [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ] as const) {
    if (inBounds(r + dr, c + dc)) out.push(cellAt(r + dr, c + dc));
  }
  return out;
}

/**
 * A fleet of placements is legal iff it contains exactly the standard fleet
 * (one of each ship), every ship fits on the board, and no two ships overlap or
 * touch (including diagonally).
 */
export function fleetIsLegal(placements: readonly Placement[]): boolean {
  if (placements.length !== FLEET.length) return false;
  const ids = new Set(placements.map((p) => p.id));
  if (ids.size !== FLEET.length) return false;
  for (const spec of FLEET) if (!ids.has(spec.id)) return false;

  const owner = new Map<number, string>(); // cell -> ship id
  for (const p of placements) {
    const cells = placementCells(p);
    if (!cells) return false;
    for (const cell of cells) {
      if (owner.has(cell)) return false; // overlap
      owner.set(cell, p.id);
    }
  }
  // No touching: a ship cell may not sit diagonally adjacent to a *different* ship.
  for (const [cell, id] of owner) {
    for (const d of diagonalNeighbors(cell)) {
      const other = owner.get(d);
      if (other !== undefined && other !== id) return false;
    }
  }
  return true;
}

/** Render placements to a flat 0/1 board. Assumes the placements fit (see {@link fleetIsLegal}). */
export function placementsToBoard(
  placements: readonly Placement[],
): Uint8Array {
  const board = new Uint8Array(CELL_COUNT);
  for (const p of placements) {
    const cells = placementCells(p);
    if (!cells) throw new Error(`placement ${p.id} is out of bounds`);
    for (const cell of cells) board[cell] = 1;
  }
  return board;
}

/** Number of ship cells on a board. */
export function shipCellCount(board: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < board.length; i++) if (board[i]) n++;
  return n;
}

function orthoNeighbors(cell: number): number[] {
  const r = rowOf(cell);
  const c = colOf(cell);
  const out: number[] = [];
  for (const [dr, dc] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    if (inBounds(r + dr, c + dc)) out.push(cellAt(r + dr, c + dc));
  }
  return out;
}

/**
 * Validate a *revealed* board (e.g. at settlement) without trusting its origin:
 * exactly {@link FLEET_CELLS} ship cells, decomposing into ships of the fleet's
 * exact sizes, each a straight contiguous run, none touching (incl. diagonally).
 * The non-touching rule means each 4-connected run is exactly one ship.
 */
export function isLegalBoard(board: Uint8Array): boolean {
  if (board.length !== CELL_COUNT) return false;
  if (shipCellCount(board) !== FLEET_CELLS) return false;

  // No diagonal contact between any two ship cells (separates ships cleanly).
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    if (!board[cell]) continue;
    for (const d of diagonalNeighbors(cell)) {
      if (board[d]) return false;
    }
  }

  // Flood-fill 4-connected components; each must be a straight line.
  const seen = new Uint8Array(CELL_COUNT);
  const sizes: number[] = [];
  for (let start = 0; start < CELL_COUNT; start++) {
    if (!board[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    const comp: number[] = [];
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const n of orthoNeighbors(cur)) {
        if (board[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    const rows = new Set(comp.map(rowOf));
    const cols = new Set(comp.map(colOf));
    if (rows.size !== 1 && cols.size !== 1) return false; // not a straight line
    sizes.push(comp.length);
  }

  const want = [...FLEET.map((s) => s.size)].sort((a, b) => a - b).join(",");
  const got = sizes.sort((a, b) => a - b).join(",");
  return want === got;
}

/**
 * Place the whole fleet at random, respecting all legality rules. Deterministic
 * for a given `rng` (a `() => number` in [0,1)). Throws only if it cannot find a
 * legal arrangement within a generous retry budget (effectively never for a
 * 10×10 board and this fleet).
 */
export function placeFleetRandom(rng: () => number): Placement[] {
  for (let attempt = 0; attempt < 200; attempt++) {
    const placements: Placement[] = [];
    const blocked = new Uint8Array(CELL_COUNT); // ship cells + their 8-neighborhood
    let ok = true;

    for (const spec of FLEET) {
      let placed = false;
      for (let tries = 0; tries < 200 && !placed; tries++) {
        const orient: Orientation = rng() < 0.5 ? "H" : "V";
        const cell = Math.floor(rng() * CELL_COUNT);
        const cells = placementCells({ id: spec.id, cell, orient });
        if (!cells) continue;
        if (cells.some((c) => blocked[c])) continue;
        for (const c of cells) {
          blocked[c] = 1;
          const r = rowOf(c);
          const col = colOf(c);
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (inBounds(r + dr, col + dc))
                blocked[cellAt(r + dr, col + dc)] = 1;
            }
          }
        }
        placements.push({ id: spec.id, cell, orient });
        placed = true;
      }
      if (!placed) {
        ok = false;
        break;
      }
    }
    if (ok) return placements;
  }
  throw new Error("could not place fleet (rng exhausted retry budget)");
}

/** Per-ship damage, in fleet order — exact for your OWN fleet (we know its placements). */
export interface ShipStatus {
  id: string;
  name: string;
  size: number;
  hits: number;
  sunk: boolean;
}

/** Status of each fleet ship given the set of its cells that have been hit. */
export function fleetStatus(
  placements: readonly Placement[],
  hitCells: ReadonlySet<number>,
): ShipStatus[] {
  return FLEET.map((spec) => {
    const p = placements.find((pl) => pl.id === spec.id);
    const cells = p ? (placementCells(p) ?? []) : [];
    const hits = cells.filter((c) => hitCells.has(c)).length;
    return {
      id: spec.id,
      name: spec.name,
      size: spec.size,
      hits,
      sunk: cells.length > 0 && hits === cells.length,
    };
  });
}

/** The cells of every fully-sunk ship — used to dim sunk vessels on the board. */
export function sunkShipCells(
  placements: readonly Placement[],
  hitCells: ReadonlySet<number>,
): Set<number> {
  const out = new Set<number>();
  for (const p of placements) {
    const cells = placementCells(p);
    if (cells && cells.length > 0 && cells.every((c) => hitCells.has(c))) {
      for (const c of cells) out.add(c);
    }
  }
  return out;
}
