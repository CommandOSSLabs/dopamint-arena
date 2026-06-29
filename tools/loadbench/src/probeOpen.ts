/**
 * One on-chain open primitive for the probe: open N tunnels in a single PTB and
 * capture the wall time + gas. Parallels loadbench `onchain.ts`'s `openTunnels`,
 * but — critically — SETS A GAS BUDGET (`openTunnels` does not; the default 100M
 * budget caps a batch at ~22 opens, which the knee sweep must not mistake for a
 * structural limit). Throws (via `execute`) on rejection so the caller can
 * `classify` the failure.
 */

import { Transaction } from "@mysten/sui/transactions";
import type { SuiClient } from "./suiClient";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  buildOpenAndFundMany,
  type TunnelOpenSpec,
} from "../../../sui-tunnel-ts/src/onchain/createAndFund";
import { execute } from "../../../sui-tunnel-ts/src/onchain/lifecycle";
import { getCreatedObjectIds } from "../../../sui-tunnel-ts/src/utils";
import { SUI_COIN_TYPE } from "../../../sui-tunnel-ts/src/config";
import { gasBudgetFor, type GasUsedRaw } from "./probeLimits";
import { withTxRetry } from "./probeRetry";

export interface OpenBatchResult {
  /** Created shared Tunnel ids, in creation order (matches `specs` order). */
  ids: string[];
  gasUsed: GasUsedRaw;
  wallMs: number;
}

export interface OpenBatchOptions {
  /** Explicit budget override; defaults to `gasBudgetFor(specs.length)`. */
  gasBudgetMist?: number;
  /** Move coin type `T`; defaults to SUI. Non-SUI needs a `sourceCoin` (gas is
   *  always `Coin<SUI>`), which the stock localnet stack does not mint — so a
   *  non-SUI coin type fails fast here rather than mis-typing the gas coin. */
  coinType?: string;
}

/**
 * Open `specs.length` tunnels in one PTB signed by `funder`, funded off the
 * funder's own gas coin. Asserts the created-id count matches the request so a
 * partial/empty result is surfaced rather than silently undercounted.
 */
export async function openBatch(
  client: SuiClient,
  funder: Ed25519Keypair,
  specs: TunnelOpenSpec[],
  opts: OpenBatchOptions = {},
): Promise<OpenBatchResult> {
  const coinType = opts.coinType ?? SUI_COIN_TYPE;
  if (coinType !== SUI_COIN_TYPE) {
    throw new Error(
      `--coin-type ${coinType} is not supported by the probe: batch opens split ` +
        `stakes off the gas coin (Coin<SUI>), and the stock 'bun run stack' mints ` +
        `only SUI. Use SUI, or extend the probe to supply a sourceCoin.`,
    );
  }
  // Retry on stale-gas/version conflicts: under rapid prior txs the fullnode's
  // owned-object index lags, so the SDK's getCoins gas selection can pick a stale
  // coin version → "unavailable for consumption". A rebuild re-selects fresh gas.
  // A fresh Transaction is built each attempt so the retry actually re-resolves gas.
  return withTxRetry(async () => {
    const tx = new Transaction();
    buildOpenAndFundMany(tx, specs);
    tx.setGasBudget(opts.gasBudgetMist ?? gasBudgetFor(specs.length));
    const t0 = performance.now();
    const res = await execute(client, funder, tx, { waitForFinality: true });
    const wallMs = performance.now() - t0;
    const ids = getCreatedObjectIds(
      res.objectChanges as unknown[],
      "::tunnel::Tunnel<",
    );
    if (ids.length !== specs.length) {
      throw new Error(
        `open created ${ids.length} tunnels, expected ${specs.length}`,
      );
    }
    const gasUsed = (res.effects as { gasUsed: GasUsedRaw }).gasUsed;
    return { ids, gasUsed, wallMs };
  });
}
