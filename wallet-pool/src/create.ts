import { seal } from "./envelope";
import { aadFor, encodeMembers, serializeBlob } from "./blob";
import {
  ed25519Address, generateAccessValue, generateKeyPair, generateKeyPairs,
  generateWalletPoolId, keyPairFromSecret,
} from "./crypto";
import type { Network, PoolBlob, WalletEntry } from "./types";
import type { WalletPoolStore } from "./store";

export interface CreateOptions {
  network: Network;
  members: number;
  master: { seed: Uint8Array } | { generate: true };
  access?: { generate: true } | { passphrase: string };
  label?: string;
  store: WalletPoolStore;
}

export interface CreateResult {
  walletPoolId: string;
  accessValue: string;
  network: Network;
  memberCount: number;
}

export async function create(opts: CreateOptions): Promise<CreateResult> {
  if (opts.members < 1) throw new Error("members must be >= 1");
  const masterKp = "generate" in opts.master ? generateKeyPair() : keyPairFromSecret(opts.master.seed);
  const memberKps = generateKeyPairs(opts.members);
  const isPassphrase = opts.access != null && "passphrase" in opts.access;
  const accessValue = isPassphrase ? (opts.access as { passphrase: string }).passphrase : generateAccessValue();

  const walletPoolId = generateWalletPoolId();
  const createdAt = Date.now();
  const index: WalletEntry[] = [
    { role: "master", address: ed25519Address(masterKp.publicKey), ordinal: 0, createdAt, enabled: true, useCount: 0, lastUsedAt: 0 },
    ...memberKps.map((kp, i) => ({
      role: "member" as const, address: ed25519Address(kp.publicKey), ordinal: i + 1, createdAt,
      enabled: true, useCount: 0, lastUsedAt: 0,
    })),
  ];

  const sealed = encodeMembers(
    masterKp.secretKey,
    memberKps.map((kp, i) => ({ ordinal: i + 1, secret: kp.secretKey })),
  );
  const crypto = seal(
    new TextEncoder().encode(JSON.stringify(sealed)),
    accessValue,
    isPassphrase ? "passphrase" : "generated",
    aadFor({ version: 1, walletPoolId, network: opts.network }),
  );

  const blob: PoolBlob = {
    version: 1, walletPoolId, network: opts.network, createdAt, label: opts.label,
    coinTypes: ["0x2::sui::SUI"], crypto, index,
  };
  await opts.store.write(walletPoolId, serializeBlob(blob));
  return { walletPoolId, accessValue, network: opts.network, memberCount: opts.members };
}
