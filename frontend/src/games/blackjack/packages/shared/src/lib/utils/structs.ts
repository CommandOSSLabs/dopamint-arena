import { bcs, fromHEX, toHEX } from "@mysten/bcs";

export const ID = bcs.fixedArray(32, bcs.u8()).transform({
  input: (id: string) => fromHEX(id),
  output: (id) => toHEX(Uint8Array.from(id)),
});

// PartyBalance
// public struct PartyBalance has copy, drop, store {
//   player: u64,
//   dealer: u64,
// }
export const PartyBalance = bcs.struct("partyBalance", {
  player: bcs.u64(),
  dealer: bcs.u64(),
});

// Hands
// public struct Hands has copy, drop, store {
//   player: vector<u8>,
//   dealer: vector<u8>,
//   deck: vector<u8>,
// }
export const Hands = bcs.struct("Hands", {
  player: bcs.vector(bcs.u8()),
  dealer: bcs.vector(bcs.u8()),
  deck: bcs.vector(bcs.u8()),
});

Hands.fromHex;

// GameInitData: [balance between player and dealer initially, randomness seed, game id, bet amount, round = 0, step = 0, action = "init"
// public struct GameInitData has copy, drop, store {
//   game_id: ID,
//   balance: PartyBalance,
//   randomness_seed: vector<u8>,
//   bet_amount: u64,
//   round: u64,
//   step: u64,
//   action: u8,
// }
export const GameInitData = bcs.struct("GameInitData", {
  game_id: ID,
  balance: PartyBalance,
  randomness_seed: bcs.vector(bcs.u8()),
  bet_amount: bcs.u64(),
  round: bcs.u64(),
  step: bcs.u64(),
  action: bcs.u8(),
});

export const createGameInitData = ({
  game_id,
  balance,
  randomness_seed,
  bet_amount,
  round,
  step,
  action,
}: {
  game_id: string;
  balance: { player: number; dealer: number };
  randomness_seed: string;
  bet_amount: number;
  round: number;
  step: number;
  action: number;
}) => {
  return GameInitData.serialize({
    game_id: ID.fromHex(game_id),
    balance: {
      player: balance.player,
      dealer: balance.dealer,
    },
    randomness_seed: fromHEX(randomness_seed),
    bet_amount: bet_amount,
    round: round,
    step: step,
    action: action,
  });
};

export const GameActionData = bcs.struct("GameActionData", {
  game_id: ID,
  balance: PartyBalance,
  randomness_seed: bcs.vector(bcs.u8()),
  bet_amount: bcs.u64(),
  round: bcs.u64(),
  step: bcs.u64(),
  action: bcs.u8(),
  current_hands: Hands,
});

export const GameActionDataToBytes = (data: any) => {
  return GameActionData.serialize(data).toBytes();
};

export const createGameActionData = ({
  game_id,
  balance,
  randomness_seed,
  bet_amount,
  round,
  step,
  action,
  current_hands,
}: {
  game_id: string;
  balance: { player: number; dealer: number };
  randomness_seed: string;
  bet_amount: number;
  round: number;
  step: number;
  action: number;
  current_hands: { player: number[]; dealer: number[]; deck: number[] };
}) => {
  return GameActionData.serialize({
    game_id: ID.fromHex(game_id),
    balance: {
      player: balance.player,
      dealer: balance.dealer,
    },
    randomness_seed: fromHEX(randomness_seed),
    bet_amount: bet_amount,
    round: round,
    step: step,
    action: action,
    current_hands: {
      player: current_hands.player,
      dealer: current_hands.dealer,
      deck: current_hands.deck,
    },
  });
};

interface PartyBalanceType {
  player: number;
  dealer: number;
}

interface HandsType {
  player: number[];
  dealer: number[];
  deck: number[];
}

export interface GameActionDataType {
  game_id: string;
  balance: PartyBalanceType;
  randomness_seed: number[];
  bet_amount: string;
  round: string;
  step: string;
  action: number;
  current_hands: HandsType;
}
