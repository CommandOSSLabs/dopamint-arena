import { concatBytes } from "sui-tunnel-ts/core/bytes";
import { blake2b256, nobleBackend } from "sui-tunnel-ts/core/crypto";
import {
  nextU64,
  seedFromBytes,
  type Seed,
} from "sui-tunnel-ts/core/randomness";
import { u64ToBeBytes } from "sui-tunnel-ts/core/wire";
import type { BotWallet } from "./botWalletPool";
import type { QuantumPokerSession } from "./sessionStore";

const enc = new TextEncoder();
const DOMAIN_BOT_ENTROPY = enc.encode(
  "dopamint-arena::quantum-poker::bot-entropy.v1",
);
const DOMAIN_BOT_RNG = enc.encode(
  "dopamint-arena::quantum-poker::sui-seeded-bot-rng.v1",
);

function text(value: string): Uint8Array {
  return enc.encode(value);
}

function rngFloatFromU64(value: bigint): number {
  return Number(value >> 11n) / 0x20_0000_0000_0000;
}

/**
 * Derive bot private randomness from a Sui-native public seed plus a deterministic
 * bot signature. This avoids local random generation while keeping the actual
 * poker slot secrets private until the protocol reveal phase.
 */
export function createSuiSeededBotRng(
  session: QuantumPokerSession,
  wallet: BotWallet,
): () => number {
  if (!session.suiRandomness) {
    throw new Error("session has no Sui randomness seed");
  }

  const signer = nobleBackend.makeSigner(wallet.keyPair.secretKey);
  const entropyMessage = concatBytes([
    DOMAIN_BOT_ENTROPY,
    session.suiRandomness.seed,
    text(session.id),
    text(session.tunnelId),
    u64ToBeBytes(session.nonce),
  ]);
  const botEntropy = signer(entropyMessage);
  const rngSeed = blake2b256(
    concatBytes([
      DOMAIN_BOT_RNG,
      session.suiRandomness.seed,
      botEntropy,
      wallet.keyPair.publicKey,
      text(session.id),
      text(session.tunnelId),
      u64ToBeBytes(session.nonce),
    ]),
  );
  let seed: Seed = seedFromBytes(rngSeed);

  return () => {
    const [value, nextSeed] = nextU64(seed);
    seed = nextSeed;
    return rngFloatFromU64(value);
  };
}
