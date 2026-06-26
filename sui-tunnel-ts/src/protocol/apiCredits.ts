/**
 * API Credits protocol: a client prepays credits and spends them per API call
 * over a tunnel (the cost-benefit example — 2 on-chain txns regardless of call
 * count).
 *
 * The client (A) locks a prepaid balance; each call burns a fixed `costPerCall`
 * to the provider (B), tracked off-chain as a signed state update. Balances
 * always sum to the locked total, so every state is directly settleable. The
 * session is terminal once the remaining balance can't cover another call.
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

export interface ApiCreditsState {
  /** Client (A) remaining prepaid balance. */
  client: bigint;
  /** Provider (B) accrued earnings. */
  provider: bigint;
  /** Locked total — the invariant sum (client + provider). */
  total: bigint;
  /** API calls made so far (monotonic; folded into the encoding). */
  calls: bigint;
}

/** A single metered API call; the cost is fixed by the protocol. */
export interface ApiCreditsMove {
  kind: "call";
}

const DOMAIN = protocolDomain("api_credits.v1");

export class ApiCreditsProtocol
  implements Protocol<ApiCreditsState, ApiCreditsMove>
{
  readonly name = "api_credits.v1";

  /** @param costPerCall fixed price burned per API call. */
  constructor(private readonly costPerCall: bigint = 10n) {
    if (costPerCall <= 0n) throw new Error("costPerCall must be positive");
  }

  initialState(ctx: ProtocolContext): ApiCreditsState {
    return {
      client: ctx.initialBalances.a,
      provider: ctx.initialBalances.b,
      total: ctx.initialBalances.a + ctx.initialBalances.b,
      calls: 0n,
    };
  }

  applyMove(
    state: ApiCreditsState,
    move: ApiCreditsMove,
    by: Party,
  ): ApiCreditsState {
    if (by !== "A") throw new Error("only the client (A) makes calls");
    if (move.kind !== "call") throw new Error(`unknown move: ${move.kind}`);
    if (state.client < this.costPerCall) {
      throw new Error("out of credits: remaining balance can't cover a call");
    }
    return {
      client: state.client - this.costPerCall,
      provider: state.provider + this.costPerCall,
      total: state.total,
      calls: state.calls + 1n,
    };
  }

  encodeState(state: ApiCreditsState): Uint8Array {
    return concatBytes([
      DOMAIN,
      u64ToBeBytes(state.client),
      u64ToBeBytes(state.provider),
      u64ToBeBytes(state.calls),
    ]);
  }

  balances(state: ApiCreditsState): Balances {
    return { a: state.client, b: state.provider };
  }

  isTerminal(state: ApiCreditsState): boolean {
    return state.client < this.costPerCall; // can't afford another call
  }

  randomMove(
    state: ApiCreditsState,
    by: Party,
    _rng: () => number,
  ): ApiCreditsMove | null {
    if (by !== "A" || state.client < this.costPerCall) return null;
    return { kind: "call" };
  }
}
