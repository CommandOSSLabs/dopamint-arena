import { test } from "node:test";
import assert from "node:assert/strict";
import { MultiGameBattleshipProtocol } from "./protocol/multiGameBattleship";
import { randomFleetSecret } from "./engine/selfPlay";
import {
  type BattleshipTunnel,
  isHumanShootTurn,
  makeSeatBot,
  runBattleshipSelfPlayToEnd,
  stepBattleshipWithHuman,
} from "./battleshipSelfPlay";

const ctx = { tunnelId: "0x1", initialBalances: { a: 1000n, b: 1000n } };

// Minimal in-memory tunnel: the steppers only read `.state` and call `.step`.
function mockTunnel(proto: MultiGameBattleshipProtocol): BattleshipTunnel {
  let state = proto.initialState(ctx);
  return {
    get state() {
      return state;
    },
    step(move: never, by: never) {
      state = proto.applyMove(state, move, by);
      return {} as never;
    },
  } as unknown as BattleshipTunnel;
}
const SEED_CTX = (seed: number) => ({
  rngForSeat: () => {
    let x = seed >>> 0;
    return () => ((x = (x * 1664525 + 1013904223) >>> 0), x / 0x100000000);
  },
});

test("self-play via kit bots reaches a decisive game; balances conserved", () => {
  for (let s = 1; s <= 10; s++) {
    const proto = new MultiGameBattleshipProtocol(100n);
    const t = mockTunnel(proto);
    const botA = makeSeatBot(
      "A",
      100n,
      "hard",
      randomFleetSecret(seeded(s)),
      true,
      SEED_CTX(s),
    );
    const botB = makeSeatBot(
      "B",
      100n,
      "hard",
      randomFleetSecret(seeded(s + 99)),
      true,
      SEED_CTX(s + 99),
    );
    runBattleshipSelfPlayToEnd(t, botA, botB, 5000);
    const inner = t.state.inner;
    assert.equal(inner.phase, "over");
    assert.equal(inner.balanceA + inner.balanceB, inner.total);
  }
});

test("stepBattleshipWithHuman yields await-human only on the human's shot turn", () => {
  const proto = new MultiGameBattleshipProtocol(100n);
  const t = mockTunnel(proto);
  const botA = makeSeatBot(
    "A",
    100n,
    "hard",
    randomFleetSecret(seeded(1)),
    false,
    SEED_CTX(1),
  );
  const botB = makeSeatBot(
    "B",
    100n,
    "hard",
    randomFleetSecret(seeded(2)),
    true,
    SEED_CTX(2),
  );
  // Auto-run the openers (commits) until A owes a shot; the human gate must fire.
  let guard = 0;
  let step = stepBattleshipWithHuman(t, botA, botB, "A");
  while (step.kind === "applied" && guard++ < 100) {
    step = stepBattleshipWithHuman(t, botA, botB, "A");
  }
  assert.equal(step.kind, "await-human");
  assert.equal(isHumanShootTurn(t.state.inner, "A"), true);
});

function seeded(s: number): () => number {
  let x = s >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0), x / 0x100000000);
}
