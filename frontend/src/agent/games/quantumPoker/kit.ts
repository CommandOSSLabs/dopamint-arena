import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  QuantumPokerProtocol,
  type PokerState,
  type PokerMove,
} from "sui-tunnel-ts/protocol/quantumPoker";
import {
  QuantumPokerPersonaDriver,
  type QuantumPokerBotProfile,
} from "sui-tunnel-ts/protocol/quantumPokerPersona";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";

const DEFAULT_QUANTUM_POKER_BOT_PROFILE: QuantumPokerBotProfile = {
  name: "Vale",
  persona: "balanced",
};

export interface QuantumPokerBotConfig {
  profile?: QuantumPokerBotProfile;
}

class QuantumPokerBot implements GameBot<PokerState, PokerMove> {
  private readonly driver: QuantumPokerPersonaDriver;
  private readonly rng: () => number;

  constructor(seat: Party, ctx: BotContext, config: QuantumPokerBotConfig) {
    this.driver = new QuantumPokerPersonaDriver(
      seat,
      config.profile ?? DEFAULT_QUANTUM_POKER_BOT_PROFILE,
    );
    this.rng = ctx.rngForSeat(seat);
  }

  plan(state: PokerState): PokerMove | null {
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
  config: QuantumPokerBotConfig = {},
): GameKit<PokerState, PokerMove> {
  const protocol = new QuantumPokerProtocol(stake);

  return {
    id: "quantum-poker",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) =>
      new QuantumPokerBot(seat, ctx, config),
    defaultStake: stake,
  };
}
