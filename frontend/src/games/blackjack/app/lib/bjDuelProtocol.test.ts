import { test, expect, describe } from "bun:test";
import {
  BlackjackDuelProtocol,
  settleOutcome,
  STAKE,
  type DuelState,
} from "./bjDuelProtocol";

const ctx = (tunnelId: string) => ({
  tunnelId,
  initialBalances: { a: STAKE, b: STAKE },
});

describe("settleOutcome (head-to-head vs shared dealer)", () => {
  // dealer=20. A=21 beats dealer (WIN); B=19 loses (LOSE) -> A wins.
  test("higher result-vs-dealer wins", () => {
    expect(settleOutcome([10, 11], [10, 9], [10, 10])).toBe("A"); // A 21 win, B 19 lose
  });
  // both beat dealer (dealer 17): tie-break by hand value (A 20 > B 18).
  test("both beat dealer -> closer to 21 wins", () => {
    expect(settleOutcome([10, 10], [10, 8], [10, 7])).toBe("A");
  });
  // A busts (LOSE), B 18 vs dealer 17 (WIN) -> B wins.
  test("bust loses to a standing hand", () => {
    expect(settleOutcome([10, 10, 5], [10, 8], [10, 7])).toBe("B");
  });
  // both bust -> both LOSE, equal value 0 -> push.
  test("both bust -> push", () => {
    expect(settleOutcome([10, 10, 5], [10, 10, 6], [10, 7])).toBe("push");
  });
  // identical results and values -> push.
  test("equal result and value -> push", () => {
    expect(settleOutcome([10, 9], [10, 9], [10, 7])).toBe("push"); // both 19, both beat dealer 17
  });
});

describe("BlackjackDuelProtocol", () => {
  const proto = new BlackjackDuelProtocol();

  test("initial state deals dealer/A/B two cards each, A to move", () => {
    const s = proto.initialState(ctx("0xtunnel1"));
    expect(s.dealerHand.length).toBe(2);
    expect(s.handA.length).toBe(2);
    expect(s.handB.length).toBe(2);
    expect(s.phase).toBe("a_turn");
    expect(s.balanceA).toBe(STAKE);
    expect(s.balanceB).toBe(STAKE);
  });

  test("encodeState is deterministic for the same tunnelId, differs across tunnels", () => {
    const a1 = proto.encodeState(proto.initialState(ctx("0xtunnelA")));
    const a2 = proto.encodeState(proto.initialState(ctx("0xtunnelA")));
    const b = proto.encodeState(proto.initialState(ctx("0xtunnelB")));
    expect(Buffer.from(a1).toString("hex")).toBe(
      Buffer.from(a2).toString("hex"),
    );
    expect(Buffer.from(a1).toString("hex")).not.toBe(
      Buffer.from(b).toString("hex"),
    );
  });

  test("rejects out-of-turn moves and moves after the duel is over", () => {
    const s = proto.initialState(ctx("0xtunnel1"));
    expect(() => proto.applyMove(s, { action: "stand" }, "B")).toThrow(); // A's turn
    // A stands -> B's turn; A can't move now
    const s2 = proto.applyMove(s, { action: "stand" }, "A");
    expect(s2.phase).toBe("b_turn");
    expect(() => proto.applyMove(s2, { action: "stand" }, "A")).toThrow();
  });

  test("a full both-stand game resolves the dealer and is terminal with conserved balances", () => {
    let s = proto.initialState(ctx("0xtunnelFull"));
    s = proto.applyMove(s, { action: "stand" }, "A");
    s = proto.applyMove(s, { action: "stand" }, "B"); // triggers dealer + settle
    expect(s.phase).toBe("over");
    expect(proto.isTerminal(s)).toBe(true);
    expect(s.dealerHand.length).toBeGreaterThanOrEqual(2); // dealer drew to >=17 (or stood)
    expect(s.balanceA + s.balanceB).toBe(STAKE * 2n); // conserved
    expect(() => proto.applyMove(s, { action: "stand" }, "A")).toThrow(); // over
  });

  test("randomMove plays basic strategy for the side to move only", () => {
    const s = proto.initialState(ctx("0xtunnel1"));
    const mv = proto.randomMove(s, "A", Math.random);
    expect(mv === null || mv.action === "hit" || mv.action === "stand").toBe(
      true,
    );
    expect(proto.randomMove(s, "B", Math.random)).toBeNull(); // not B's turn
  });
});
