import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  CELL_COUNT,
  type Placement,
  type ShipStatus,
  fleetStatus,
  placementsToBoard,
  sunkShipCells,
} from "./engine/fleet";
import type { BattleshipState } from "sui-tunnel-ts/protocol/battleship";

/** What to paint in a single grid square. `sunk` is a hit cell of a fully-sunk ship. */
export type CellView = "water" | "ship" | "hit" | "miss" | "sunk";

export interface BattleshipView {
  phase: BattleshipState["phase"];
  myTurn: boolean;
  /** Outcome from this seat's perspective once the game ends. */
  outcome: "win" | "lose" | null;
  /** Your fleet under fire: your ships plus the foe's shots. */
  ownCells: CellView[];
  /** Enemy waters: your shots' results; ships stay hidden until hit. */
  enemyCells: CellView[];
  /** Per-ship status of YOUR fleet (intact / damaged / sunk), in fleet order. */
  fleet: ShipStatus[];
  /** Placements of your ships, to render detailed sprites on your board. */
  placements: readonly Placement[];
  /** Confirmed hits you've landed / taken (each fleet sinks at 17). */
  hitsOnEnemy: number;
  hitsOnYou: number;
  /** Shots you've fired (for accuracy in the result screen). */
  yourShots: number;
  lastYourShot: number | null;
  lastEnemyShot: number | null;
  /** True once a real on-chain tunnel backs the game (vs the no-wallet demo). */
  onChain: boolean;
}

export interface ViewExtras {
  lastYourShot: number | null;
  lastEnemyShot: number | null;
  onChain: boolean;
}

/**
 * Project the public game state onto one seat's screen. `role` is which side the
 * local player is (A in vs-bot; either side in PvP); `myPlacements` is that
 * player's own fleet — the only fleet this client knows. The enemy board is shown
 * only through revealed hit/miss results, never its ships. Sunk ships (yours) are
 * dimmed, and `fleet` reports each of your ships' damage.
 */
export function deriveBattleshipView(
  state: BattleshipState,
  myPlacements: readonly Placement[],
  role: Party,
  extra: ViewExtras,
): BattleshipView {
  const shotsAtMe = role === "A" ? state.shotsAtA : state.shotsAtB;
  const myShots = role === "A" ? state.shotsAtB : state.shotsAtA;
  const hitsOnMe = role === "A" ? state.hitsOnA : state.hitsOnB;
  const hitsOnEnemy = role === "A" ? state.hitsOnB : state.hitsOnA;

  const board = placementsToBoard(myPlacements);
  const incoming = new Map<number, boolean>(
    shotsAtMe.map((s) => [s.cell, s.isHit]),
  );
  const outgoing = new Map<number, boolean>(
    myShots.map((s) => [s.cell, s.isHit]),
  );
  const hitOnMeCells = new Set<number>(
    shotsAtMe.filter((s) => s.isHit).map((s) => s.cell),
  );
  const sunk = sunkShipCells(myPlacements, hitOnMeCells);

  const ownCells: CellView[] = new Array(CELL_COUNT);
  const enemyCells: CellView[] = new Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i++) {
    if (incoming.has(i)) {
      ownCells[i] = incoming.get(i) ? (sunk.has(i) ? "sunk" : "hit") : "miss";
    } else {
      ownCells[i] = board[i] === 1 ? "ship" : "water";
    }
    if (outgoing.has(i)) enemyCells[i] = outgoing.get(i) ? "hit" : "miss";
    else enemyCells[i] = "water";
  }

  const iWon = state.winner === (role === "A" ? 1 : 2);
  return {
    phase: state.phase,
    myTurn:
      state.phase === "playing" &&
      state.turn === role &&
      !state.pendingShot &&
      state.winner === 0,
    outcome: state.winner === 0 ? null : iWon ? "win" : "lose",
    ownCells,
    enemyCells,
    fleet: fleetStatus(myPlacements, hitOnMeCells),
    placements: myPlacements,
    hitsOnEnemy,
    hitsOnYou: hitsOnMe,
    yourShots: myShots.length,
    lastYourShot: extra.lastYourShot,
    lastEnemyShot: extra.lastEnemyShot,
    onChain: extra.onChain,
  };
}
