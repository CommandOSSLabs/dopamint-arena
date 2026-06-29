import { parseBlob } from "./blob";
import { PoolNotFoundError } from "./errors";
import type { WalletPoolStore } from "./store";

export async function exportPool(opts: {
  store: WalletPoolStore;
  walletPoolId: string;
}): Promise<Uint8Array> {
  const bytes = await opts.store.read(opts.walletPoolId);
  if (!bytes) throw new PoolNotFoundError(opts.walletPoolId);
  return bytes; // already the sealed portable blob — inert without the access value
}

export async function importPool(opts: {
  store: WalletPoolStore;
  blob: Uint8Array;
}): Promise<{ walletPoolId: string }> {
  const { walletPoolId } = parseBlob(opts.blob);
  await opts.store.write(walletPoolId, opts.blob);
  return { walletPoolId };
}

export async function deletePool(opts: {
  store: WalletPoolStore;
  walletPoolId: string;
}): Promise<void> {
  await opts.store.delete(opts.walletPoolId);
}

export async function listPools(opts: {
  store: WalletPoolStore;
}): Promise<string[]> {
  return opts.store.list();
}
