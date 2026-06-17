import { test, expect, describe } from "bun:test";
import { BlackjackBetProtocol, MIN_BET, maxBet, type BetBlackjackState } from "./bjBetProtocol";

const ctx = (a: bigint, b: bigint) => ({ tunnelId: "0xt", initialBalances: { a, b } });
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
    const s = proto.applyMove(proto.initialState(ctx(5000n, 5000n)), { action: "bet", amount: 500 }, "A");
    expect(s.phase).toBe("player");
    expect(s.round).toBe(1n);
    expect(s.bet).toBe(500n);
    expect(s.playerHand.length).toBe(2);
    expect(s.dealerHand.length).toBe(2);
  });

  test("rejects bets out of range and bets from the dealer", () => {
    const s = proto.initialState(ctx(5000n, 5000n));
    expect(() => proto.applyMove(s, { action: "bet", amount: 10 }, "A")).toThrow(); // < MIN_BET
    expect(() => proto.applyMove(s, { action: "bet", amount: 6000 }, "A")).toThrow(); // > maxBet
    expect(() => proto.applyMove(s, { action: "bet", amount: 100 }, "B")).toThrow(); // dealer can't bet
    expect(() => proto.applyMove(s, { action: "hit" }, "A")).toThrow(); // must bet first
  });

  test("max bet is clamped to the poorer side", () => {
    expect(maxBet(proto.initialState(ctx(5000n, 300n)))).toBe(300n);
  });

  test("a full round swaps the CHOSEN bet (not a fixed wager) and conserves the total", () => {
    let s = proto.applyMove(proto.initialState(ctx(5000n, 5000n)), { action: "bet", amount: 1000 }, "A");
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
    expect(Buffer.from(proto.encodeState(a)).toString("hex")).toBe(Buffer.from(proto.encodeState({ ...a })).toString("hex"));
    expect(Buffer.from(proto.encodeState(a)).toString("hex")).not.toBe(Buffer.from(proto.encodeState(b)).toString("hex"));
  });

  test("terminal when a side can't cover the minimum bet", () => {
    const broke: BetBlackjackState = { ...proto.initialState(ctx(5000n, 5000n)), balanceB: 10n };
    expect(maxBet(broke)).toBe(10n);
    expect(10n < MIN_BET).toBe(true);
    expect(proto.isTerminal(broke)).toBe(true);
  });
});
