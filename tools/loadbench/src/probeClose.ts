/**
 * On-chain close primitives for the probe: build a valid co-signed settlement
 * for a freshly-opened tunnel (no gameplay), then settle tunnels concurrently
 * through a signer pool.
 */

import { Transaction } from "@mysten/sui/transactions";
import type { SuiClient } from "./suiClient";
import { OffchainTunnel } from "../../../sui-tunnel-ts/src/core/tunnel";
import type { CoSignedSettlementWithRoot } from "../../../sui-tunnel-ts/src/core/tunnel";
import { PaymentsProtocol } from "../../../sui-tunnel-ts/src/protocol/payments";
import { buildCloseWithRootFromSettlement } from "../../../sui-tunnel-ts/src/onchain/txbuilders";
import { execute } from "../../../sui-tunnel-ts/src/onchain/lifecycle";
import type { SignerPool } from "../../../sui-tunnel-ts/src/onchain/gas";
import { gasBudgetFor } from "./probeLimits";
import { withTxRetry } from "./probeRetry";
import type { Seats } from "./match";

/** 32 zero bytes — the transcript root for a no-gameplay cooperative close. */
const ZERO_ROOT = new Uint8Array(32);

/**
 * Co-signed opening-balance settlement for a REAL on-chain tunnel id, anchoring a
 * 32-byte zero transcript root and signed by both ephemeral seat keys.
 *
 * Self-play (`OffchainTunnel.selfPlay`) is correct HERE because this is a
 * chain-throughput measurement probe that mints both ephemeral party keys itself
 * and only needs a verifiable cooperative-close artifact — no real counterparty
 * exists. The genuine-two-party / no-self-play rule applies to the demo/headline
 * engine, not this probe. `buildSettlementWithRoot` reuses the engine's tested
 * serialize + dual-sign; `PaymentsProtocol` is just the balance carrier (no moves
 * are applied). `finalNonce = onchainNonce + 1 = 1`, matching a freshly-opened,
 * never-checkpointed tunnel.
 *
 * `timestamp` must be the tunnel's on-chain `created_at` (close requires
 * `created_at <= timestamp <= clock.now`; the local clock runs ahead).
 */
export function buildOpeningSettlement(
  seats: Seats,
  tunnelId: string,
  createdAt: bigint,
): CoSignedSettlementWithRoot {
  const tunnel = OffchainTunnel.selfPlay(
    new PaymentsProtocol(),
    tunnelId,
    seats.partyA.keyPair,
    seats.partyB.keyPair,
    seats.partyA.address,
    seats.partyB.address,
    { a: seats.balances.a, b: seats.balances.b },
  );
  return tunnel.buildSettlementWithRoot(createdAt, ZERO_ROOT, 0n);
}

/** One tunnel to settle: its id and the co-signed root-anchored settlement. */
export interface CloseTarget {
  tunnelId: string;
  settlement: CoSignedSettlementWithRoot;
}

export interface CloseBatchResult {
  digests: string[];
  /** Per-close wall latencies (ms) for the closes that succeeded. */
  latenciesMs: number[];
  errors: number;
  attempted: number;
}

/** Max closes packed into one PTB. The `close-knee` probe measured the ceiling at 681
 *  closes/PTB on localnet (K=682 fails with an opaque "Internal error"; K=1024 hits the
 *  1024-command limit). 512 keeps a safety margin under that opaque knee while batching
 *  ~8× more than the original conservative 64. */
const CLOSE_BATCH = 512;

/**
 * Settle `targets` through the pool. The submitting signer need not be a party: the
 * Move verifies the two party signatures embedded in the settlement, not the tx sender.
 *
 * Targets are partitioned into one LANE per signer, and each lane packs its closes into
 * BATCHED PTBs (CLOSE_BATCH per tx) — a PTB can call close once per shared object, the
 * same way the open path packs many creates per tx (see buildBatchClose). Sub-batches
 * run serially on the lane's own gas coin; lanes run in parallel → in-flight = pool
 * size, with no single-coin version contention. Batching (vs one tx per close) is what
 * lets close throughput scale like opens instead of being one-finality-per-close.
 */
export async function closeBatchWithRoot(
  client: SuiClient,
  pool: SignerPool,
  targets: CloseTarget[],
  opts: { gasBudgetMist?: number; coinType?: string } = {},
): Promise<CloseBatchResult> {
  const laneCount = Math.max(1, Math.min(pool.size, targets.length));
  const lanes: CloseTarget[][] = Array.from({ length: laneCount }, () => []);
  targets.forEach((t, i) => lanes[i % laneCount].push(t));

  const digests: string[] = [];
  const latenciesMs: number[] = [];
  let errors = 0;
  await Promise.all(
    lanes.map(async (lane, laneIdx) => {
      const signer = pool.at(laneIdx);
      for (let off = 0; off < lane.length; off += CLOSE_BATCH) {
        const chunk = lane.slice(off, off + CLOSE_BATCH);
        // Budget scales with the chunk (one tiny budget would starve a batched close).
        const budget = opts.gasBudgetMist ?? gasBudgetFor(chunk.length);
        const start = performance.now();
        try {
          // Rebuild-and-retry on stale-gas/version conflicts (fresh Transaction each
          // attempt re-selects gas); only exhausted/non-retriable failures count as errors.
          const r = await withTxRetry(async () => {
            const tx = new Transaction();
            for (const t of chunk)
              buildCloseWithRootFromSettlement(tx, t.tunnelId, t.settlement, opts.coinType);
            tx.setGasBudget(budget);
            return execute(client, signer, tx, { waitForFinality: true });
          });
          digests.push(r.digest);
          // One batched tx settled `chunk.length` tunnels; attribute its latency to each.
          for (let k = 0; k < chunk.length; k++)
            latenciesMs.push(performance.now() - start);
        } catch {
          errors += chunk.length;
        }
      }
    }),
  );
  return { digests, latenciesMs, errors, attempted: targets.length };
}
