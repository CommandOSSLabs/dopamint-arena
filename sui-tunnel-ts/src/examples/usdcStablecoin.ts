/**
 * USDC Stablecoin Example
 *
 * Denominates the agent spending allowance in native USDC (Circle) instead of
 * SUI — the production setup for streaming / agentic payments (Stripe Tempo and
 * Cloudflare x402/MPP both settle in stablecoins). The Move modules are generic
 * over the coin type, so this is purely an SDK convenience: it presets the coin
 * type argument to USDC and adds USDC amount/coin helpers.
 *
 * Native USDC coin types (https://developers.circle.com/stablecoins/usdc-contract-addresses):
 * - mainnet: 0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC
 * - testnet: 0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  AllowanceStatus,
  getUsdcCoinType,
  SuiNetwork,
  USDC_DECIMALS,
} from "../config";
import { CreateAllowanceResult } from "../types";
import { createSuiClient } from "../utils";
import {
  AccrualState,
  claim,
  computeEntitled,
  CreateAllowanceParams,
  createAndShareAllowance,
  topUp,
} from "./agentAllowance";

const USDC_BASE_UNITS = 10n ** BigInt(USDC_DECIMALS);

/**
 * Convert a human USDC amount to base units (6 decimals). String parsing avoids
 * floating-point rounding: `usdc("10.5")` -> 10_500_000n, `usdc(0.001)` -> 1000n.
 */
export function usdc(amount: number | string): bigint {
  const s = typeof amount === "number" ? amount.toString() : amount;
  const negative = s.startsWith("-");
  const [whole, frac = ""] = (negative ? s.slice(1) : s).split(".");
  const fracPadded = (frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  const value =
    BigInt(whole || "0") * USDC_BASE_UNITS + BigInt(fracPadded || "0");
  return negative ? -value : value;
}

/** Format base units back to a human USDC string, e.g. 10_500_000n -> "10.5". */
export function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / USDC_BASE_UNITS;
  const frac = (baseUnits % USDC_BASE_UNITS)
    .toString()
    .padStart(USDC_DECIMALS, "0")
    .replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
}

/** Fetch the USDC coins owned by an address (for funding an allowance). */
export async function getUsdcCoins(
  client: SuiClient,
  owner: string,
  network?: SuiNetwork
): Promise<Array<{ objectId: string; balance: bigint }>> {
  const coins = await client.getCoins({
    owner,
    coinType: getUsdcCoinType(network),
  });
  return coins.data.map((c) => ({
    objectId: c.coinObjectId,
    balance: BigInt(c.balance),
  }));
}

/**
 * Create a USDC-denominated agent spending allowance and share it. Identical to
 * `createAndShareAllowance` but with the coin type fixed to native USDC.
 *
 * @example
 * ```typescript
 * // $10 cap, streaming $0.001/sec to a provider, agent delegate can pull.
 * const { allowanceId } = await createUsdcAllowance({
 *   payee: providerAddress,
 *   fundsCoinId: usdcCoinId,
 *   spendCap: usdc(10),
 *   ratePerSecond: usdc("0.001"),
 *   delegate: agentAddress,
 * });
 * ```
 */
export async function createUsdcAllowance(
  params: Omit<CreateAllowanceParams, "coinType">,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<CreateAllowanceResult> {
  return createAndShareAllowance(
    { ...params, coinType: getUsdcCoinType() },
    client,
    keypair
  );
}

/** Pull `amount` of USDC base units to the payee. Wraps `claim` with the USDC type. */
export async function claimUsdc(
  allowanceId: string,
  amount: bigint,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<string> {
  return claim(allowanceId, amount, client, keypair, getUsdcCoinType());
}

/** Add USDC escrow to a live allowance. Wraps `topUp` with the USDC type. */
export async function topUpUsdc(
  allowanceId: string,
  fundsCoinId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<string> {
  return topUp(allowanceId, fundsCoinId, client, keypair, getUsdcCoinType());
}

// ============================================
// EXAMPLE USAGE
// ============================================

/**
 * Documentation-only walkthrough of a USDC-denominated agent allowance (no live tx).
 */
export async function exampleUsdcStablecoinFlow(): Promise<void> {
  console.log("=== USDC Stablecoin Allowance Example ===\n");

  const client = createSuiClient();
  console.log(`USDC coin type: ${getUsdcCoinType()}\n`);

  console.log("Amount helpers (USDC has 6 decimals):");
  console.log(`- usdc(10)      = ${usdc(10)} base units`);
  console.log(`- usdc("0.001") = ${usdc("0.001")} base units`);
  console.log(`- formatUsdc(10500000n) = ${formatUsdc(10_500_000n)} USDC\n`);

  // Off-chain entitlement preview for a $10 cap streaming at $0.001/sec.
  const start = 0n;
  const state: AccrualState = {
    ratePerSecond: usdc("0.001"),
    vestedFloor: 0n,
    anchorMs: start,
    authorizedTotal: 0n,
    spendCap: usdc(10),
    expiryMs: 0n,
    status: AllowanceStatus.ACTIVE,
  };
  console.log("Streaming $0.001/sec, $10 cap (entitlement in USDC):");
  console.log(
    `- t=1h:   ${formatUsdc(computeEntitled(state, start + 3_600_000n))}`
  );
  console.log(
    `- t=10h:  ${formatUsdc(
      computeEntitled(state, start + 36_000_000n)
    )} (cap clamps)\n`
  );

  console.log("On-chain flow:");
  console.log(`
import { createUsdcAllowance, claimUsdc, usdc, getUsdcCoins } from "sui-tunnel-ts";

// Principal funds a $10 USDC allowance streaming $0.001/sec to a provider agent.
const [coin] = await getUsdcCoins(client, principalAddress);
const { allowanceId } = await createUsdcAllowance({
  payee: providerAddress,
  fundsCoinId: coin.objectId,
  spendCap: usdc(10),
  ratePerSecond: usdc("0.001"),
  delegate: agentAddress,
});

// The provider (or delegate) pulls accrued USDC — no per-charge co-signature.
await claimUsdc(allowanceId, usdc("0.05"));
`);

  // `client` is created above to validate network/USDC resolution end-to-end.
  void client;
}

// Run example if called directly
if (require.main === module) {
  exampleUsdcStablecoinFlow();
}
