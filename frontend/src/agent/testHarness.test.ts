import { describe, it } from "node:test";
import assert from "node:assert";
import {
  TicTacToeProtocol,
  type TicTacToeState,
  type TicTacToeMove,
} from "sui-tunnel-ts/protocol/ticTacToe";
import { driveToTerminal } from "./testHarness";
import { defaultStateHash, type GameBot, type GameKit } from "./gameKit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";

function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

describe("testHarness", () => {
  it("drives a simple SDK tic-tac-toe game to terminal", () => {
    const protocol = new TicTacToeProtocol(10n);
    const ctx: ProtocolContext = {
      tunnelId: "tunnel-1",
      initialBalances: { a: 100n, b: 100n },
    };

    const kit: GameKit<TicTacToeState, TicTacToeMove> = {
      id: "tictactoe",
      protocol,
      stateHash: (s) => defaultStateHash(protocol, s),
      createBot: (seat, ctx) =>
        ({
          plan: (state) =>
            protocol.randomMove(state, seat, ctx.rngForSeat(seat)),
          confirm: () => {},
          abort: () => {},
        }) as GameBot<TicTacToeState, TicTacToeMove>,
      defaultStake: 10n,
    };

    const botA = kit.createBot("A", { rngForSeat: () => seededRng(1) });
    const botB = kit.createBot("B", { rngForSeat: () => seededRng(2) });
    const result = driveToTerminal(kit, botA, botB, ctx);

    assert.ok(protocol.isTerminal(result.finalState));
    assert.ok(result.accepted > 0);
  });
});
