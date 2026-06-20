import { describe, it } from "node:test";
import assert from "node:assert";
import { TicTacToeProtocol } from "sui-tunnel-ts/protocol/ticTacToe";
import { driveToTerminal } from "./testHarness";
import { defaultStateHash, type GameBot, type GameKit } from "./gameKit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";

describe("testHarness", () => {
  it("drives a simple SDK tic-tac-toe game to terminal", () => {
    const protocol = new TicTacToeProtocol(10n);
    const ctx: ProtocolContext = {
      tunnelId: "tunnel-1",
      initialBalances: { a: 100n, b: 100n },
    };

    const kit: GameKit<unknown, unknown> = {
      id: "tictactoe",
      protocol: protocol as never,
      stateHash: (s) => defaultStateHash(protocol as never, s as never),
      createBot: (seat) =>
        ({
          plan: (state) => protocol.randomMove(state as never, seat, Math.random),
          confirm: () => {},
          abort: () => {},
        }) as GameBot<unknown, unknown>,
      defaultStake: 10n,
    };

    const botA = kit.createBot("A", { rngForSeat: () => Math.random });
    const botB = kit.createBot("B", { rngForSeat: () => Math.random });
    const result = driveToTerminal(kit, botA, botB, ctx);

    assert.ok(protocol.isTerminal(result.finalState as never));
    assert.ok(result.accepted > 0);
  });
});
