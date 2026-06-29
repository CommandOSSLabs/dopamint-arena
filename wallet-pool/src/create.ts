import { seal } from "./envelope";
import { aadFor, encodeMembers, serializeBlob } from "./blob";
import {
  ed25519Address,
  generateAccessValue,
  generateKeyPair,
  generateKeyPairs,
  generateWalletPoolId,
  keyPairFromSecret,
} from "./crypto";
import { WalletPoolError } from "./errors";
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

const MAX_MEMBERS = 10_000;

export async function create(opts: CreateOptions): Promise<CreateResult> {
  if (opts.members < 1) throw new WalletPoolError("members must be >= 1");
  if (opts.members > MAX_MEMBERS) {
    throw new WalletPoolError(`members must be <= ${MAX_MEMBERS}`);
  }
  const masterKp =
    "generate" in opts.master
      ? generateKeyPair()
      : keyPairFromSecret(opts.master.seed);
  const memberKps = generateKeyPairs(opts.members);
  const access = opts.access;
  const isPassphrase = access != null && "passphrase" in access;
  const accessValue = isPassphrase ? access.passphrase : generateAccessValue();

  const walletPoolId = generateWalletPoolId();
  const createdAt = Date.now();
  const index: WalletEntry[] = [
    {
      role: "master",
      address: ed25519Address(masterKp.publicKey),
      ordinal: 0,
      createdAt,
      enabled: true,
      useCount: 0,
      lastUsedAt: 0,
    },
    ...memberKps.map((kp, i) => ({
      role: "member" as const,
      address: ed25519Address(kp.publicKey),
      ordinal: i + 1,
      createdAt,
      enabled: true,
      useCount: 0,
      lastUsedAt: 0,
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
    version: 1,
    walletPoolId,
    network: opts.network,
    createdAt,
    label: opts.label,
    coinTypes: ["0x2::sui::SUI"],
    crypto,
    index,
  };
  await opts.store.write(walletPoolId, serializeBlob(blob));
  return {
    walletPoolId,
    accessValue,
    network: opts.network,
    memberCount: opts.members,
  };
}
