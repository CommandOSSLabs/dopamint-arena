import { PrismaClient } from "@prisma/client";
import {
  createGameActionData,
  GameActionData,
  GameActionDataType,
} from "@poc/shared";
import { toHEX } from "@mysten/bcs";

const prisma = new PrismaClient();

export const saveGameActionData = async (
  gameActionDataHex: string,
  playerSignature: string,
  dealerSignature: string
) => {
  const gameActionData = GameActionData.fromHex(gameActionDataHex);
  return await prisma.gameActionData.create({
    data: {
      gameId: gameActionData.game_id,
      round: BigInt(gameActionData.round),
      step: BigInt(gameActionData.step),
      playerSignature,
      dealerSignature,
      hex: gameActionDataHex,
    },
  });
};

export const getGameActionData = async ({
  gameId,
  round,
  step,
}: {
  gameId: string;
  round?: BigInt;
  step?: BigInt;
}) => {
  const whereClause: any = { gameId };

  if (round !== undefined) {
    whereClause.round = round;
  }

  if (step !== undefined) {
    whereClause.step = step;
  }

  return await prisma.gameActionData.findMany({
    where: whereClause,
  });
};
