import { describe, expect, it } from "bun:test";
import { GameState, serialize, fromHex, toBytes } from "./state";
import { NONE, TURN_PLAYER, STATUS_ONGOING } from "../constants";

const sample = (): GameState => ({
  game_id: "11".repeat(32),
  player_public_key: "ab".repeat(32),
  board: [0, 1, 2, 0, 0, 0, 0, 0, 0],
  move_index: NONE,
  player: 0,
  turn: TURN_PLAYER,
  step: 0,
  status: STATUS_ONGOING,
});

describe("GameState BCS", () => {
  it("round-trips through serialize/fromHex", () => {
    const s = sample();
    expect(fromHex(serialize(s))).toEqual(s);
  });

  it("round-trips a large step (u64)", () => {
    const s = { ...sample(), step: 9 };
    expect(fromHex(serialize(s)).step).toBe(9);
  });

  it("toBytes is deterministic for identical states", () => {
    expect(toBytes(sample())).toEqual(toBytes(sample()));
  });
});
