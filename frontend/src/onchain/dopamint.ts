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

// One faucet pull mints 10,000 DOPAMINT (10^13 raw). `dopamint::mint` mints NEW supply from the
// shared TreasuryCap, so the faucet can NEVER run dry — this is only "how much per top-up"; at a
// tiny per-game stake it covers thousands of games, and the background faucet silently tops up
// again (free, gas-sponsored) whenever the balance falls below the threshold.
export const DOPAMINT_FAUCET_AMOUNT = dopamint(10_000n);
/** Background top-up trigger: refill once the balance falls below 1,000 DOPAMINT (10^12 raw) — a
 *  cushion big enough that the stake hot-path always finds a coin while a top-up is in flight. */
export const DOPAMINT_MIN_BALANCE = dopamint(1_000n);

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

/** Minimal `getCoins` surface — satisfied by dapp-kit's SuiClient. */
interface DopamintCoinReader {
  getCoins(input: {
    owner: string;
    coinType: string;
  }): Promise<{ data: { coinObjectId: string; balance: string }[] }>;
}

/**
 * Ensure `owner` holds a single DOPAMINT coin >= `need`, faucet-ing via `signExec` (pass a sponsored
 * signer to top up for free) and polling past indexer lag if it's short. Returns the coin id to
 * stake. For self-play that funds N seats from ONE coin, pass the SUM as `need`. Used by any flow
 * that stakes DOPAMINT from a non-wallet identity (e.g. autonomous bots) where the background
 * wallet auto-faucet doesn't apply.
 */
export async function ensureDopamintStakeCoin(opts: {
  client: DopamintCoinReader;
  signExec: SignExec;
  owner: string;
  need: bigint;
}): Promise<string> {
  const read = async () => {
    try {
      return (
        await opts.client.getCoins({
          owner: opts.owner,
          coinType: DOPAMINT_COIN_TYPE,
        })
      ).data;
    } catch (e) {
      throw new Error(
        `dopamint getCoins(owner=${opts.owner}, coinType=${DOPAMINT_COIN_TYPE}) failed: ${String((e as Error)?.message ?? e)}`,
      );
    }
  };
  const pick = (coins: { coinObjectId: string; balance: string }[]) =>
    coins.find((c) => BigInt(c.balance) >= opts.need);

  let coin = pick(await read());
  if (!coin) {
    await faucetDopamint({ signExec: opts.signExec, recipient: opts.owner });
    // suix_getCoins can lag the executed mint; poll briefly until the coin is indexed.
    for (let i = 0; i < 8 && !coin; i++) {
      coin = pick(await read());
      if (!coin) await new Promise((r) => setTimeout(r, 600));
    }
  }
  if (!coin) throw new Error("DOPAMINT faucet did not yield enough to stake");
  return coin.coinObjectId;
}
