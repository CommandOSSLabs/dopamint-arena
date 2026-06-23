// Pure re-buy logic for Quantum Poker PvP (no React, no IO). Decides whether a terminal "done" state
// is a re-buyable bust vs a genuine hand-cap end, computes the next round's carry-over balances, and
// sequences settle→reopen. Unit-tested; the hook injects real settle/startRound implementations.
import type { PokerState } from "sui-tunnel-ts/protocol/quantumPoker";
import { POKER_BUYIN } from "./constants";

/** Mirrors the protocol's hardcoded ante (`quantumPoker.ts`: `const ANTE = 50n`). A seat below this
 *  can't post the next ante, so the engine ends the match at `phase = "done"`. */
export const POKER_ANTE = 50n;

/** True when the match ended only because a seat busted before the hand cap — the case we re-buy.
 *  A `done` state at `handNo >= handCap` is a genuine end and must settle, not re-buy. */
export function isRebuyableBust(s: PokerState): boolean {
  return (
    s.phase === "done" &&
    s.handNo < s.handCap &&
    (s.balanceA < POKER_ANTE || s.balanceB < POKER_ANTE)
  );
}

/** Next round's per-seat balances: the busted seat (below the ante) gains one buy-in; the other
 *  carries its full stack. chips == raw DOPAMINT, so these are also the on-chain stakes to lock. */
export function carryOverBalances(s: PokerState): { a: bigint; b: bigint } {
  return {
    a: s.balanceA < POKER_ANTE ? s.balanceA + POKER_BUYIN : s.balanceA,
    b: s.balanceB < POKER_ANTE ? s.balanceB + POKER_BUYIN : s.balanceB,
  };
}

/** Settle the current tunnel, then open the next round with the carried-over balances. Ordering
 *  matters: the close must commit before the new round funds. Side effects are injected so this is
 *  unit-testable without a relay or chain. */
export async function runRebuyRound(
  s: PokerState,
  deps: {
    settle: () => Promise<void>;
    startRound: (balances: { a: bigint; b: bigint }) => Promise<void>;
  },
): Promise<void> {
  await deps.settle();
  await deps.startRound(carryOverBalances(s));
}
