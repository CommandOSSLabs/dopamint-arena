/**
 * Battleship as a worker SELF-PLAY spec — MULTI-GAME (up to {@link MAX_GAMES} games per funded
 * tunnel). Both bot seats play commit-reveal battleship; `MultiGameBattleshipProtocol` resets to a
 * fresh fleet each game (carrying balances forward), so one open hosts many games instead of
 * settling after one (the old maxGames=1 looked like an instant settle).
 *
 * Fleets are REGENERATED per game (a fresh board + salts) and kept in a mutable holder that
 * `stepWith` drives the between-game advance through (the opener commits the new fleet, which resets
 * the board). `kickoffNextGame` can't reach the holder, so the advance lives in `stepWith` and
 * `kickoffNextGame` is a no-op.
 *
 * WINNER ENCODING: the SDK protocol's per-game winner is NUMERIC (0|1|2|3); the engine reads
 * `inner.winner` as "A"|"B"|"draw"|null. {@link SoloBattleshipProtocol} converts at the boundary
 * while delegating rules to the numeric protocol, so the co-signed state hash stays byte-identical.
 * HIDDEN-INFO: each seat's fleet secret stays in the worker; self-play applies moves locally (no codec).
 */
import { defineSoloGame } from "@/engine/specs/defineGame";
import type { SoloStepOutcome, SoloTakeIntent } from "@/engine/engineApi";
import {
  MultiGameBattleshipProtocol,
  type MultiGameBattleshipState,
  type MultiGameBattleshipMove,
} from "./protocol/multiGameBattleship";
import type { BattleshipState, Winner } from "./protocol/battleship";
import type { Party, ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";
import type { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import {
  makeFleetSecret,
  randomFleetSecret,
  nextMove,
  type FleetSecret,
} from "./engine/selfPlay";
import {
  placeFleetRandom,
  placementsToBoard,
  type Placement,
} from "./engine/fleet";
import { randomSalts } from "./engine/merkle";
import { DEFAULT_BOT_DIFFICULTY } from "./engine/bot";
import { deriveBattleshipView, type BattleshipView } from "./view";

/** Games per funded tunnel before the session settles (user-facing "watch ~100 games"). */
const MAX_GAMES = 100;
/** Per-game stake shifted loser→winner (clamped to the loser's balance by the protocol). Small so
 *  the ~100-MTPS bank funds all {@link MAX_GAMES} games before a seat could bust. */
const SOLO_STAKE = 1n;

/** Engine-facing state: `inner.winner` widened to the engine's string form. */
interface BattleshipSoloState {
  gamesPlayed: number;
  inner: Omit<BattleshipState, "winner"> & {
    winner: "A" | "B" | "draw" | null;
  };
}

// Battleship's `Winner` is 0|1|2 — no draw (a game always decides when a fleet is fully sunk).
const numToWinner = (w: Winner): "A" | "B" | "draw" | null =>
  w === 1 ? "A" : w === 2 ? "B" : null;
const winnerToNum = (w: "A" | "B" | "draw" | null): Winner =>
  w === "A" ? 1 : w === "B" ? 2 : 0;

const toSolo = (s: MultiGameBattleshipState): BattleshipSoloState => ({
  gamesPlayed: s.gamesPlayed,
  inner: { ...s.inner, winner: numToWinner(s.inner.winner) },
});
const toRaw = (s: BattleshipSoloState): MultiGameBattleshipState => ({
  gamesPlayed: s.gamesPlayed,
  inner: { ...s.inner, winner: winnerToNum(s.inner.winner) } as BattleshipState,
});

/**
 * `MultiGameBattleshipProtocol` widened so `inner.winner` is the engine's "A"|"B"|"draw"|null. Every
 * rule delegates to the numeric protocol via `toRaw`/`toSolo`, so `encodeState`/`balances`/the state
 * hash are byte-identical to the canonical protocol.
 */
class SoloBattleshipProtocol {
  readonly name = "battleship.multi.v1";
  private readonly mg: MultiGameBattleshipProtocol;
  constructor(stake: bigint) {
    this.mg = new MultiGameBattleshipProtocol(stake);
  }
  initialState(ctx: ProtocolContext): BattleshipSoloState {
    return toSolo(this.mg.initialState(ctx));
  }
  applyMove(
    s: BattleshipSoloState,
    m: MultiGameBattleshipMove,
    by: Party,
  ): BattleshipSoloState {
    return toSolo(this.mg.applyMove(toRaw(s), m, by));
  }
  encodeState(s: BattleshipSoloState): Uint8Array {
    return this.mg.encodeState(toRaw(s));
  }
  balances(s: BattleshipSoloState) {
    return this.mg.balances(toRaw(s));
  }
  isTerminal(s: BattleshipSoloState): boolean {
    return this.mg.isTerminal(toRaw(s));
  }
}

/** Mutable per-tunnel fleet holder: the current game's secrets + seat-A placements (for the view),
 *  regenerated each game by `stepWith`'s between-game advance. */
interface FleetHolder {
  secrets: { A: FleetSecret; B: FleetSecret };
  placementsA: Placement[];
  regenerate(): void;
}

function makeFleetHolder(): FleetHolder {
  const make = () => {
    const placements = placeFleetRandom(Math.random);
    const A = makeFleetSecret(placementsToBoard(placements), randomSalts());
    const B = randomFleetSecret(Math.random);
    return { secrets: { A, B }, placementsA: placements };
  };
  const holder = make() as FleetHolder;
  holder.regenerate = () => {
    const m = make();
    holder.secrets = m.secrets;
    holder.placementsA = m.placementsA;
  };
  return holder;
}

export const battleshipSoloSpec = defineSoloGame({
  game: "battleship",
  stake: SOLO_STAKE,
  rematchMs: 300,
  makeProtocol: () => new SoloBattleshipProtocol(SOLO_STAKE),
  makeBots: makeFleetHolder,
  // Spectate from seat A: A's real fleet (its placements) + the public shot results. `deriveBattleshipView`
  // wants the NUMERIC inner state, so convert back via `toRaw`.
  deriveView: (
    state: BattleshipSoloState,
    fleets?: FleetHolder,
  ): BattleshipView => {
    const inner = toRaw(state).inner;
    const lastYourShot = inner.shotsAtB.length
      ? inner.shotsAtB[inner.shotsAtB.length - 1].cell
      : null;
    const lastEnemyShot = inner.shotsAtA.length
      ? inner.shotsAtA[inner.shotsAtA.length - 1].cell
      : null;
    return deriveBattleshipView(inner, fleets?.placementsA ?? [], "A", {
      lastYourShot,
      lastEnemyShot,
      onChain: true,
    });
  },
  sessionResult: (inner: BattleshipSoloState["inner"]) =>
    inner.winner ?? "draw",
  stepWith: (
    protocol: SoloBattleshipProtocol,
    tunnel: OffchainTunnel<BattleshipSoloState, MultiGameBattleshipMove>,
    fleets: FleetHolder,
    _take: SoloTakeIntent<never> | null,
  ): SoloStepOutcome => {
    const state = tunnel.state;
    if (state.inner.winner !== null) {
      // A game finished. Stop at the game cap or when a seat can't fund the next stake; otherwise
      // advance to a fresh game — regenerate fleets and let the opener's commit reset the board.
      if (state.gamesPlayed + 1 >= MAX_GAMES || protocol.isTerminal(state)) {
        return "session-over";
      }
      fleets.regenerate();
      tunnel.step(
        { type: "commit", root: fleets.secrets.A.commitment.root },
        "A",
      );
      return "stepped";
    }
    const driven = nextMove(
      toRaw(state).inner,
      fleets.secrets,
      Math.random,
      DEFAULT_BOT_DIFFICULTY,
    );
    if (!driven) return "session-over";
    tunnel.step(driven.move, driven.by);
    return "stepped";
  },
  kickoffNextGame: () => {},
});
