// DOPAMINT — the free, faucet-minted stake token (ADR-0010). Games stake DOPAMINT instead of SUI;
// gas stays sponsored in SUI. The token never shows in the UI — the faucet runs invisibly when a
// player's DOPAMINT balance can't cover a stake. Coin type / faucet ids come from env.
import type { Transaction } from "@mysten/sui/transactions";

export const DOPAMINT_PACKAGE_ID = import.meta.env.VITE_DOPAMINT_PACKAGE_ID ?? "";
export const DOPAMINT_FAUCET_ID = import.meta.env.VITE_DOPAMINT_FAUCET_ID ?? "";
export const DOPAMINT_COIN_TYPE = import.meta.env.VITE_DOPAMINT_COIN_TYPE ?? "";

/** True when all three DOPAMINT ids are set — gates the DOPAMINT stake path off a missing env. */
export const isDopamintConfigured = Boolean(
  DOPAMINT_PACKAGE_ID && DOPAMINT_FAUCET_ID && DOPAMINT_COIN_TYPE,
);

/** Default faucet pull — matches the contract's `DEFAULT_MINT_AMOUNT` (100 DOPAMINT, 9 decimals).
 *  Far above any game's tiny stake, so one faucet covers many games. */
export const DOPAMINT_FAUCET_AMOUNT = 100_000_000_000n;

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
