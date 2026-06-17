/**
 * Blackjack DUEL protocol (game-side; implements the SDK `Protocol`). Two players (A, B)
 * each play their own hand against a SHARED deterministic dealer; head-to-head for one pot.
 * Mirrors the deterministic dealerless card stream + soft-ace handValue + draw-to-17 dealer of
 * `sui-tunnel-ts/src/protocol/blackjack.ts`. Stake is fixed; balances only ever swap A<->B.
 */
import { core, protocols } from "sui-tunnel-ts";
import { handValue } from "@/lib/bjCards";

type Party = protocols.Party; // "A" | "B"
type Balances = protocols.Balances;
type ProtocolContext = protocols.ProtocolContext;

/** Per-seat stake (MIST). 0.01 SUI — tiny on testnet (gas dominates). Pot = 2*STAKE. */
export const STAKE = 10_000_000n;
const DEALER_STANDS_AT = 17;
const BUST_AT = 21;

export type DuelPhase = "a_turn" | "b_turn" | "over";
export interface DuelState {
  seed: number[]; // 32-byte deterministic card-stream seed (from tunnelId)
  dealerHand: number[];
  handA: number[];
  handB: number[];
  phase: DuelPhase;
  drawIndex: number;
  balanceA: bigint;
  balanceB: bigint;
  wager: bigint;
}
export interface DuelMove {
  action: "hit" | "stand";
}

const DOMAIN = protocols.protocolDomain("blackjack.duel.v1");
const PHASE_CODE: Record<DuelPhase, number> = { a_turn: 0, b_turn: 1, over: 2 };

/** Deterministic card byte at `drawIndex` for a seed; advances a rolling digest every 32 draws. */
function drawRank(seed: number[], drawIndex: number): number {
  let digest = Uint8Array.from(seed);
  const block = Math.floor(drawIndex / 32);
  for (let b = 0; b < block; b++) {
    digest = core.blake2b256(core.concatBytes([digest, core.u64ToBeBytes(b)]));
  }
  return (digest[drawIndex % 32] % 13) + 1;
}
/** rank (1..13) -> raw blackjack value (Ace = 11, reduced later by handValue). */
function rankValue(rank: number): number {
  if (rank === 1) return 11;
  if (rank >= 11) return 10;
  return rank;
}
const isBust = (hand: number[]) => handValue(hand) > BUST_AT;

/**
 * Head-to-head outcome of two hands vs a shared (already-resolved) dealer hand.
 * Rank each seat by (result-vs-dealer: WIN=2/PUSH=1/LOSE=0, then hand value, bust=0); higher
 * wins, fully-equal is a push. Exported pure so it can be unit-tested directly.
 */
export function settleOutcome(
  handA: number[],
  handB: number[],
  dealerHand: number[],
): "A" | "B" | "push" {
  const dv = handValue(dealerHand);
  const dealerBust = dv > BUST_AT;
  const rank = (hand: number[]) => {
    if (isBust(hand)) return { res: 0, val: 0 };
    const v = handValue(hand);
    const res = dealerBust || v > dv ? 2 : v < dv ? 0 : 1;
    return { res, val: v };
  };
  const ra = rank(handA);
  const rb = rank(handB);
  if (ra.res !== rb.res) return ra.res > rb.res ? "A" : "B";
  if (ra.val !== rb.val) return ra.val > rb.val ? "A" : "B";
  return "push";
}

export class BlackjackDuelProtocol implements protocols.Protocol<DuelState, DuelMove> {
  readonly name = "blackjack.duel.v1";

  initialState(ctx: ProtocolContext): DuelState {
    const seedBytes = core.blake2b256(
      core.concatBytes([DOMAIN, new TextEncoder().encode(ctx.tunnelId)]),
    );
    const seed = Array.from(seedBytes);
    let drawIndex = 0;
    const dealTwo = () => {
      const h: number[] = [];
      for (let i = 0; i < 2; i++) h.push(rankValue(drawRank(seed, drawIndex++)));
      return h;
    };
    const dealerHand = dealTwo();
    const handA = dealTwo();
    const handB = dealTwo();
    return {
      seed,
      dealerHand,
      handA,
      handB,
      phase: "a_turn",
      drawIndex,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      wager: STAKE,
    };
  }

  applyMove(state: DuelState, move: DuelMove, by: Party): DuelState {
    if (move.action !== "hit" && move.action !== "stand") {
      throw new Error(`unknown action: ${String(move.action)}`);
    }
    if (state.phase === "over") throw new Error("duel is over");
    const seat: Party = state.phase === "a_turn" ? "A" : "B";
    if (by !== seat) throw new Error(`it is ${seat}'s turn`);

    let hand = seat === "A" ? state.handA : state.handB;
    let drawIndex = state.drawIndex;
    let turnEnded: boolean;
    if (move.action === "hit") {
      hand = [...hand, rankValue(drawRank(state.seed, drawIndex))];
      drawIndex += 1;
      turnEnded = isBust(hand); // a bust ends this seat's turn; otherwise keep hitting
    } else {
      turnEnded = true;
    }
    const next: DuelState =
      seat === "A" ? { ...state, handA: hand, drawIndex } : { ...state, handB: hand, drawIndex };
    if (!turnEnded) return next;
    if (seat === "A") return { ...next, phase: "b_turn" };
    return resolveAndSettle(next); // B finished -> dealer resolves, settle, terminal
  }

  encodeState(s: DuelState): Uint8Array {
    return core.concatBytes([
      DOMAIN,
      core.u64ToBeBytes(s.seed.length),
      Uint8Array.from(s.seed),
      core.u64ToBeBytes(s.dealerHand.length),
      Uint8Array.from(s.dealerHand),
      core.u64ToBeBytes(s.handA.length),
      Uint8Array.from(s.handA),
      core.u64ToBeBytes(s.handB.length),
      Uint8Array.from(s.handB),
      new Uint8Array([PHASE_CODE[s.phase]]),
      core.u64ToBeBytes(s.drawIndex),
      core.u64ToBeBytes(s.balanceA),
      core.u64ToBeBytes(s.balanceB),
      core.u64ToBeBytes(s.wager),
    ]);
  }

  balances(s: DuelState): Balances {
    return { a: s.balanceA, b: s.balanceB };
  }

  isTerminal(s: DuelState): boolean {
    return s.phase === "over";
  }

  randomMove(s: DuelState, by: Party, _rng: () => number): DuelMove | null {
    if (s.phase === "over") return null;
    const seat: Party = s.phase === "a_turn" ? "A" : "B";
    if (by !== seat) return null;
    const hand = seat === "A" ? s.handA : s.handB;
    return { action: handValue(hand) < DEALER_STANDS_AT ? "hit" : "stand" };
  }
}

/** Resolve the shared dealer (draw to >=17), apply the head-to-head wager swap, go terminal. */
function resolveAndSettle(s: DuelState): DuelState {
  let dealerHand = s.dealerHand;
  let drawIndex = s.drawIndex;
  while (handValue(dealerHand) < DEALER_STANDS_AT) {
    dealerHand = [...dealerHand, rankValue(drawRank(s.seed, drawIndex))];
    drawIndex += 1;
  }
  const winner = settleOutcome(s.handA, s.handB, dealerHand);
  let balanceA = s.balanceA;
  let balanceB = s.balanceB;
  if (winner === "A") {
    const amt = s.wager <= balanceB ? s.wager : balanceB;
    balanceA += amt;
    balanceB -= amt;
  } else if (winner === "B") {
    const amt = s.wager <= balanceA ? s.wager : balanceA;
    balanceB += amt;
    balanceA -= amt;
  }
  return { ...s, dealerHand, drawIndex, phase: "over", balanceA, balanceB };
}
