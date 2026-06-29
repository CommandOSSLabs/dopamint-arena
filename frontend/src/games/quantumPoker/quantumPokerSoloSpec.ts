/**
 * Quantum Poker as a worker SELF-PLAY spec (the solo-lane sibling of `usePvpQuantumPoker`'s PvP
 * spec, and the worker port of `useQuantumPokerAuto`'s bespoke attract loop). Reuses poker's
 * canonical pieces verbatim: `QuantumPokerProtocol` for the rules, the kit persona bots, and
 * `pokerSelfPlay.ts`'s commit-reveal step helpers (`stepPokerAuto` / `stepPokerWithHuman` /
 * `applyHumanMove`). The generic `SoloEngine` owns the rest — the one-signature open+fund of both
 * ephemeral seats, the `OffchainTunnel.selfPlay` loop, the autopilot/manual cadence, transcript,
 * and cooperative settle.
 *
 * SECRETS / no moveCodec: poker's `commit_slots` moves carry the hole-card pre-images, so the PvP
 * relay path REQUIRES a stripping `moveCodec` (the `DistributedTunnel` guard). The SELF-PLAY lane
 * has no relay: `OffchainTunnel.selfPlay` applies each move locally and co-signs only
 * `blake2b256(encodeState(next))`, and poker's `encodeState` never serializes `holeA/B` or
 * `localSecretsA/B` (only `shownHole*` at showdown). So a secret never crosses a trust boundary
 * here and `SoloGameSpec` correctly omits a `moveCodec` field — none is needed (unlike
 * `battleshipSpec`, which IS a wire/relay spec). See the task note in the PR description.
 *
 * SHAPE adapter: `SoloGameSpec` requires `State extends SoloMultiGameState` ({ gamesPlayed, inner:
 * { winner } }), which the `SoloEngine` reads to tally the session score. A bare `PokerState` lacks
 * both fields, so {@link SoloQuantumPokerProtocol} augments the protocol's output with them (and a
 * cumulative `moves` count for the activity ticker) — pure derived sugar, delegating ALL rules to
 * `super`. One funded tunnel hosts ONE multi-hand match (handCap hands); each hand advances inside
 * the protocol (the bots drive `next_hand`), so the engine never rematches — `stepWith` returns
 * "session-over" once at `phase === "done"` and `kickoffNextGame` is unreachable.
 */
import { defineSoloGame } from "@/engine/specs/defineGame";
import type {
  SoloGameSpec,
  SoloMultiGameState,
  SoloStepOutcome,
  SoloTakeIntent,
} from "@/engine/engineApi";
import {
  QuantumPokerProtocol,
  type PokerState,
  type PokerMove,
} from "sui-tunnel-ts/protocol/quantumPoker";
import type { Party, ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";
import {
  POKER_BUYIN,
  QUANTUM_POKER_HANDS_PER_TUNNEL,
  QUANTUM_POKER_STAKE,
} from "./constants";
import {
  applyHumanMove,
  LIVE_BOT_CONTEXT,
  makeSeatBot,
  randomPokerPersona,
  stepPokerAuto,
  stepPokerWithHuman,
  type PokerSeatBot,
  type PokerTunnel,
} from "./pokerSelfPlay";

/** Per-move pacing while a human plays a seat, so the run-out is watchable; mirrors the legacy
 *  hook's MANUAL_PACE_MS. Autopilot ignores it and batches (the throughput showcase). */
const POKER_MANUAL_STEP_MS = 320;

/** The match outcome surfaced as the session result (final-balance winner, or a tie). */
export type PokerSoloResult = "A" | "B" | "draw" | null;

/** A `PokerState` widened to satisfy {@link SoloMultiGameState}: `gamesPlayed` tracks hands dealt
 *  and `inner.winner` the decided MATCH (null until `done`). `moves` feeds the activity ticker. */
export type PokerSoloState = PokerState &
  SoloMultiGameState & {
    /** Cumulative co-signed moves applied this match (the ticker's "actions"). */
    moves: number;
  };

/** Per-seat kit bots threaded into `stepWith`; opaque to the engine (same shape the legacy loop uses). */
type PokerSoloBots = Record<Party, PokerSeatBot>;

/** The decided MATCH winner (by final balances) once the match is `done`; null while it runs. */
function matchWinner(s: PokerState): PokerSoloResult {
  if (s.phase !== "done") return null;
  if (s.balanceA > s.balanceB) return "A";
  if (s.balanceB > s.balanceA) return "B";
  return "draw";
}

/** Attach the engine-required {@link SoloMultiGameState} fields to a protocol state. */
function toSoloState(s: PokerState, moves: number): PokerSoloState {
  return {
    ...s,
    gamesPlayed: Number(s.handNo),
    inner: { winner: matchWinner(s) },
    moves,
  };
}

/**
 * `QuantumPokerProtocol` widened to emit {@link PokerSoloState}. It reimplements NO rules — every
 * transition delegates to `super` and is then decorated with the derived solo fields. `encodeState`
 * / `balances` / `isTerminal` are inherited unchanged (they read named `PokerState` fields and
 * ignore the extras), so the co-signed state hash and on-chain-settleable balances are identical to
 * the plain protocol's.
 */
export class SoloQuantumPokerProtocol extends QuantumPokerProtocol {
  initialState(ctx: ProtocolContext): PokerSoloState {
    return toSoloState(super.initialState(ctx), 0);
  }

  applyMove(state: PokerState, move: PokerMove, by: Party): PokerSoloState {
    const next = super.applyMove(state, move, by);
    const prevMoves = (state as Partial<PokerSoloState>).moves ?? 0;
    return toSoloState(next, prevMoves + 1);
  }
}

// Annotated as the interface (not the object literal) so `defineSoloGame`'s `S extends AnySoloSpec`
// constraint is checked against method signatures (bivariant) rather than the literal's arrow-property
// signatures (contravariant), which would reject the narrowed `Bots`/`Proto` generics.
const quantumPokerSolo: SoloGameSpec<
  PokerSoloState,
  PokerMove,
  PokerMove,
  PokerSoloState,
  PokerSoloResult,
  PokerSoloBots,
  SoloQuantumPokerProtocol
> = {
  game: "quantum-poker",
  // Per-seat chip stack drives the on-chain bank the engine funds; the protocol's hand cap (not a
  // per-duel stake) bounds the match, so `stakePerGame` is unused for the protocol below.
  stake: QUANTUM_POKER_STAKE,
  // Poker's on-chain seat bank IS the chip buy-in (chips == raw MTPS 1:1), not the engine's default
  // 1-MTPS bank — so the funded seats match the protocol's starting balances.
  lockedPerSeat: POKER_BUYIN,
  // Poker is a turn-based card game: manual play co-signs ONE tick per this many ms so the run-out
  // stays watchable, and it doubles as the poll cadence while parked on the human's betting turn.
  manualStepMs: POKER_MANUAL_STEP_MS,
  makeProtocol: () => new SoloQuantumPokerProtocol(QUANTUM_POKER_HANDS_PER_TUNNEL),
  makeBots: (stakePerGame) => ({
    A: makeSeatBot(
      "A",
      stakePerGame,
      QUANTUM_POKER_HANDS_PER_TUNNEL,
      randomPokerPersona(Math.random),
      LIVE_BOT_CONTEXT,
    ),
    B: makeSeatBot(
      "B",
      stakePerGame,
      QUANTUM_POKER_HANDS_PER_TUNNEL,
      randomPokerPersona(Math.random),
      LIVE_BOT_CONTEXT,
    ),
  }),
  // The view IS the augmented state: the table + ticker render straight from `PokerState` fields
  // (PokerSoloState is a superset), so no separate flattening is needed.
  deriveView: (state) => state,
  sessionResult: (inner) => inner.winner,
  // One co-signed move per call (the engine batches in autopilot, paces in manual). AUTOPILOT: the
  // kit bots drive both seats incl. commit/reveal/next_hand. MANUAL (take-over seat A): the bots
  // still auto-run seat A's mechanical moves; only its bet/check/call/fold waits for the queued
  // human intent — when none is queued we yield a no-op "stepped" so the engine polls again.
  stepWith: (
    _protocol,
    tunnel,
    bots,
    take: SoloTakeIntent<PokerMove> | null,
  ): SoloStepOutcome => {
    // The pokerSelfPlay helpers are typed against the plain `PokerTunnel`; at runtime this IS the
    // augmented tunnel (its protocol/state carry the extra fields), so the cast is purely structural.
    const t = tunnel as unknown as PokerTunnel;
    // Read the phase fresh each time: the helpers mutate the tunnel, but TS would otherwise keep the
    // first guard's narrowing and flag the later checks as impossible.
    const done = (): boolean => t.state.phase === "done";
    if (done()) return "session-over";

    if (!take) {
      const applied = stepPokerAuto(t, bots.A, bots.B, 0n);
      if (!applied) return "session-over"; // null ⟺ phase === "done"
      return done() ? "session-over" : "stepped";
    }

    const step = stepPokerWithHuman(t, bots.A, bots.B, "A", 0n);
    if (step.kind === "idle") return "session-over";
    if (step.kind === "applied") {
      return done() ? "session-over" : "stepped";
    }
    // await-human: apply the queued betting move if the player has one, else poll next manual tick.
    const queued = take();
    if (queued) {
      applyHumanMove(t, bots.A, "A", queued, 0n);
      return done() ? "session-over" : "stepped";
    }
    return "stepped";
  },
  // Unreachable for poker: hands advance inside the protocol, so `stepWith` never returns
  // "game-over". A no-op keeps the spec total; if ever called it leaves the match terminal.
  kickoffNextGame: () => {},
};

export const quantumPokerSoloSpec = defineSoloGame(quantumPokerSolo);
