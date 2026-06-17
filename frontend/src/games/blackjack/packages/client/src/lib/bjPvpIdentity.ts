/**
 * PvP identities. Two independent keys per the integration doc:
 *  - WALLET: a @mysten Ed25519Keypair, seed in localStorage, faucet-funded; on-chain identity
 *    (funds the stake, receives winnings). Reused across matches.
 *  - EPHEMERAL: a fresh SDK keypair per match (IndexedDB by matchId); signs every move + the
 *    lobby connect nonce. Holds no funds.
 * The party.hello attestation signs `matchId‖ephemeralPubkeyHex` with the wallet via Sui
 * personal-message; the opponent verifies it client-side against `opponentWallet`.
 */
import { core } from "sui-tunnel-ts";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { fromHEX, toHEX } from "@mysten/sui/utils";

const WALLET_KEY = "bj_pvp_wallet.v1";

export interface EphemeralKey {
  coreKey: ReturnType<typeof core.keyPairFromSecret>; // { publicKey, secretKey }
  pubkeyHex: string;
}

/** Load (or create + persist) this browser's faucet-funded wallet keypair. */
export function loadOrCreateWallet(): Ed25519Keypair {
  let seed: Uint8Array;
  try {
    const stored = localStorage.getItem(WALLET_KEY);
    if (stored) seed = fromHEX(stored);
    else {
      seed = core.generateKeyPair().secretKey;
      localStorage.setItem(WALLET_KEY, toHEX(seed));
    }
  } catch {
    seed = core.generateKeyPair().secretKey;
  }
  return Ed25519Keypair.fromSecretKey(seed);
}

const dbReq = () => indexedDB.open("bj_pvp", 1);
function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = dbReq();
    req.onupgradeneeded = () => req.result.createObjectStore("eph");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("eph", mode);
      const r = fn(tx.objectStore("eph"));
      r.onsuccess = () => resolve(r.result as T);
      r.onerror = () => reject(r.error);
    };
  });
}

/** Get the persisted ephemeral key for `matchId`, or mint+persist a fresh one. */
export async function getOrCreateEphemeral(matchId: string): Promise<EphemeralKey> {
  const existing = await withStore<string | undefined>("readonly", (s) => s.get(matchId));
  const seed = existing ? fromHEX(existing) : core.generateKeyPair().secretKey;
  if (!existing) await withStore("readwrite", (s) => s.put(toHEX(seed), matchId));
  const coreKey = core.keyPairFromSecret(seed);
  return { coreKey, pubkeyHex: toHEX(coreKey.publicKey) };
}

/** The bytes a wallet signs to attest its ephemeral key for a match (shared by sign + verify,
 *  and by the dapp-kit signing path in the PvP hook). */
export function attestationMessage(matchId: string, ephPubHex: string): Uint8Array {
  return new TextEncoder().encode(`${matchId}:${ephPubHex}`);
}

/** Wallet signs the attestation (Sui personal-message, base64). */
export async function attestEphemeral(
  wallet: Ed25519Keypair,
  matchId: string,
  ephPubHex: string,
): Promise<string> {
  const { signature } = await wallet.signPersonalMessage(attestationMessage(matchId, ephPubHex));
  return signature;
}

/** Verify an opponent's attestation: recovers the signer and checks it equals `walletAddr`. */
export async function verifyAttestation(
  matchId: string,
  ephPubHex: string,
  walletSig: string,
  walletAddr: string,
): Promise<boolean> {
  try {
    const pk = await verifyPersonalMessageSignature(attestationMessage(matchId, ephPubHex), walletSig);
    return pk.toSuiAddress() === walletAddr;
  } catch {
    return false;
  }
}
