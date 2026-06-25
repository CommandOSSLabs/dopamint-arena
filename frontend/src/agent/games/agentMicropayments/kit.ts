import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  AgentMicropaymentsProtocol,
  type MicropaymentsState,
  type MicropaymentMove,
} from "sui-tunnel-ts/protocol/agentMicropayments";
import type { MoveCodec } from "sui-tunnel-ts/core/distributedFrame";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";

/**
 * A consumer agent that pays the provider per request until its budget drains.
 * Only seat A (the consumer) initiates; the provider seat B never proposes a move
 * (its `randomMove` returns null), so the session is a one-directional pay stream.
 */
class MicropaymentsBot implements GameBot<
  MicropaymentsState,
  MicropaymentMove
> {
  private readonly seat: Party;
  private readonly protocol: AgentMicropaymentsProtocol;
  private readonly rng: () => number;

  constructor(
    seat: Party,
    protocol: AgentMicropaymentsProtocol,
    ctx: BotContext,
  ) {
    this.seat = seat;
    this.protocol = protocol;
    this.rng = ctx.rngForSeat(seat);
  }

  plan(state: MicropaymentsState): MicropaymentMove | null {
    return this.protocol.randomMove(state, this.seat, this.rng);
  }

  confirm(): void {
    // No retained memory — each request is decided from the current state.
  }

  abort(): void {
    // No retained memory.
  }
}

/** `amount` is a bigint (not JSON-native) — (de)serialize via a decimal string. */
const micropaymentMoveCodec: MoveCodec<MicropaymentMove> = {
  encode: (m) => ({ amount: m.amount.toString() }),
  decode: (j) => ({ amount: BigInt((j as { amount: string }).amount) }),
};

export function createAgentMicropaymentsKit(
  pricePerRequest: bigint,
  stake: bigint,
): GameKit<MicropaymentsState, MicropaymentMove> {
  const protocol = new AgentMicropaymentsProtocol(pricePerRequest);
  return {
    id: "agent-micropayments",
    protocol,
    moveCodec: micropaymentMoveCodec,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) =>
      new MicropaymentsBot(seat, protocol, ctx),
    defaultStake: stake,
  };
}
