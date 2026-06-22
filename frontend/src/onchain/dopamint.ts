// DOPAMINT — the free, faucet-minted stake token (ADR-0010). Games stake DOPAMINT instead of SUI;
// gas stays sponsored in SUI. The token never shows in the UI — a background top-up keeps the
// player's balance above a threshold, so the stake path never faucets in-line. Ids come from env.
import { Transaction } from "@mysten/sui/transactions";
import type { SignExec } from "./tunnelTx";

export const DOPAMINT_PACKAGE_ID = import.meta.env.VITE_DOPAMINT_PACKAGE_ID ?? "";
export const DOPAMINT_FAUCET_ID = import.meta.env.VITE_DOPAMINT_FAUCET_ID ?? "";
export const DOPAMINT_COIN_TYPE = import.meta.env.VITE_DOPAMINT_COIN_TYPE ?? "";

/** True when all three DOPAMINT ids are set — gates the DOPAMINT stake path off a missing env. */
export const isDopamintConfigured = Boolean(
  DOPAMINT_PACKAGE_ID && DOPAMINT_FAUCET_ID && DOPAMINT_COIN_TYPE,
);

/** DOPAMINT has 9 decimals (matches the contract); `dopamint(n)` is n whole tokens in raw units. */
export const DOPAMINT_DECIMALS = 9;
export const dopamint = (whole: bigint): bigint =>
  whole * 10n ** BigInt(DOPAMINT_DECIMALS);

/** One faucet pull mints 10,000 DOPAMINT — thousands of games per top-up. */
export const DOPAMINT_FAUCET_AMOUNT = dopamint(10_000n);
/** Background top-up trigger: when the balance drops below 100 DOPAMINT, faucet more. */
export const DOPAMINT_MIN_BALANCE = dopamint(100n);

/**
 * Append a faucet mint of `amount` DOPAMINT to `recipient` (`dopamint::mint`). New supply each
 * call — the faucet mints, it doesn't draw from a reserve, so it can't run out. Submitted via the
 * gas sponsor (the backend allowlists this call), so the player pays nothing.
 */
export function buildDopamintFaucet(
  tx: Transaction,
  recipient: string,
  amount: bigint = DOPAMINT_FAUCET_AMOUNT,
): void {
  tx.moveCall({
    target: `${DOPAMINT_PACKAGE_ID}::dopamint::mint`,
    arguments: [
      tx.object(DOPAMINT_FAUCET_ID),
      tx.pure.u64(amount),
      tx.pure.address(recipient),
    ],
  });
}

/**
 * Reusable DOPAMINT faucet: mint `amount` (default {@link DOPAMINT_FAUCET_AMOUNT}) to `recipient`,
 * submitted through the supplied `signExec`. Pass a gas-sponsored signer to faucet for free, or a
 * wallet signer to pay your own gas. Generic so any caller can top up any address.
 */
export async function faucetDopamint(opts: {
  signExec: SignExec;
  recipient: string;
  amount?: bigint;
}): Promise<{ digest: string }> {
  const tx = new Transaction();
  buildDopamintFaucet(tx, opts.recipient, opts.amount);
  return opts.signExec(tx);
}
