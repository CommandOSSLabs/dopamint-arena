/**
 * Payments protocol: bidirectional off-chain micropayments over a tunnel.
 *
 * The simplest, highest-throughput protocol — each move shifts `amount` from one
 * party's balance to the other. Balances always sum to the locked total, so every
 * state is directly settleable. This is the default workload for the throughput
 * benchmark (1000 updates/sec/tunnel).
 */

import {
  Protocol,
  Party,
  Balances,
  ProtocolContext,
  protocolDomain,
  otherParty,
} from "./Protocol";
import { concatBytes } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";

export interface PaymentsState {
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
  /** Number of payments applied (monotonic; folded into the state encoding). */
  count: bigint;
}

export interface PaymentMove {
  from: Party;
  amount: bigint;
}

const DOMAIN = protocolDomain("payments.v1");

export class PaymentsProtocol implements Protocol<PaymentsState, PaymentMove> {
  readonly name = "payments.v1";

  initialState(ctx: ProtocolContext): PaymentsState {
    return {
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total: ctx.initialBalances.a + ctx.initialBalances.b,
      count: 0n,
    };
  }

  applyMove(state: PaymentsState, move: PaymentMove, by: Party): PaymentsState {
    if (move.from !== by) {
      throw new Error(`move.from (${move.from}) must equal signer (${by})`);
    }
    if (move.amount <= 0n) throw new Error("payment amount must be positive");
    const sender = move.from;
    const fromBal = sender === "A" ? state.balanceA : state.balanceB;
    if (move.amount > fromBal) {
      throw new Error(
        `insufficient balance: ${sender} has ${fromBal}, sends ${move.amount}`
      );
    }
    const recipient = otherParty(sender);
    const balanceA =
      sender === "A"
        ? state.balanceA - move.amount
        : state.balanceA + move.amount;
    const balanceB =
      sender === "B"
        ? state.balanceB - move.amount
        : state.balanceB + move.amount;
    void recipient;
    return {
      balanceA,
      balanceB,
      total: state.total,
      count: state.count + 1n,
    };
  }

  encodeState(state: PaymentsState): Uint8Array {
    // Fixed-size canonical encoding (O(1) per update — no growing history).
    return concatBytes([
      DOMAIN,
      u64ToBeBytes(state.balanceA),
      u64ToBeBytes(state.balanceB),
      u64ToBeBytes(state.count),
    ]);
  }

  balances(state: PaymentsState): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  isTerminal(): boolean {
    return false; // payments run until the tunnel is explicitly closed
  }

  randomMove(
    state: PaymentsState,
    by: Party,
    rng: () => number
  ): PaymentMove | null {
    const bal = by === "A" ? state.balanceA : state.balanceB;
    if (bal <= 0n) return null;
    // small payment: 1..min(bal, 1000)
    const cap = bal < 1000n ? bal : 1000n;
    const amount = BigInt(1 + Math.floor(rng() * Number(cap)));
    return { from: by, amount };
  }
}
