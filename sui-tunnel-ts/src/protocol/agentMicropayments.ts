/**
 * Agent Micropayments protocol: a consumer agent streams pay-per-request to a
 * provider agent over a tunnel (machine-to-machine, no human).
 *
 * The consumer (A) locks a budget upfront; each request pays `pricePerRequest`
 * one-directionally to the provider (B) — or the remaining budget on the final
 * request — tracked off-chain as a signed state update. Balances always sum to
 * the locked total, so every state is directly settleable. The session is
 * terminal once the budget is spent, settling for actual usage.
 */

import {
  Protocol,
  Party,
  Balances,
  ProtocolContext,
  protocolDomain,
} from "./Protocol";
import { concatBytes } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";

export interface MicropaymentsState {
  /** Consumer (A) remaining budget. */
  consumer: bigint;
  /** Provider (B) accrued earnings. */
  provider: bigint;
  /** Locked total — the invariant sum (consumer + provider). */
  total: bigint;
  /** Paid requests so far (monotonic; folded into the encoding). */
  requests: bigint;
}

export interface MicropaymentMove {
  /** Amount the consumer pays the provider for this request. */
  amount: bigint;
}

const DOMAIN = protocolDomain("agent_micropayments.v1");

export class AgentMicropaymentsProtocol
  implements Protocol<MicropaymentsState, MicropaymentMove>
{
  readonly name = "agent_micropayments.v1";

  /** @param pricePerRequest per-request fee; the final request pays the remainder. */
  constructor(private readonly pricePerRequest: bigint = 10n) {
    if (pricePerRequest <= 0n) {
      throw new Error("pricePerRequest must be positive");
    }
  }

  initialState(ctx: ProtocolContext): MicropaymentsState {
    return {
      consumer: ctx.initialBalances.a,
      provider: ctx.initialBalances.b,
      total: ctx.initialBalances.a + ctx.initialBalances.b,
      requests: 0n,
    };
  }

  applyMove(
    state: MicropaymentsState,
    move: MicropaymentMove,
    by: Party,
  ): MicropaymentsState {
    if (by !== "A") throw new Error("only the consumer (A) pays for requests");
    if (move.amount <= 0n) throw new Error("request amount must be positive");
    if (move.amount > state.consumer) {
      throw new Error(
        `insufficient budget: consumer has ${state.consumer}, request ${move.amount}`,
      );
    }
    return {
      consumer: state.consumer - move.amount,
      provider: state.provider + move.amount,
      total: state.total,
      requests: state.requests + 1n,
    };
  }

  encodeState(state: MicropaymentsState): Uint8Array {
    // Fixed-size canonical encoding (O(1) per update — no growing history).
    return concatBytes([
      DOMAIN,
      u64ToBeBytes(state.consumer),
      u64ToBeBytes(state.provider),
      u64ToBeBytes(state.requests),
    ]);
  }

  balances(state: MicropaymentsState): Balances {
    return { a: state.consumer, b: state.provider };
  }

  isTerminal(state: MicropaymentsState): boolean {
    return state.consumer === 0n; // budget fully spent
  }

  randomMove(
    state: MicropaymentsState,
    by: Party,
    _rng: () => number,
  ): MicropaymentMove | null {
    if (by !== "A" || state.consumer === 0n) return null;
    // Pay the per-request price, or the remainder on the final request — so the
    // budget drains exactly to a terminal state.
    const amount =
      state.consumer < this.pricePerRequest
        ? state.consumer
        : this.pricePerRequest;
    return { amount };
  }
}
