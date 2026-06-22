/**
 * PvP move-signer: a local ephemeral ed25519 keypair (the off-chain tunnel co-signer). It holds
 * NO funds and is NOT the on-chain identity — the connected zkLogin wallet is the on-chain party
 * (it deposits its own bankroll, receives winnings, and signs the open/deposit/close txs). The
 * ephemeral public key is registered as the party's `public_key`, so the tunnel verifies this
 * seat's move signatures against it. Persisted in localStorage so a reload keeps the same signer.
 */
import { core } from "sui-tunnel-ts";
import { fromHex, toHex } from "@mysten/sui/utils";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const EPH_KEY = "ttt_pvp_eph.v1";

export interface PvpEphemeral {
  coreKey: ReturnType<typeof core.keyPairFromSecret>; // { publicKey, secretKey } — signs tunnel moves
  pubkeyHex: string; // 32-byte ed25519 public key, hex
}

/** Build the ephemeral move-signer from a 32-byte seed. Pure (unit-testable). */
export function deriveEphemeral(seed: Uint8Array): PvpEphemeral {
  const coreKey = core.keyPairFromSecret(seed);
  return { coreKey, pubkeyHex: toHex(coreKey.publicKey) };
}

/** Load (or create + persist) this browser's ephemeral move-signer. */
export function getOrCreateEphemeral(): PvpEphemeral {
  let seed: Uint8Array;
  try {
    const stored = localStorage.getItem(EPH_KEY);
    if (stored) seed = fromHex(stored);
    else {
      seed = core.generateKeyPair().secretKey;
      localStorage.setItem(EPH_KEY, toHex(seed));
    }
  } catch {
    seed = core.generateKeyPair().secretKey;
  }
  return deriveEphemeral(seed);
}

/** Fetch an address's SUI balance (MIST). */
export async function balanceOf(
  client: SuiJsonRpcClient,
  address: string,
): Promise<bigint> {
  try {
    return BigInt((await client.getBalance({ owner: address })).totalBalance);
  } catch {
    return 0n;
  }
}
