import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  expectedQuantumPokerRevealSlots,
  QuantumPokerProtocol,
  type PokerState,
  type PokerMove,
} from "sui-tunnel-ts/protocol/quantumPoker";
import { pokerMoveCodec } from "sui-tunnel-ts/protocol/quantumPokerCodec";
import {
  QuantumPokerPersonaDriver,
  type QuantumPokerBotProfile,
} from "sui-tunnel-ts/protocol/quantumPokerPersona";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";
import {
  POKER_ANTE,
  QUANTUM_POKER_HAND_CAP,
} from "@/games/quantumPoker/constants";

const DEFAULT_QUANTUM_POKER_BOT_PROFILE: QuantumPokerBotProfile = {
  name: "Vale",
  persona: "balanced",
};

export interface QuantumPokerBotConfig {
  profile?: QuantumPokerBotProfile;
}

function actorForState(state: PokerState): Party | null {
  switch (state.phase) {
    case "commit":
      if (!state.commitA) return "A";
      if (!state.commitB) return "B";
      return null;
    case "open_private_holes":
    case "reveal_flop":
    case "reveal_turn":
    case "reveal_river":
    case "showdown":
      if (expectedQuantumPokerRevealSlots(state, "A").length > 0) return "A";
      if (expectedQuantumPokerRevealSlots(state, "B").length > 0) return "B";
      return null;
    case "preflop_bet":
    case "flop_bet":
    case "turn_bet":
    case "river_bet":
      return state.toAct;
    case "hand_over":
      return "A";
    case "done":
      return null;
  }
}

class QuantumPokerBot implements GameBot<PokerState, PokerMove> {
  private readonly seat: Party;
  private readonly driver: QuantumPokerPersonaDriver;
  private readonly rng: () => number;

  constructor(seat: Party, ctx: BotContext, config: QuantumPokerBotConfig) {
    this.seat = seat;
    this.driver = new QuantumPokerPersonaDriver(
      seat,
      config.profile ?? DEFAULT_QUANTUM_POKER_BOT_PROFILE,
    );
    this.rng = ctx.rngForSeat(seat);
  }

  plan(state: PokerState): PokerMove | null {
    if (actorForState(state) !== this.seat) return null;
    return this.driver.chooseMove(state, this.rng);
  }

  confirm(_state: PokerState, _move: PokerMove): void {
    // Driver derives round memory from public state; no explicit advance needed.
  }

  abort(): void {
    // Instances are short-lived; no explicit teardown required.
  }
}

export function createQuantumPokerKit(
  stake: bigint,
  handCap: bigint = QUANTUM_POKER_HAND_CAP,
  config: QuantumPokerBotConfig = {},
): GameKit<PokerState, PokerMove> {
  const protocol = new QuantumPokerProtocol(handCap, POKER_ANTE);

  return {
    id: "quantum-poker",
    protocol,
    moveCodec: pokerMoveCodec,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) =>
      new QuantumPokerBot(seat, ctx, config),
    defaultStake: stake,
  };
}
