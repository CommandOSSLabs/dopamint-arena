import type {
  PokerMove,
  PokerState,
} from "sui-tunnel-ts/protocol/quantumPoker";
import { QuantumPokerProtocol } from "sui-tunnel-ts/protocol/quantumPoker";
import {
  JULES_PROFILE,
  QuantumPokerPersonaDriver,
  type QuantumPokerBotProfile,
} from "sui-tunnel-ts/protocol/quantumPokerPersona";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";

export class QuantumPokerBot {
  private readonly drivers = new Map<Party, QuantumPokerPersonaDriver>();

  constructor(
    _protocol: QuantumPokerProtocol,
    private readonly rng: () => number,
    private readonly profile: QuantumPokerBotProfile = JULES_PROFILE,
  ) {}

  chooseMove(state: PokerState, by: Party): PokerMove | null {
    let driver = this.drivers.get(by);
    if (!driver) {
      driver = new QuantumPokerPersonaDriver(by, this.profile);
      this.drivers.set(by, driver);
    }
    return driver.chooseMove(state, this.rng);
  }
}

export function createQuantumPokerProtocol(): QuantumPokerProtocol {
  return new QuantumPokerProtocol(8n);
}
