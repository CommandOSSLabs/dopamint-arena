import { parseBlob } from "./blob";
import { PoolNotFoundError } from "./errors";
import type { WalletPoolStore } from "./store";

/**
 * Return the sealed portable blob for a pool.
 *
 * The returned bytes are inert without the access value; they can be copied to
 * another store or machine and imported with `importPool()`.
 *
 * @throws PoolNotFoundError if the pool does not exist.
 */
export async function exportPool(opts: {
  store: WalletPoolStore;
  walletPoolId: string;
}): Promise<Uint8Array> {
  const bytes = await opts.store.read(opts.walletPoolId);
  if (!bytes) throw new PoolNotFoundError(opts.walletPoolId);
  return bytes;
}

/**
 * Import a sealed portable blob into the store.
 *
 * The pool id is read from the blob itself. If a pool with the same id already
 * exists, it is overwritten.
 */
export async function importPool(opts: {
  store: WalletPoolStore;
  blob: Uint8Array;
}): Promise<{ walletPoolId: string }> {
  const { walletPoolId } = parseBlob(opts.blob);
  await opts.store.write(walletPoolId, opts.blob);
  return { walletPoolId };
}

/**
 * Delete a pool from the store.
 *
 * This is idempotent: deleting a missing pool does not throw.
 */
export async function deletePool(opts: {
  store: WalletPoolStore;
  walletPoolId: string;
}): Promise<void> {
  await opts.store.delete(opts.walletPoolId);
}

/** List the ids of all pools stored in the store. */
export async function listPools(opts: {
  store: WalletPoolStore;
}): Promise<string[]> {
  return opts.store.list();
}
