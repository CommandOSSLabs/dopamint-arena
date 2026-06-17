import { bcs, fromHEX, toHEX } from "@mysten/bcs";

export const ID32 = bcs.fixedArray(32, bcs.u8()).transform({
  input: (id: string) => fromHEX(id),
  output: (id) => toHEX(Uint8Array.from(id)),
});

export const GameStateStruct = bcs.struct("GameState", {
  game_id: ID32,
  player_public_key: bcs.vector(bcs.u8()),
  board: bcs.vector(bcs.u8()),
  move_index: bcs.u8(),
  player: bcs.u8(),
  turn: bcs.u8(),
  step: bcs.u64(),
  status: bcs.u8(),
});

export interface GameState {
  game_id: string;           // 32-byte hex
  player_public_key: string; // hex
  board: number[];           // length 9
  move_index: number;
  player: number;
  turn: number;
  step: number;
  status: number;
}

export function toBytes(state: GameState): Uint8Array {
  return GameStateStruct.serialize({
    game_id: state.game_id,
    player_public_key: fromHEX(state.player_public_key),
    board: state.board,
    move_index: state.move_index,
    player: state.player,
    turn: state.turn,
    step: BigInt(state.step),
    status: state.status,
  }).toBytes();
}

export function serialize(state: GameState): string {
  return toHEX(toBytes(state));
}

export function fromHex(hex: string): GameState {
  const p = GameStateStruct.parse(fromHEX(hex));
  return {
    game_id: p.game_id,
    player_public_key: toHEX(Uint8Array.from(p.player_public_key)),
    board: Array.from(p.board),
    move_index: p.move_index,
    player: p.player,
    turn: p.turn,
    step: Number(p.step),
    status: p.status,
  };
}
