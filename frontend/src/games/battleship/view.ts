import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  CELL_COUNT,
  type Placement,
  type ShipStatus,
  fleetStatus,
  placementsToBoard,
  sunkShipCells,
} from "./engine/fleet";
import type { BattleshipState } from "./protocol/battleship";

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

/** One bot's side of an auto match: its own fleet revealed, with the foe's shots on it. */
export interface AutoSeatView {
  /** This bot's fleet, fully revealed, with incoming shots overlaid (hit/miss/sunk). */
  cells: CellView[];
  fleet: ShipStatus[];
  placements: readonly Placement[];
  /** Confirmed hits taken (this bot loses at FLEET_CELLS). */
  hitsTaken: number;
  shotsFired: number;
  /** The foe's most recent shot at this bot, for the splash highlight. */
  lastIncoming: number | null;
}

/** Why a continuous auto-play run ended ("funds" = a bot is low on gas). */
export type AutoEndReason = "stopped" | "funds";

/** The on-chain step of the current match (each match opens + settles a real tunnel). */
export type AutoStage = "opening" | "playing" | "settling";

/** Spectator projection of a bot-vs-bot match: BOTH fleets are revealed. */
export interface BattleshipAutoView {
  phase: BattleshipState["phase"];
  /** Whose shot is next. */
  turn: Party;
  /** 0 none, 1 A, 2 B. */
  winner: BattleshipState["winner"];
  a: AutoSeatView;
  b: AutoSeatView;
  onChain: boolean;
  /** True while a continuous run is looping new matches (vs. a finished/idle run). */
  auto: boolean;
  /** Where the current match is in its on-chain lifecycle. */
  stage: AutoStage;
  /** Matches each bot has won this run. */
  score: { a: number; b: number };
  /** 1-based index of the match on screen. */
  match: number;
  /** Each bot's on-chain gas balance, in MIST. */
  balance: { a: number; b: number };
  /** Set once the loop has ended, explaining why (else null while running). */
  endReason: AutoEndReason | null;
}

export interface AutoViewExtras {
  /** A's most recent shot (lands on B's board). */
  lastShotByA: number | null;
  /** B's most recent shot (lands on A's board). */
  lastShotByB: number | null;
  onChain: boolean;
  auto: boolean;
  stage: AutoStage;
  score: { a: number; b: number };
  match: number;
  balance: { a: number; b: number };
  endReason: AutoEndReason | null;
}

/**
 * Project the public state for a spectator watching two bots. Both fleets are
 * known here (the auto session owns both), so unlike {@link deriveBattleshipView}
 * this reveals each board in full — it's built by projecting from each seat.
 */
export function deriveBattleshipAutoView(
  state: BattleshipState,
  aPlacements: readonly Placement[],
  bPlacements: readonly Placement[],
  extra: AutoViewExtras,
): BattleshipAutoView {
  const a = deriveBattleshipView(state, aPlacements, "A", {
    lastYourShot: extra.lastShotByA,
    lastEnemyShot: extra.lastShotByB, // B fires at A
    onChain: extra.onChain,
  });
  const b = deriveBattleshipView(state, bPlacements, "B", {
    lastYourShot: extra.lastShotByB,
    lastEnemyShot: extra.lastShotByA, // A fires at B
    onChain: extra.onChain,
  });
  return {
    phase: state.phase,
    turn: state.turn,
    winner: state.winner,
    onChain: extra.onChain,
    auto: extra.auto,
    stage: extra.stage,
    score: extra.score,
    match: extra.match,
    balance: extra.balance,
    endReason: extra.endReason,
    a: {
      cells: a.ownCells,
      fleet: a.fleet,
      placements: a.placements,
      hitsTaken: a.hitsOnYou,
      shotsFired: a.yourShots,
      lastIncoming: extra.lastShotByB,
    },
    b: {
      cells: b.ownCells,
      fleet: b.fleet,
      placements: b.placements,
      hitsTaken: b.hitsOnYou,
      shotsFired: b.yourShots,
      lastIncoming: extra.lastShotByA,
    },
  };
}
