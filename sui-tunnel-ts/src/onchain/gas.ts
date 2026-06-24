/**
 * Gas-coin sharding and a pool of funded signer accounts (DESIGN_REVIEW B2/B3).
 *
 * Opening/closing thousands of tunnels are shared-object CONSENSUS transactions. A single
 * funder serializes them on one gas coin (each tx consumes a coin version the next must
 * wait for). To parallelize, fund many independent signer accounts and round-robin across
 * them so their transactions don't contend. This module provides the funding plan, a
 * one-PTB fan-out funder, and the round-robin pool.
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

/** Split `total` into `count` near-equal non-negative amounts summing to `total`. */
export function planGasShards(total: bigint, count: number): bigint[] {
  if (count <= 0) throw new Error("count must be > 0");
  const c = BigInt(count);
  const base = total / c;
  const rem = total - base * c;
  return Array.from(
    { length: count },
    (_, i) => base + (BigInt(i) < rem ? 1n : 0n),
  );
}

/** Fan out funds from the sender's gas coin to many recipients in ONE PTB. */
export function buildFundAccounts(
  tx: Transaction,
  recipients: { address: string; amount: bigint }[],
): void {
  if (recipients.length === 0) return;
  const coins = tx.splitCoins(
    tx.gas,
    recipients.map((r) => tx.pure.u64(r.amount)),
  );
  recipients.forEach((r, i) => {
    tx.transferObjects([coins[i]], tx.pure.address(r.address));
  });
}

/**
 * A round-robin pool of funded ed25519 signer accounts used to parallelize on-chain
 * open/close and avoid single-gas-coin serialization.
 */
export class SignerPool {
  private readonly signers: Ed25519Keypair[];
  private cursor = 0;

  constructor(signers: Ed25519Keypair[]) {
    if (signers.length === 0) throw new Error("SignerPool needs >= 1 signer");
    this.signers = signers;
  }

  /** Generate `n` fresh ephemeral signer accounts (fund them via buildFundAccounts). */
  static generate(n: number): SignerPool {
    return new SignerPool(
      Array.from({ length: n }, () => new Ed25519Keypair()),
    );
  }

  get size(): number {
    return this.signers.length;
  }

  /** Next signer in round-robin order. */
  next(): Ed25519Keypair {
    const s = this.signers[this.cursor];
    this.cursor = (this.cursor + 1) % this.signers.length;
    return s;
  }

  at(i: number): Ed25519Keypair {
    return this.signers[
      ((i % this.signers.length) + this.signers.length) % this.signers.length
    ];
  }

  addresses(): string[] {
    return this.signers.map((s) => s.getPublicKey().toSuiAddress());
  }

  all(): readonly Ed25519Keypair[] {
    return this.signers;
  }
}
