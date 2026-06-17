import type { PokerMove, PokerState } from "sui-tunnel-ts/protocol/quantumPoker";
import { QuantumPokerProtocol } from "sui-tunnel-ts/protocol/quantumPoker";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";

export class QuantumPokerBot {
  constructor(
    private readonly protocol: QuantumPokerProtocol,
    private readonly rng: () => number,
  ) {}

  chooseMove(state: PokerState, by: Party): PokerMove | null {
    return this.protocol.randomMove?.(state, by, this.rng) ?? null;
  }
}

export function createQuantumPokerProtocol(): QuantumPokerProtocol {
  return new QuantumPokerProtocol(8n);
}
