/**
 * Pure, React-free helpers for the Blackjack worker SELF-PLAY spec (sibling of poker's, on the
 * shared `SoloEngine`). Only TYPE imports from the SDK so it runs under tsx; the wrapper PROTOCOL
 * (a value import of `BlackjackProtocol`) and the `actorFor` binding live in `blackjackSoloSpec.ts`.
 *
 * SHAPE. `SoloMultiGameState` requires `{ gamesPlayed, inner: { winner } }`. A bare `BlackjackState`
 * has neither (and no per-round `winner` field — the round outcome is a balance shift). So, exactly
 * like poker, the wrapper AUGMENTS the state with `gamesPlayed` (= round) + `inner.winner` (the
 * MATCH winner by final balances, null until the session is terminal) — pure derived sugar that the
 * SDK protocol ignores (it reads only named `BlackjackState` fields). No name collision, so no
 * field conversion is needed (unlike ttt).
 *
 * NO moveCodec. Blackjack's commit pre-images live in `localSecretA/B`, which `encodeState` OMITS;
 * `OffchainTunnel.selfPlay` co-signs only `blake2b256(encodeState(next))`, so a secret never crosses
 * a trust boundary here and `SoloGameSpec` correctly omits `moveCodec` (unlike the PvP relay path).
 *
 * ONE multi-round match per tunnel (handCap-style): the protocol auto-advances `round` internally,
 * so the engine never rematches — `stepBlackjackSolo` returns "session-over" at terminal and
 * `kickoffNextGame` is unreachable.
 */
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type {
  BlackjackState,
  BlackjackMove,
} from "sui-tunnel-ts/protocol/blackjack";
import type { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import type { GameBot } from "@/agent/gameKit";
import type { SoloMultiGameState } from "@/engine/engineApi";

/** Session winner by final balances (X≙player-A by `FIXED_PLAYER_A`); null until terminal. */
export type BjWinner = "A" | "B" | "draw" | null;

/** A `BlackjackState` augmented with the engine-required {@link SoloMultiGameState} fields. */
export type SoloBjState = BlackjackState &
  SoloMultiGameState & {
    inner: { winner: BjWinner };
    /** Cumulative co-signed moves this match (the activity ticker's "actions"). */
    moves: number;
  };

/** A duel-advance outcome: one tick stepped, the round ended, or the bank is exhausted. */
export type StepOutcome = "stepped" | "game-over" | "session-over";

/** Who took the session (or a tie). */
export type BjResult = "A" | "B" | "draw";

/** When a human takes over seat A, the loop supplies its next decision (undefined ⇒ poll/bot). */
export interface BjHumanSeat {
  seat: Party;
  getMove: () => BlackjackMove | undefined;
}

/** Render-ready snapshot the board consumes (bigints → numbers). */
export interface BjView {
  phase: BlackjackState["phase"];
  round: number;
  playerHand: number[];
  dealerHand: number[];
  bet: number;
  balanceA: number;
  balanceB: number;
  gamesPlayed: number;
  winner: BjWinner;
}

/** Attach the engine-required solo fields to a protocol state. `winner` is the wrapper-computed
 *  match winner (null until terminal); `moves` is the running action count. */
export function toSoloBj(
  s: BlackjackState,
  winner: BjWinner,
  moves: number,
): SoloBjState {
  return { ...s, gamesPlayed: Number(s.round), inner: { winner }, moves };
}

export function deriveBjView(state: SoloBjState): BjView {
  return {
    phase: state.phase,
    round: Number(state.round),
    playerHand: [...state.playerHand],
    dealerHand: [...state.dealerHand],
    bet: Number(state.bet),
    balanceA: Number(state.balanceA),
    balanceB: Number(state.balanceB),
    gamesPlayed: state.gamesPlayed,
    winner: state.inner.winner,
  };
}

export function bjSessionResult(inner: SoloBjState["inner"]): BjResult {
  if (inner.winner === "A") return "A";
  if (inner.winner === "B") return "B";
  return "draw"; // tie OR null (in-progress) → neutral
}

/**
 * Advance a self-play blackjack session by one tick. Returns "stepped" until the protocol is
 * terminal (bank exhausted / round cap), then "session-over". `actorOf` resolves whose move is due
 * (`actorFor` bound to the spec's seat assignment); the kit bot for that seat picks the move (it
 * internally re-checks the actor and drives commit/reveal/bet/hit-stand via `randomMove`). A human
 * take-over seat plays its DECISIONS (bet / hit-stand); the mechanical commit/reveal stays bot-driven
 * even in manual, so a queued-but-not-yet decision polls rather than auto-bots the player's choice.
 *
 * The augmented `SoloBjState` is passed straight to the bots / protocol — they read only the named
 * `BlackjackState` fields and ignore `gamesPlayed`/`inner`/`moves` (poker-style; no `toRaw` needed).
 */
export function stepBlackjackSolo(
  protocol: { isTerminal: (s: SoloBjState) => boolean },
  tunnel: OffchainTunnel<SoloBjState, BlackjackMove>,
  bots: Record<Party, GameBot<BlackjackState, BlackjackMove>>,
  actorOf: (s: SoloBjState) => Party | null,
  human?: BjHumanSeat | null,
): StepOutcome {
  const s = tunnel.state;
  if (protocol.isTerminal(s)) return "session-over";
  const by = actorOf(s);
  if (!by) return "session-over"; // no actor outside terminal shouldn't happen; bail safely
  let move: BlackjackMove | null;
  if (human && human.seat === by) {
    const queued = human.getMove();
    // A human-decidable turn: the player's bet (round start) or hit/stand.
    const decision = s.phase === "player" || s.phase === "round_over";
    if (queued) move = queued;
    else if (decision) return "stepped"; // wait for the human's choice (poll next manual tick)
    else move = bots[by].plan(s); // commit/reveal plumbing: bot drives even in manual
  } else {
    move = bots[by].plan(s);
  }
  if (!move) return "session-over";
  tunnel.step(move, by);
  return "stepped";
}

/** Unreachable for blackjack: rounds advance inside the protocol, so `stepBlackjackSolo` never
 *  returns "game-over". A no-op keeps the spec total. */
export function kickoffNextGameBj(
  _tunnel: OffchainTunnel<SoloBjState, BlackjackMove>,
): void {
  /* unreachable — one multi-round match per tunnel */
}
