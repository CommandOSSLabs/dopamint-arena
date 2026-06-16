import { fromHEX, toHEX } from "@mysten/bcs";

import {
  getPublicKey as getBlsPublicKey,
  utils as blsUtils,
  verify as blsVerify,
  sign as blsSign,
} from "@noble/bls12-381";

export const generateBlsSignature = async (
  gameActionDataHex: string,
  blsKey: string
): Promise<string> => {
  // Replace this with actual BLS signature generation logic.
  const blsSignature = await blsSign(fromHEX(gameActionDataHex), blsKey);
  return toHEX(blsSignature);
};
