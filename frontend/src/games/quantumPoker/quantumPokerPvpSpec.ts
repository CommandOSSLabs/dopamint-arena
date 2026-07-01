/**
 * Quantum Poker as a worker-engine PvP `GameSessionSpec` (the hidden-info sibling of
 * `tttCaroPvpSpec`; follows `battleshipSpec`'s commit-reveal controller pattern).
 *
 * The controller ports the core plumbing/auto logic from the legacy 1000-line
 * `usePvpQuantumPoker` hook: `plumbingProposer` drives commit/reveal/next_hand,
 * a persona bot handles auto-play betting, and manual input queues
 * fold/check/call/bet moves. The `QuantumPokerSeatDriver` mints commit secrets
 * and produces the correct reveal moves; the `DistributedTunnel`'s `moveCodec`
 * strips secrets from the wire.
 *
 * Early-end (settle after the current hand) is handled via `onInput({ type: "settle" })`
 * — the controller sets a flag and stops proposing `next_hand` at `hand_over`,
 * letting the engine's generic settle flow close the tunnel.
 */
import type {
  GameSessionSpec,
  MatchController,
  MatchIo,
} from "@/engine/engineApi";
import { defineGame } from "@/engine/specs/defineGame";
import {
  expectedQuantumPokerRevealSlots,
  QuantumPokerProtocol,
  QuantumPokerSeatDriver,
  type PokerMove,
  type PokerState,
} from "sui-tunnel-ts/protocol/quantumPoker";
import { pokerMoveCodec } from "sui-tunnel-ts/protocol/quantumPokerCodec";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { ResumeAdapter } from "@/pvp/resumeSession";
import { makePokerResumeAdapter } from "./pokerResumeAdapter";
import {
  makeSeatBot,
  randomPokerPersona,
  type PokerSeatBot,
} from "./pokerSelfPlay";
import {
  POKER_BUYIN,
  QUANTUM_POKER_ANTE,
  QUANTUM_POKER_HAND_CAP,
} from "./constants";
import type { BotContext } from "@/agent/gameKit";
import {
  derivePokerLegal,
  type PokerPvpView,
} from "./quantumPokerPvpView";

// --- Constants (match the legacy hook) -----------------------------------------------

const HAND_CAP = QUANTUM_POKER_HAND_CAP;
/** Matchmaking queue id — both seats must request the same game. */
const GAME_ID = "quantum-poker";
/** Real-time RNG context for the auto-mode persona bot. */
const AUTO_BOT_CTX: BotContext = { rngForSeat: () => Math.random };
/** Crypto-strong [0,1) source for commit-reveal secrets. */
const secureRng = (): number => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
};

const BET_PHASES = new Set<PokerState["phase"]>([
  "preflop_bet",
  "flop_bet",
  "turn_bet",
  "river_bet",
]);

// --- Plumbing proposer (pure; ported from the legacy hook) ---------------------------

/** Which seat must propose the next non-betting move. */
function plumbingProposer(s: PokerState): Party | null {
  switch (s.phase) {
    case "commit":
      if (!s.commitA) return "A";
      if (!s.commitB) return "B";
      return null;
    case "open_private_holes":
    case "reveal_flop":
    case "reveal_turn":
    case "reveal_river":
    case "showdown":
      if (expectedQuantumPokerRevealSlots(s, "A").length > 0) return "A";
      if (expectedQuantumPokerRevealSlots(s, "B").length > 0) return "B";
      return null;
    case "hand_over":
      return "A"; // A drives next_hand
    default:
      return null;
  }
}

// --- PokerPvpController (worker-side MatchController) --------------------------------

/** Poker input from the UI — betting actions or an early-end request. */
type PokerInput =
  | { type: "fold" }
  | { type: "check" }
  | { type: "call" }
  | { type: "bet"; amount: bigint }
  | { type: "settle" };

class PokerPvpController
  implements MatchController<PokerState, PokerMove, void, PokerInput, PokerPvpView>
{
  private driver: QuantumPokerSeatDriver | null = null;
  private autoBot: PokerSeatBot | null = null;
  /** Dedupe: at most one scheduled plumbing move per target nonce. */
  private lastProposedNonce = -1n;
  /** Stop dealing after the current hand — settle at the next `hand_over`. */
  private endRequested = false;
  /** Auto-fold to reach `hand_over` as fast as possible (bail-out path). */
  private foldOut = false;
  /** Pending plumbing timer (watchable pacing for reveals/hand-over). */
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly io: MatchIo<PokerState, PokerMove>,
  ) {}

  initSetup(): void {
    const role = this.io.role;
    this.driver = new QuantumPokerSeatDriver(role);
    this.autoBot = makeSeatBot(
      role,
      POKER_BUYIN,
      HAND_CAP,
      randomPokerPersona(Math.random),
      AUTO_BOT_CTX,
    );
  }

  onConfirmed(): void {
    this.proposeDue();
  }

  onInput(input: PokerInput): void {
    if (input.type === "settle") {
      this.endRequested = true;
      // If parked at hand_over, the next onConfirmed/proposeDue will see the flag
      // and NOT propose next_hand — the engine's generic isTerminal check settles.
      // If mid-hand, play continues until hand_over naturally.
      this.io.emitView();
      return;
    }
    // Map UI actions to PokerMove
    const move = this.inputToMove(input);
    if (!move) return;
    this.proposeBet(move);
  }

  setAuto(): void {
    this.proposeDue();
  }

  deriveView(state: PokerState): PokerPvpView {
    const self = this.io.role;
    const myTurnToBet =
      BET_PHASES.has(state.phase) &&
      state.toAct === self &&
      state.winner === null;
    return {
      state,
      myHole: self === "A" ? (state.holeA ?? null) : (state.holeB ?? null),
      myTurnToBet,
      legal: myTurnToBet ? derivePokerLegal(state, self) : null,
      endRequested: this.endRequested,
    };
  }

  resumeAdapter(): ResumeAdapter<PokerState, PokerMove> {
    const io = this.io;
    return makePokerResumeAdapter({
      getSecret: () => {
        const dt = io.tunnel();
        if (!dt) return { localSecretsA: null, localSecretsB: null, holeA: null, holeB: null };
        const s = dt.state;
        return {
          localSecretsA: s.localSecretsA,
          localSecretsB: s.localSecretsB,
          holeA: s.holeA,
          holeB: s.holeB,
        };
      },
      setSecret: (sec) => {
        const dt = io.tunnel();
        if (!dt) return;
        const s = dt.state;
        s.localSecretsA = sec.localSecretsA;
        s.localSecretsB = sec.localSecretsB;
        s.holeA = sec.holeA;
        s.holeB = sec.holeB;
      },
      onReconciled: () => {
        io.emitView();
        this.proposeDue();
      },
    });
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // --- internals ---

  /** Propose the due plumbing/auto move if this seat owns the current phase. */
  private proposeDue(): void {
    const dt = this.io.tunnel();
    const driver = this.driver;
    if (!dt || !driver) return;

    const self = this.io.role;
    const targetNonce = dt.nonce + 1n;
    if (this.lastProposedNonce === targetNonce) return;

    // Early-end: don't deal a new hand — let the engine settle at this boundary.
    if (this.endRequested && dt.state.phase === "hand_over") return;

    let move: PokerMove | null = null;

    // 1) Plumbing: commit/reveal/next_hand — always auto-driven.
    if (plumbingProposer(dt.state) === self) {
      move = driver.chooseMove(dt.state, secureRng);
    }
    // 2) Bail-out: auto-fold on betting turns to end the hand fast.
    else if (
      this.foldOut &&
      BET_PHASES.has(dt.state.phase) &&
      dt.state.toAct === self
    ) {
      move = { kind: "fold" };
    }
    // 3) Auto mode: persona bot picks betting actions.
    else if (
      this.io.auto() &&
      BET_PHASES.has(dt.state.phase) &&
      dt.state.toAct === self
    ) {
      move = this.autoBot?.plan(dt.state) ?? null;
    }

    if (!move) return;
    this.lastProposedNonce = targetNonce;

    // In auto mode (or foldOut), propose immediately for throughput.
    // Manual mode paces plumbing so a human can follow the table.
    if (this.io.auto() || this.foldOut) {
      this.applyProposal(move, targetNonce);
    } else {
      const delay = dt.state.phase === "hand_over" ? 2000 : 300;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.applyProposal(move, targetNonce);
      }, delay);
    }
  }

  private applyProposal(move: PokerMove, targetNonce: bigint): void {
    const dt = this.io.tunnel();
    if (!dt || dt.nonce + 1n !== targetNonce) return;
    try {
      dt.propose(move, 0n);
      this.io.emitView();
    } catch {
      /* proposal already pending or transient — safe to ignore */
    }
  }

  /** Propose a human betting move (fold/check/call/bet). */
  private proposeBet(move: PokerMove): void {
    const dt = this.io.tunnel();
    if (!dt) return;
    const self = this.io.role;
    if (!BET_PHASES.has(dt.state.phase) || dt.state.toAct !== self) return;
    try {
      dt.propose(move, 0n);
      this.io.emitView();
    } catch {
      /* proposal already pending */
    }
  }

  private inputToMove(input: Exclude<PokerInput, { type: "settle" }>): PokerMove | null {
    switch (input.type) {
      case "fold":
        return { kind: "fold" };
      case "check":
        return { kind: "check" };
      case "call":
        return { kind: "call" };
      case "bet":
        return { kind: "bet", amount: input.amount };
      default:
        return null;
    }
  }
}

// --- Spec registration ---------------------------------------------------------------

export const quantumPokerPvpSpec: GameSessionSpec<
  PokerState,
  PokerMove,
  void,
  PokerInput,
  PokerPvpView
> = defineGame({
  game: GAME_ID,
  stake: POKER_BUYIN,
  makeProtocol: () =>
    new QuantumPokerProtocol(HAND_CAP, QUANTUM_POKER_ANTE),
  moveCodec: pokerMoveCodec,
  createMatch: (io) => new PokerPvpController(io),
});
