import { test, expect, describe } from "bun:test";
import {
  BlackjackBetProtocol,
  FIXED_PLAYER_A,
  MIN_BET,
  maxBet,
  actorFor,
  fixedBetMove,
  type BetBlackjackState,
} from "./bjBetProtocol";
import { handValue } from "./bjCards";

const ctx = (a: bigint, b: bigint) => ({
  tunnelId: "0xt",
  initialBalances: { a, b },
});
const proto = new BlackjackBetProtocol();

describe("BlackjackBetProtocol", () => {
  test("starts in round_over (betting), no cards dealt", () => {
    const s = proto.initialState(ctx(5000n, 5000n));
    expect(s.phase).toBe("round_over");
    expect(s.round).toBe(0n);
    expect(s.playerHand.length).toBe(0);
    expect(maxBet(s)).toBe(5000n);
  });

  test("a bet by the player deals a round with that bet", () => {
    const s = proto.applyMove(
      proto.initialState(ctx(5000n, 5000n)),
      { action: "bet", amount: 500 },
      "A",
    );
    expect(s.phase).toBe("player");
    expect(s.round).toBe(1n);
    expect(s.bet).toBe(500n);
    expect(s.playerHand.length).toBe(2);
    expect(s.dealerHand.length).toBe(2);
  });

  test("rejects bets out of range and bets from the dealer", () => {
    const s = proto.initialState(ctx(5000n, 5000n));
    expect(() =>
      proto.applyMove(s, { action: "bet", amount: 10 }, "A"),
    ).toThrow(); // < MIN_BET
    expect(() =>
      proto.applyMove(s, { action: "bet", amount: 6000 }, "A"),
    ).toThrow(); // > maxBet
    expect(() =>
      proto.applyMove(s, { action: "bet", amount: 100 }, "B"),
    ).toThrow(); // dealer can't bet
    expect(() => proto.applyMove(s, { action: "hit" }, "A")).toThrow(); // must bet first
  });

  test("max bet is clamped to the poorer side", () => {
    expect(maxBet(proto.initialState(ctx(5000n, 300n)))).toBe(300n);
  });

  test("a full round swaps the CHOSEN bet (not a fixed wager) and conserves the total", () => {
    let s = proto.applyMove(
      proto.initialState(ctx(5000n, 5000n)),
      { action: "bet", amount: 1000 },
      "A",
    );
    // play out: player stands, dealer stands -> resolve + settle
    s = proto.applyMove(s, { action: "stand" }, "A");
    expect(s.phase).toBe("dealer");
    s = proto.applyMove(s, { action: "stand" }, "B");
    expect(s.phase).toBe("round_over");
    expect(s.balanceA + s.balanceB).toBe(10000n); // conserved
    // the swap was the chosen bet (1000), a push leaves balances unchanged
    const delta = s.balanceA - 5000n;
    expect([1000n, -1000n, 0n]).toContain(delta);
  });

  test("encodeState is deterministic and varies with the bet", () => {
    const base = proto.initialState(ctx(5000n, 5000n));
    const a = proto.applyMove(base, { action: "bet", amount: 100 }, "A");
    const b = proto.applyMove(base, { action: "bet", amount: 500 }, "A");
    expect(Buffer.from(proto.encodeState(a)).toString("hex")).toBe(
      Buffer.from(proto.encodeState({ ...a })).toString("hex"),
    );
    expect(Buffer.from(proto.encodeState(a)).toString("hex")).not.toBe(
      Buffer.from(proto.encodeState(b)).toString("hex"),
    );
  });

  test("terminal when a side can't cover the minimum bet", () => {
    const broke: BetBlackjackState = {
      ...proto.initialState(ctx(5000n, 5000n)),
      balanceB: 10n,
    };
    expect(maxBet(broke)).toBe(10n);
    expect(10n < MIN_BET).toBe(true);
    expect(proto.isTerminal(broke)).toBe(true);
  });
});

// Regression for the bot-mode "settles after ~2 rounds" bug. The play loop must pick the actor
// the protocol expects each phase; the protocol alternates the player A,A,B,B per round, so a
// loop that always treats non-dealer phases as "A" stalls the moment the bettor flips to B.
describe("bot self-play driver", () => {
  // Faithful replay of the ORIGINAL buggy loop: actor = dealer?B:A, move = randomMove for every
  // phase. randomMove returns null when the fixed actor isn't the designated player, which the
  // loop reads as "no move -> game over" and settles.
  function playOriginalBuggy(stake: bigint, target: number): number {
    let s = proto.initialState(ctx(stake, stake));
    let completed = 0;
    for (let steps = 0; steps < 100_000; steps++) {
      if (proto.isTerminal(s)) break;
      const by: "A" | "B" = s.phase === "dealer" ? "B" : "A";
      const move = proto.randomMove(s, by, Math.random);
      if (!move) break;
      const prevPhase = s.phase;
      s = proto.applyMove(s, move, by);
      if (s.phase === "round_over" && prevPhase !== "round_over") {
        if (++completed >= target) break;
      }
    }
    return completed;
  }

  // The FIXED loop: actor = actorFor(state), and a chosen fixed bet in the betting phase.
  function playFixed(stake: bigint, betAmount: number, target: number): number {
    let s = proto.initialState(ctx(stake, stake));
    let completed = 0;
    for (let steps = 0; steps < 1_000_000; steps++) {
      if (proto.isTerminal(s)) break;
      const by = actorFor(s);
      const move =
        s.phase === "round_over"
          ? fixedBetMove(betAmount, s)
          : proto.randomMove(s, by, Math.random);
      if (!move) break;
      const prevPhase = s.phase;
      s = proto.applyMove(s, move, by);
      if (s.phase === "round_over" && prevPhase !== "round_over") {
        if (++completed >= target) break;
      }
    }
    return completed;
  }

  test("the original fixed-party loop stalls after 2 rounds regardless of the target", () => {
    expect(playOriginalBuggy(5_000_000n, 100)).toBe(2);
  });

  test("actorFor + a fixed bet reaches the requested target when the buy-in covers it", () => {
    expect(playFixed(5_000_000n, 100, 50)).toBe(50);
    expect(playFixed(5_000_000n, 100, 100)).toBe(100);
  });

  test("a buy-in too small for the target is capped by bankroll, not the 2-round bug", () => {
    const rounds = playFixed(500n, 100, 100);
    expect(rounds).toBeGreaterThan(2);
    expect(rounds).toBeLessThan(100);
  });
});

describe("FIXED_PLAYER_A (Play vs Bot — no role rotation)", () => {
  const ctx2 = (a: bigint, b: bigint) => ({
    tunnelId: "0xt",
    initialBalances: { a, b },
  });

  test("seat A always holds the player role; seat B always the dealer", () => {
    const p = new BlackjackBetProtocol(FIXED_PLAYER_A);
    let s = p.initialState(ctx2(5000n, 5000n));
    for (let i = 0; i < 40 && !p.isTerminal(s); i++) {
      const by = p.actorFor(s);
      if (s.phase === "player") expect(by).toBe("A");
      if (s.phase === "dealer") expect(by).toBe("B");
      const move =
        s.phase === "round_over"
          ? fixedBetMove(100, s)
          : p.randomMove(s, by, Math.random);
      if (!move) break;
      s = p.applyMove(s, move, by);
    }
  });

  // The bug this guards: when the player role rotated to seat B, party A's balance delta
  // inverted the displayed win/lose (player 21 vs dealer 17 logged as a LOSS). Pinning the
  // player to seat A makes balanceA's change always agree with the hand comparison.
  test("balanceA's change never contradicts the player-vs-dealer hand result", () => {
    const p = new BlackjackBetProtocol(FIXED_PLAYER_A);
    let s = p.initialState(ctx2(5000n, 5000n));
    let resolved = 0;
    for (let steps = 0; steps < 100_000 && resolved < 40; steps++) {
      if (p.isTerminal(s)) break;
      const by = p.actorFor(s);
      const move =
        s.phase === "round_over"
          ? fixedBetMove(100, s)
          : p.randomMove(s, by, Math.random);
      if (!move) break;
      const prevPhase = s.phase;
      const prevA = s.balanceA;
      s = p.applyMove(s, move, by);
      if (s.phase === "round_over" && prevPhase !== "round_over") {
        resolved++;
        const pv = handValue(s.playerHand);
        const dv = handValue(s.dealerHand);
        const delta = s.balanceA - prevA;
        const playerWon = dv > 21 || (pv <= 21 && pv > dv);
        const dealerWon = pv > 21 || (dv <= 21 && dv > pv);
        if (playerWon) expect(delta > 0n).toBe(true);
        else if (dealerWon) expect(delta < 0n).toBe(true);
        else expect(delta).toBe(0n);
      }
    }
    expect(resolved).toBeGreaterThan(0);
  });
});
