import { Ed25519Keypair, Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { fromHEX, toHEX } from "@mysten/bcs";

export function generateKeypair(): {
  privateKeyHex: string;
  publicKeyHex: string;
} {
  const kp = new Ed25519Keypair();
  const { secretKey } = decodeSuiPrivateKey(kp.getSecretKey()); // 32 raw bytes
  return {
    privateKeyHex: toHEX(secretKey),
    publicKeyHex: toHEX(kp.getPublicKey().toRawBytes()),
  };
}

export function keypairFromSecret(privateKeyHex: string): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(fromHEX(privateKeyHex));
}

export async function sign(
  messageHex: string,
  privateKeyHex: string,
): Promise<string> {
  const sig = await keypairFromSecret(privateKeyHex).sign(fromHEX(messageHex));
  return toHEX(sig);
}

export async function verify(
  publicKeyHex: string,
  messageHex: string,
  signatureHex: string,
): Promise<boolean> {
  const pub = new Ed25519PublicKey(fromHEX(publicKeyHex));
  return pub.verify(fromHEX(messageHex), fromHEX(signatureHex));
}
