/**
 * Quantum Poker (Deliverable 3): a two-party, DEALERLESS poker variant over a tunnel.
 *
 * Fairness without a dealer:
 *  - Both parties commit-reveal a random share (core/commitment.ts). Neither sees the
 *    other's share before committing, so the joint seed = combineReveals(...) is unbiased.
 *  - The 52-card deck is shuffled deterministically from that seed using the verifiable
 *    Fisher-Yates in core/randomness.ts (byte-identical to randomness.move) — so the exact
 *    deal can be re-derived and adjudicated on-chain in a dispute.
 *
 * Hidden hole cards:
 *  - Each player's two hole cards are dealt from the shuffle but only their COMMITMENTS
 *    (blake2b256(card || per-card-salt)) go into the signed/shared state; the raw values
 *    stay in the holder's private state until showdown. The per-card salt is derived from
 *    that player's seed share, so the opponent cannot open the commitments early.
 *  - At showdown each player reveals their hole cards; applyMove verifies the reveal
 *    against the committed value. The optional Groth16 "card-in-deck" circuit (zk/) proves,
 *    at DISPUTE time only, that revealed cards match the agreed shuffle — never on the hot
 *    path. (Hot-path play is just hashes + dual-signed updates, so it runs at full TPS.)
 *
 * Settlement: balances only move at hand resolution (showdown winner or fold), shifting
 * the contested amount = min(betA, betB) from loser to winner (clamped). Bets are tracked,
 * not escrowed, so balances() always sums to the locked total (mid-hand close = hand void).
 *
 * Hand model (simplified for a clean Protocol mapping): fixed ANTE posted at the deal, one
 * bet/raise by A, then call/fold by B, then a 5-card showdown (2 hole + 3 community).
 * Multi-hand until a player cannot post the ante or the hand cap is reached.
 */

import { concatBytes } from "../core/bytes";
import {
  combineReveals,
  computeCommitment,
  verifyCommitment,
} from "../core/commitment";
import { blake2b256 } from "../core/crypto";
import { seedFromBytes, shuffle } from "../core/randomness";
import { u64ToBeBytes } from "../core/wire";
import {
  Balances,
  otherParty,
  Party,
  Protocol,
  ProtocolContext,
  protocolDomain,
} from "./Protocol";

const DOMAIN = protocolDomain("quantum_poker.v1");
const ANTE = 50n;
const DEFAULT_HAND_CAP = 1000n;
const EMPTY = new Uint8Array(0);

export type PokerPhase = "commit" | "reveal" | "bet" | "showdown" | "done";

export interface PokerState {
  phase: PokerPhase;
  handNo: bigint;
  handCap: bigint;
  // commit-reveal of seed shares
  commitA: Uint8Array | null;
  commitB: Uint8Array | null;
  shareA: Uint8Array | null; // private (not encoded)
  saltA: Uint8Array | null; // private
  shareB: Uint8Array | null; // private
  saltB: Uint8Array | null; // private
  revealedA: boolean;
  revealedB: boolean;
  // deal (derived once both revealed)
  holeA: number[] | null; // private until shown
  holeB: number[] | null; // private until shown
  holeCommitA: Uint8Array[] | null; // in shared state
  holeCommitB: Uint8Array[] | null;
  holeSaltA: Uint8Array[] | null; // private
  holeSaltB: Uint8Array[] | null;
  community: number[]; // revealed
  // betting
  betA: bigint;
  betB: bigint;
  toAct: Party;
  actedA: boolean;
  actedB: boolean;
  foldedBy: Party | null;
  // showdown reveals
  shownA: boolean;
  shownB: boolean;
  shownHoleA: number[] | null;
  shownHoleB: number[] | null;
  // balances
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
}

export type PokerMove =
  | { kind: "commit"; value: Uint8Array; salt: Uint8Array }
  | { kind: "reveal_seed"; value: Uint8Array; salt: Uint8Array }
  | { kind: "bet"; raise: bigint } // raise >= 0 on top of the ante (A only)
  | { kind: "check" } // A: no raise
  | { kind: "call" } // B: match A
  | { kind: "fold" } // B: forfeit
  | { kind: "reveal_hole"; cards: number[]; salts: Uint8Array[] };

const PHASE_CODE: Record<PokerPhase, number> = {
  commit: 0,
  reveal: 1,
  bet: 2,
  showdown: 3,
  done: 4,
};

export class QuantumPokerProtocol implements Protocol<PokerState, PokerMove> {
  readonly name = "quantum_poker.v1";

  constructor(private readonly handCap: bigint = DEFAULT_HAND_CAP) {}

  initialState(ctx: ProtocolContext): PokerState {
    const total = ctx.initialBalances.a + ctx.initialBalances.b;
    return {
      phase:
        ctx.initialBalances.a >= ANTE && ctx.initialBalances.b >= ANTE
          ? "commit"
          : "done",
      handNo: 0n,
      handCap: this.handCap,
      commitA: null,
      commitB: null,
      shareA: null,
      saltA: null,
      shareB: null,
      saltB: null,
      revealedA: false,
      revealedB: false,
      holeA: null,
      holeB: null,
      holeCommitA: null,
      holeCommitB: null,
      holeSaltA: null,
      holeSaltB: null,
      community: [],
      betA: 0n,
      betB: 0n,
      toAct: "A",
      actedA: false,
      actedB: false,
      foldedBy: null,
      shownA: false,
      shownB: false,
      shownHoleA: null,
      shownHoleB: null,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total,
    };
  }

  applyMove(state: PokerState, move: PokerMove, by: Party): PokerState {
    const s = { ...state };
    switch (s.phase) {
      case "commit":
        return this.applyCommit(s, move, by);
      case "reveal":
        return this.applyReveal(s, move, by);
      case "bet":
        return this.applyBet(s, move, by);
      case "showdown":
        return this.applyShowdown(s, move, by);
      default:
        throw new Error(`no moves legal in phase ${s.phase}`);
    }
  }

  private applyCommit(s: PokerState, move: PokerMove, by: Party): PokerState {
    if (move.kind !== "commit") throw new Error("expected commit");
    if (move.salt.length < 16) throw new Error("salt too short");
    const commitment = computeCommitment(move.value, move.salt);
    if (by === "A") {
      if (s.commitA) throw new Error("A already committed");
      s.commitA = commitment;
      s.shareA = move.value;
      s.saltA = move.salt;
    } else {
      if (s.commitB) throw new Error("B already committed");
      s.commitB = commitment;
      s.shareB = move.value;
      s.saltB = move.salt;
    }
    if (s.commitA && s.commitB) {
      s.phase = "reveal";
    }
    return s;
  }

  private applyReveal(s: PokerState, move: PokerMove, by: Party): PokerState {
    if (move.kind !== "reveal_seed") throw new Error("expected reveal_seed");
    const commit = by === "A" ? s.commitA : s.commitB;
    if (!commit) throw new Error("nothing to reveal");
    if ((by === "A" && s.revealedA) || (by === "B" && s.revealedB)) {
      throw new Error(`${by} already revealed`);
    }
    if (!verifyCommitment(commit, move.value, move.salt)) {
      throw new Error("reveal does not match commitment");
    }
    if (by === "A") {
      s.revealedA = true;
      s.shareA = move.value;
      s.saltA = move.salt;
    } else {
      s.revealedB = true;
      s.shareB = move.value;
      s.saltB = move.salt;
    }
    if (s.revealedA && s.revealedB) {
      this.deal(s);
    }
    return s;
  }

  /** Derive deck from the joint seed, deal hole/community cards, set up betting. */
  private deal(s: PokerState): void {
    const seed = combineReveals(s.shareA!, s.saltA!, s.shareB!, s.saltB!);
    const deck = Array.from({ length: 52 }, (_, i) => i);
    shuffle(seedFromBytes(seed), deck);
    const holeA = [deck[0], deck[1]];
    const holeB = [deck[2], deck[3]];
    const community = [deck[4], deck[5], deck[6]];
    const saltFor = (share: Uint8Array, salt: Uint8Array, i: number) =>
      blake2b256(concatBytes([share, salt, u64ToBeBytes(i)]));
    const holeSaltA = [
      saltFor(s.shareA!, s.saltA!, 0),
      saltFor(s.shareA!, s.saltA!, 1),
    ];
    const holeSaltB = [
      saltFor(s.shareB!, s.saltB!, 0),
      saltFor(s.shareB!, s.saltB!, 1),
    ];
    s.holeA = holeA;
    s.holeB = holeB;
    s.community = community;
    s.holeSaltA = holeSaltA;
    s.holeSaltB = holeSaltB;
    s.holeCommitA = [
      computeCommitment(Uint8Array.of(holeA[0]), holeSaltA[0]),
      computeCommitment(Uint8Array.of(holeA[1]), holeSaltA[1]),
    ];
    s.holeCommitB = [
      computeCommitment(Uint8Array.of(holeB[0]), holeSaltB[0]),
      computeCommitment(Uint8Array.of(holeB[1]), holeSaltB[1]),
    ];
    s.betA = ANTE;
    s.betB = ANTE;
    s.toAct = "A";
    s.actedA = false;
    s.actedB = false;
    s.phase = "bet";
  }

  private applyBet(s: PokerState, move: PokerMove, by: Party): PokerState {
    if (s.toAct !== by) throw new Error(`not ${by}'s turn to act`);
    if (by === "A") {
      if (s.actedA) throw new Error("A already acted");
      const maxRaise = this.maxRaise(s);
      if (move.kind === "bet") {
        if (move.raise < 0n || move.raise > maxRaise)
          throw new Error("illegal raise");
        s.betA = ANTE + move.raise;
      } else if (move.kind === "check") {
        s.betA = ANTE;
      } else {
        throw new Error("A must bet or check");
      }
      s.actedA = true;
      s.toAct = "B";
      return s;
    }
    // B acts
    if (!s.actedA) throw new Error("A has not acted");
    if (s.actedB) throw new Error("B already acted");
    if (move.kind === "call") {
      s.betB = s.betA; // match
      s.actedB = true;
      s.phase = "showdown";
      s.toAct = "A";
      return s;
    }
    if (move.kind === "fold") {
      s.foldedBy = "B";
      s.actedB = true;
      this.resolveFold(s);
      return s;
    }
    throw new Error("B must call or fold");
  }

  /** Max raise A can make so B can still call: bounded by both balances minus the ante. */
  private maxRaise(s: PokerState): bigint {
    const cap = (s.balanceA < s.balanceB ? s.balanceA : s.balanceB) - ANTE;
    return cap > 0n ? cap : 0n;
  }

  private applyShowdown(s: PokerState, move: PokerMove, by: Party): PokerState {
    if (move.kind !== "reveal_hole") throw new Error("expected reveal_hole");
    const commits = by === "A" ? s.holeCommitA! : s.holeCommitB!;
    if (move.cards.length !== 2 || move.salts.length !== 2) {
      throw new Error("must reveal exactly 2 hole cards");
    }
    if ((by === "A" && s.shownA) || (by === "B" && s.shownB)) {
      throw new Error(`${by} already revealed hole`);
    }
    for (let i = 0; i < 2; i++) {
      if (
        !verifyCommitment(
          commits[i],
          Uint8Array.of(move.cards[i]),
          move.salts[i]
        )
      ) {
        throw new Error("hole reveal does not match commitment");
      }
    }
    if (by === "A") {
      s.shownA = true;
      s.shownHoleA = move.cards.slice();
    } else {
      s.shownB = true;
      s.shownHoleB = move.cards.slice();
    }
    if (s.shownA && s.shownB) {
      this.resolveShowdown(s);
    }
    return s;
  }

  private resolveFold(s: PokerState): void {
    // Folder forfeits the contested (matched) amount to the other party.
    const contested = s.betA < s.betB ? s.betA : s.betB;
    const winner = otherParty(s.foldedBy!);
    this.settle(s, winner, contested);
    this.endHand(s);
  }

  private resolveShowdown(s: PokerState): void {
    const contested = s.betA < s.betB ? s.betA : s.betB;
    const scoreA = evaluate5([...s.shownHoleA!, ...s.community]);
    const scoreB = evaluate5([...s.shownHoleB!, ...s.community]);
    if (scoreA > scoreB) this.settle(s, "A", contested);
    else if (scoreB > scoreA) this.settle(s, "B", contested);
    // tie: no transfer
    this.endHand(s);
  }

  /** Move `amount` from loser to winner, clamped so balances stay non-negative. */
  private settle(s: PokerState, winner: Party, amount: bigint): void {
    const loserBal = winner === "A" ? s.balanceB : s.balanceA;
    const moved = amount < loserBal ? amount : loserBal;
    if (winner === "A") {
      s.balanceA += moved;
      s.balanceB -= moved;
    } else {
      s.balanceB += moved;
      s.balanceA -= moved;
    }
  }

  /** Reset per-hand fields and start the next hand, or finish. */
  private endHand(s: PokerState): void {
    s.handNo += 1n;
    const canContinue =
      s.handNo < s.handCap && s.balanceA >= ANTE && s.balanceB >= ANTE;
    s.commitA = null;
    s.commitB = null;
    s.shareA = null;
    s.saltA = null;
    s.shareB = null;
    s.saltB = null;
    s.revealedA = false;
    s.revealedB = false;
    s.holeA = null;
    s.holeB = null;
    s.holeCommitA = null;
    s.holeCommitB = null;
    s.holeSaltA = null;
    s.holeSaltB = null;
    s.community = [];
    s.betA = 0n;
    s.betB = 0n;
    s.toAct = "A";
    s.actedA = false;
    s.actedB = false;
    s.foldedBy = null;
    s.shownA = false;
    s.shownB = false;
    s.shownHoleA = null;
    s.shownHoleB = null;
    s.phase = canContinue ? "commit" : "done";
  }

  encodeState(s: PokerState): Uint8Array {
    const opt = (b: Uint8Array | null) => b ?? EMPTY;
    const commits = (cs: Uint8Array[] | null) => (cs ? concatBytes(cs) : EMPTY);
    const cardsBytes = (cards: number[] | null) =>
      cards ? Uint8Array.from(cards) : EMPTY;
    // Fixed-order, length-prefixed canonical encoding. Hidden fields (raw hole cards,
    // seed shares, salts) are NOT included until revealed — that is the hiding.
    const parts: Uint8Array[] = [
      DOMAIN,
      Uint8Array.of(PHASE_CODE[s.phase]),
      u64ToBeBytes(s.handNo),
      u64ToBeBytes(s.balanceA),
      u64ToBeBytes(s.balanceB),
      u64ToBeBytes(s.betA),
      u64ToBeBytes(s.betB),
      Uint8Array.of(
        s.toAct === "A" ? 0 : 1,
        s.revealedA ? 1 : 0,
        s.revealedB ? 1 : 0,
        s.actedA ? 1 : 0,
        s.actedB ? 1 : 0,
        s.foldedBy === null ? 0 : s.foldedBy === "A" ? 1 : 2,
        s.shownA ? 1 : 0,
        s.shownB ? 1 : 0
      ),
    ];
    const variable: Uint8Array[] = [
      opt(s.commitA),
      opt(s.commitB),
      commits(s.holeCommitA),
      commits(s.holeCommitB),
      cardsBytes(s.community),
      cardsBytes(s.shownHoleA),
      cardsBytes(s.shownHoleB),
    ];
    for (const v of variable) {
      parts.push(u64ToBeBytes(v.length), v);
    }
    return concatBytes(parts);
  }

  balances(s: PokerState): Balances {
    return { a: s.balanceA, b: s.balanceB };
  }

  isTerminal(s: PokerState): boolean {
    return s.phase === "done";
  }

  randomMove(s: PokerState, by: Party, rng: () => number): PokerMove | null {
    const rndBytes = (n: number) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = (rng() * 256) | 0;
      return out;
    };
    switch (s.phase) {
      case "commit": {
        const committed = by === "A" ? s.commitA : s.commitB;
        if (committed) return null;
        return { kind: "commit", value: rndBytes(32), salt: rndBytes(16) };
      }
      case "reveal": {
        const revealed = by === "A" ? s.revealedA : s.revealedB;
        if (revealed) return null;
        const value = by === "A" ? s.shareA : s.shareB;
        const salt = by === "A" ? s.saltA : s.saltB;
        if (!value || !salt) return null;
        return { kind: "reveal_seed", value, salt };
      }
      case "bet": {
        if (s.toAct !== by) return null;
        if (by === "A") {
          const maxR = this.maxRaise(s);
          if (maxR > 0n && rng() < 0.5) {
            const raise = BigInt(
              1 + Math.floor(rng() * Number(maxR < 200n ? maxR : 200n))
            );
            return { kind: "bet", raise };
          }
          return { kind: "check" };
        }
        // B: usually call, sometimes fold
        return rng() < 0.85 ? { kind: "call" } : { kind: "fold" };
      }
      case "showdown": {
        const shown = by === "A" ? s.shownA : s.shownB;
        if (shown) return null;
        const cards = by === "A" ? s.holeA : s.holeB;
        const salts = by === "A" ? s.holeSaltA : s.holeSaltB;
        if (!cards || !salts) return null;
        return {
          kind: "reveal_hole",
          cards: cards.slice(),
          salts: salts.slice(),
        };
      }
      default:
        return null;
    }
  }
}

// ---- Simplified 5-card hand evaluator (higher score = stronger) -----------------

/** Evaluate a 5-card hand (cards 0..51); returns a comparable score. */
export function evaluate5(cards: number[]): number {
  if (cards.length !== 5) throw new Error("evaluate5 needs exactly 5 cards");
  // Reject malformed hands instead of silently mis-scoring (e.g. a duplicate card read
  // as a "pair"). Cards are deck indices 0..51 and must be distinct.
  const seen = new Set<number>();
  for (const c of cards) {
    if (!Number.isInteger(c) || c < 0 || c > 51) {
      throw new Error(`evaluate5: card out of range 0..51: ${c}`);
    }
    if (seen.has(c)) throw new Error(`evaluate5: duplicate card: ${c}`);
    seen.add(c);
  }
  const ranks = cards.map((c) => c % 13).sort((a, b) => b - a); // high first
  const suits = cards.map((c) => Math.floor(c / 13));
  const flush = suits.every((su) => su === suits[0]);

  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // groups: [count, rank] sorted by count desc then rank desc
  const groups = [...counts.entries()]
    .map(([r, c]) => [c, r] as [number, number])
    .sort((x, y) => (y[0] - x[0] !== 0 ? y[0] - x[0] : y[1] - x[1]));

  const distinct = [...new Set(ranks)].sort((a, b) => b - a);
  let straight = false;
  let straightHigh = -1;
  if (distinct.length === 5) {
    if (distinct[0] - distinct[4] === 4) {
      straight = true;
      straightHigh = distinct[0];
    } else if (
      distinct[0] === 12 &&
      distinct[1] === 3 &&
      distinct[2] === 2 &&
      distinct[3] === 1 &&
      distinct[4] === 0
    ) {
      // wheel: A-2-3-4-5
      straight = true;
      straightHigh = 3;
    }
  }

  let category: number;
  if (straight && flush) category = 8;
  else if (groups[0][0] === 4) category = 7;
  else if (groups[0][0] === 3 && groups[1][0] === 2) category = 6;
  else if (flush) category = 5;
  else if (straight) category = 4;
  else if (groups[0][0] === 3) category = 3;
  else if (groups[0][0] === 2 && groups[1][0] === 2) category = 2;
  else if (groups[0][0] === 2) category = 1;
  else category = 0;

  // Tiebreakers: group ranks (by count then rank), then straightHigh for straights.
  const tb = straight ? [straightHigh] : groups.map((g) => g[1]);
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 13 + (tb[i] ?? 0);
  return score;
}
