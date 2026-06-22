import { fromHEX, toHEX } from "@mysten/bcs";
import {
  sign as blsSign,
  verify as blsVerify,
  getPublicKey,
} from "@noble/bls12-381";

export async function sign(
  messageHex: string,
  privateKeyHex: string,
): Promise<string> {
  const sig = await blsSign(fromHEX(messageHex), privateKeyHex);
  return toHEX(sig);
}

export async function verify(
  publicKeyHex: string,
  messageHex: string,
  signatureHex: string,
): Promise<boolean> {
  return blsVerify(fromHEX(signatureHex), fromHEX(messageHex), publicKeyHex);
}

export function publicKeyFromPrivate(privateKeyHex: string): string {
  return toHEX(getPublicKey(privateKeyHex));
}
