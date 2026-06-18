/**
 * PvP identity: ONE local ed25519 keypair per browser, faucet-funded, used as BOTH the on-chain
 * wallet (open/deposit/close txs) AND the off-chain tunnel move-signer. One seed, two derivations
 * (Sui `Ed25519Keypair` + SDK `core.KeyPair`); we assert their public keys match so the on-chain
 * `PartyConfig.public_key` equals the off-chain signer. Mirrors `lib/bots.ts`. Throwaway testnet
 * identity — the security boundary is the on-chain seat (lobby identity is self-asserted in v1).
 */
import { core } from "sui-tunnel-ts";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromHEX, toHEX } from "@mysten/sui/utils";
import { requestSuiFromFaucetV2, getFaucetHost } from "@mysten/sui/faucet";
import type { SuiClient } from "@mysten/sui/client";

const ME_KEY = "ttt_pvp_me.v1";

export interface PvpIdentity {
  coreKey: ReturnType<typeof core.keyPairFromSecret>; // off-chain signer { publicKey, secretKey }
  keypair: Ed25519Keypair; // on-chain signer
  address: string;
  pubkeyHex: string; // 32-byte ed25519 public key, hex
}

/** Build both derivations from a 32-byte seed and assert they agree. Pure (unit-testable). */
export function deriveMe(seed: Uint8Array): PvpIdentity {
  const coreKey = core.keyPairFromSecret(seed);
  const keypair = Ed25519Keypair.fromSecretKey(seed);
  if (toHEX(coreKey.publicKey) !== toHEX(keypair.getPublicKey().toRawBytes())) {
    throw new Error("pvp identity: off/on-chain pubkey mismatch");
  }
  return { coreKey, keypair, address: keypair.getPublicKey().toSuiAddress(), pubkeyHex: toHEX(coreKey.publicKey) };
}

/** Load (or create + persist) this browser's PvP identity. */
export function loadOrCreateMe(): PvpIdentity {
  let seed: Uint8Array;
  try {
    const stored = localStorage.getItem(ME_KEY);
    if (stored) seed = fromHEX(stored);
    else { seed = core.generateKeyPair().secretKey; localStorage.setItem(ME_KEY, toHEX(seed)); }
  } catch {
    seed = core.generateKeyPair().secretKey;
  }
  return deriveMe(seed);
}

/** Fetch the identity's SUI balance (MIST). */
export async function balanceOf(client: SuiClient, address: string): Promise<bigint> {
  try { return BigInt((await client.getBalance({ owner: address })).totalBalance); } catch { return 0n; }
}

/** Request testnet SUI from the faucet for this identity. */
export async function faucet(address: string): Promise<void> {
  await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: address });
}
