import { deriveWalletFromPrivateKey } from "./wallet";
import { fromHEX, toHEX } from "@mysten/bcs";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";

export const getEd25519PublicKey = (privateKey: string) => {
  let key = deriveWalletFromPrivateKey(privateKey);
  return toHEX(key.getPublicKey().toRawBytes());
};
export const ed25519SignMessage = async (
  ed25519PrivateKey: string,
  message: Uint8Array
) => {
  const keyPair = deriveWalletFromPrivateKey(ed25519PrivateKey);
  const signature = toHEX(await keyPair.sign(message));
  return signature;
};

export const verifyEd25519Signature = async (
  publicKey: string | Uint8Array,
  message: string | Uint8Array,
  signature: string | Uint8Array
) => {
  const pubKeyBytes: Uint8Array = typeof publicKey === "string" ? fromHEX(publicKey) : publicKey;
  const messageBytes: Uint8Array = typeof message === "string" ? fromHEX(message) : message;
  const signatureBytes: Uint8Array = typeof signature === "string" ? fromHEX(signature) : signature;
  return new Ed25519PublicKey(pubKeyBytes).verify(messageBytes, signatureBytes);
};
