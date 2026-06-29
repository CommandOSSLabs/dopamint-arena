import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { SuiClient } from "@mysten/sui/client";
import { unseal } from "./envelope";
import { aadFor, parseBlob, serializeBlob } from "./blob";
import { fromB64 } from "./crypto";
import { KeyCache } from "./keycache";
import { getClient } from "./rpc";
import {
  AccountDisabledError, MasterNotRetrievableError, PoolNotFoundError,
} from "./errors";
import type { Network, PoolBlob, SealedMembers, WalletEntry } from "./types";
import type { WalletPoolStore } from "./store";

export interface OpenOptions {
  store: WalletPoolStore;
  walletPoolId: string;
  accessValue: string;
  network: Network;
  rpcUrl?: string;
  cache?: "default" | "none";
  cacheTtlMs?: number;
  cacheMax?: number;
}

export interface OpenedPool {
  walletPoolId: string;
  network: Network;
  entryBy(by: string | number): WalletEntry | undefined;
  getMemberKey(by: string | number): Promise<Ed25519Keypair>;
  signAndExecute(input: {
    by: string | number; transaction: unknown; client?: SuiClient; awaitEffects?: boolean;
  }): Promise<{ digest: string }>;
  wipe(): void;
}

export interface LoadedPool { blob: PoolBlob; members: SealedMembers; }

export async function loadPool(store: WalletPoolStore, walletPoolId: string, accessValue: string): Promise<LoadedPool> {
  const bytes = await store.read(walletPoolId);
  if (!bytes) throw new PoolNotFoundError(walletPoolId);
  const blob = parseBlob(bytes);
  const plaintext = unseal(blob.crypto, accessValue, aadFor(blob));
  const members = JSON.parse(new TextDecoder().decode(plaintext)) as SealedMembers;
  return { blob, members };
}

function seedToKeypair(secretB64: string): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(fromB64(secretB64));
}

function findEntry(blob: PoolBlob, by: string | number): WalletEntry | undefined {
  return typeof by === "number"
    ? blob.index.find((e) => e.ordinal === by)
    : blob.index.find((e) => e.address === by);
}

export async function open(opts: OpenOptions): Promise<OpenedPool> {
  const cacheOn = opts.cache !== "none";
  const keyCache = new KeyCache<Ed25519Keypair>(opts.cacheMax ?? 256, opts.cacheTtlMs ?? 60_000);
  const { blob, members } = await loadPool(opts.store, opts.walletPoolId, opts.accessValue);
  const blobRef = { current: blob };

  if (cacheOn) {
    for (const m of members.members) keyCache.set(`${blob.walletPoolId}:${m.ordinal}`, seedToKeypair(m.secret));
  }

  const getMemberKey = async (by: string | number): Promise<Ed25519Keypair> => {
    const entry = findEntry(blobRef.current, by);
    if (!entry) throw new Error(`wallet not found: ${by}`);
    if (entry.role === "master") throw new MasterNotRetrievableError();
    if (!entry.enabled) throw new AccountDisabledError(entry.address);
    const key = `${blobRef.current.walletPoolId}:${entry.ordinal}`;
    let kp = cacheOn ? keyCache.get(key) : undefined;
    if (!kp) {
      const m = members.members.find((x) => x.ordinal === entry.ordinal);
      if (!m) throw new Error(`member secret missing: ${entry.ordinal}`);
      kp = seedToKeypair(m.secret);
      if (cacheOn) keyCache.set(key, kp);
    }
    return kp;
  };

  const signAndExecute = async (input: {
    by: string | number; transaction: unknown; client?: SuiClient; awaitEffects?: boolean;
  }): Promise<{ digest: string }> => {
    const kp = await getMemberKey(input.by);
    const client = input.client ?? getClient(blobRef.current.network, opts.rpcUrl);
    const res = await client.signAndExecuteTransaction({
      signer: kp, transaction: input.transaction as never, options: { showEffects: true },
    });
    if (input.awaitEffects) await client.waitForTransaction({ digest: res.digest });
    return { digest: res.digest };
  };

  return {
    walletPoolId: blob.walletPoolId,
    network: blob.network,
    entryBy: (by) => findEntry(blobRef.current, by),
    getMemberKey,
    signAndExecute,
    wipe: () => keyCache.clear(),
  };
}

/** Public: toggle an account's enabled flag (index metadata only — no access, no re-seal). */
export async function setEnabled(input: {
  store: WalletPoolStore; walletPoolId: string; by: string | number; enabled: boolean;
}): Promise<void> {
  const bytes = await input.store.read(input.walletPoolId);
  if (!bytes) throw new PoolNotFoundError(input.walletPoolId);
  const blob = parseBlob(bytes);
  const entry = findEntry(blob, input.by);
  if (!entry) throw new Error(`wallet not found: ${input.by}`);
  entry.enabled = input.enabled;
  await input.store.write(blob.walletPoolId, serializeBlob(blob));
}
