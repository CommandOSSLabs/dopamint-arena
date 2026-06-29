/**
 * Blackjack as a worker SELF-PLAY spec (the solo-lane sibling of `usePvpBlackjack`, on the shared
 * `SoloEngine`). Reuses blackjack's canonical pieces verbatim: `BlackjackProtocol` for the rules,
 * `actorFor` for turn order, and `createBlackjackKit`'s bots (which mint commits / reveal / bet
 * MIN_BET / basic-strategy hit-stand via the protocol's `randomMove`). The generic `SoloEngine` owns
 * the rest — the one-signature open+fund of both ephemeral seats, the `OffchainTunnel.selfPlay`
 * loop, the autopilot/manual cadence, transcript, and cooperative settle.
 *
 * Seat assignment: `FIXED_PLAYER_A` pins seat A as the player every round (single-player "vs bot"),
 * so a human take-over always drives A's bet/hit-stand and the inner.winner maps cleanly to a seat.
 *
 * NO moveCodec: self-play co-signs only the secret-free `encodeState` hash (see blackjackSoloCore).
 * ONE multi-round match per tunnel: `kickoffNextGame` is unreachable.
 */
import { defineSoloGame } from "@/engine/specs/defineGame";
import type { SoloGameSpec } from "@/engine/engineApi";
import {
  BlackjackProtocol,
  actorFor,
  FIXED_PLAYER_A,
  MIN_BET,
  type BlackjackState,
  type BlackjackMove,
} from "sui-tunnel-ts/protocol/blackjack";
import type { Party, ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";
import { createBlackjackKit } from "@/agent/games/blackjack/kit";
import type { GameBot } from "@/agent/gameKit";
import {
  toSoloBj,
  deriveBjView,
  bjSessionResult,
  stepBlackjackSolo,
  kickoffNextGameBj,
  type SoloBjState,
  type BjView,
  type BjResult,
  type BjWinner,
} from "./blackjackSoloCore";

/** Turn-based card game: manual play co-signs one tick per this so a takeover decision is readable. */
const BJ_MANUAL_STEP_MS = 400;

export type BjBots = Record<Party, GameBot<BlackjackState, BlackjackMove>>;

/** Build the per-seat kit bots — shared by the worker spec and the legacy session hook so both lanes
 *  drive identical bot behaviour (the kit is the single source of bot moves). */
export function makeBjBots(stakePerGame: bigint): BjBots {
  const kit = createBlackjackKit(stakePerGame, FIXED_PLAYER_A);
  return {
    A: kit.createBot("A", { rngForSeat: () => Math.random }),
    B: kit.createBot("B", { rngForSeat: () => Math.random }),
  };
}

/**
 * `BlackjackProtocol` augmented with the engine's {@link SoloBjState} fields. It reimplements NO
 * rules — `initialState`/`applyMove` delegate to `super`, then attach `gamesPlayed` (= round) and
 * `inner.winner` (the final-balance match winner, null until terminal). `encodeState`/`balances`/
 * `isTerminal` are inherited unchanged (they read named `BlackjackState` fields and ignore the
 * extras), so the co-signed state hash and on-chain-settleable balances are identical to the plain
 * protocol's.
 */
export class SoloBlackjackProtocol extends BlackjackProtocol {
  constructor() {
    super(FIXED_PLAYER_A);
  }

  /** The decided MATCH winner by final balances once terminal; null while it runs. */
  private decide(s: BlackjackState): BjWinner {
    if (!this.isTerminal(s)) return null;
    if (s.balanceA > s.balanceB) return "A";
    if (s.balanceB > s.balanceA) return "B";
    return "draw";
  }

  initialState(ctx: ProtocolContext): SoloBjState {
    const s = super.initialState(ctx);
    return toSoloBj(s, this.decide(s), 0);
  }

  applyMove(state: BlackjackState, move: BlackjackMove, by: Party): SoloBjState {
    const next = super.applyMove(state, move, by);
    const prevMoves = (state as Partial<SoloBjState>).moves ?? 0;
    return toSoloBj(next, this.decide(next), prevMoves + 1);
  }
}

// Annotated as the interface (not the object literal) so `defineSoloGame`'s `S extends AnySoloSpec`
// constraint checks method signatures bivariantly (matches `quantumPokerSoloSpec`'s rationale).
const blackjackSolo: SoloGameSpec<
  SoloBjState,
  BlackjackMove,
  BlackjackMove,
  BjView,
  BjResult,
  BjBots,
  SoloBlackjackProtocol
> = {
  game: "blackjack",
  // Per-ROUND wager floor (the small swap); the large per-seat bank the engine funds (default
  // 1 MTPS) is the chip stack and survives the many MIN_BET rounds.
  stake: MIN_BET,
  manualStepMs: BJ_MANUAL_STEP_MS,
  makeProtocol: () => new SoloBlackjackProtocol(),
  makeBots: makeBjBots,
  deriveView: deriveBjView,
  sessionResult: bjSessionResult,
  // One co-signed tick per call. AUTOPILOT: the kit bots drive both seats incl. commit/reveal/bet/
  // hit-stand. MANUAL (take-over seat A): the bots still auto-run the mechanical commit/reveal; only
  // A's bet/hit-stand waits for the queued human decision.
  stepWith: (protocol, tunnel, bots, take) =>
    stepBlackjackSolo(
      protocol,
      tunnel,
      bots,
      (s) => actorFor(s, FIXED_PLAYER_A),
      take ? { seat: "A", getMove: () => take() } : null,
    ),
  kickoffNextGame: kickoffNextGameBj,
};

export const blackjackSoloSpec = defineSoloGame(blackjackSolo);
