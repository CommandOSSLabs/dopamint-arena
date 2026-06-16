import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
export function deriveWalletFromPrivateKey(privateKey: string) {
  const { secretKey: parsedSecretKey } = decodeSuiPrivateKey(privateKey);
  const keypair = Ed25519Keypair.fromSecretKey(parsedSecretKey);
  return keypair;
}
