// MTPS — the free, faucet-minted stake token (ADR-0010). Games stake MTPS instead of SUI;
// gas stays sponsored in SUI. The token never shows in the UI — a background top-up keeps the
// player's balance above a threshold, so the stake path never faucets in-line. Ids come from env.
import { Transaction } from "@mysten/sui/transactions";
import type { SignExec } from "./tunnelTx";

// `import.meta.env?.` (not `.env.`) so the module also loads under node:test, where Vite's
// `import.meta.env` injection is absent — the ids are empty there, which is fine for unit tests.
export const MTPS_PACKAGE_ID = import.meta.env?.VITE_MTPS_PACKAGE_ID ?? "";
export const MTPS_FAUCET_ID = import.meta.env?.VITE_MTPS_FAUCET_ID ?? "";
export const MTPS_COIN_TYPE = import.meta.env?.VITE_MTPS_COIN_TYPE ?? "";

/** True when all three MTPS ids are set — gates the MTPS stake path off a missing env. */
export const isMtpsConfigured = Boolean(
  MTPS_PACKAGE_ID && MTPS_FAUCET_ID && MTPS_COIN_TYPE,
);

/** MTPS has 9 decimals (matches the contract); `mtps(n)` is n whole tokens in raw units. */
export const MTPS_DECIMALS = 9;
export const mtps = (whole: bigint): bigint =>
  whole * 10n ** BigInt(MTPS_DECIMALS);

// One faucet pull mints 10,000 MTPS (10^13 raw). `mtps::mint` mints NEW supply from the
// shared TreasuryCap, so the faucet can NEVER run dry — this is only "how much per top-up"; at a
// tiny per-game stake it covers thousands of games, and the background faucet silently tops up
// again (free, gas-sponsored) whenever the balance falls below the threshold.
export const MTPS_FAUCET_AMOUNT = mtps(10_000n);
/** Background top-up trigger: refill once the balance falls below 1,000 MTPS (10^12 raw) — a
 *  cushion big enough that the stake hot-path always finds a coin while a top-up is in flight. */
export const MTPS_MIN_BALANCE = mtps(1_000n);

/**
 * Append a faucet mint of `amount` MTPS to `recipient` (`mtps::mint`). New supply each
 * call — the faucet mints, it doesn't draw from a reserve, so it can't run out. Submitted via the
 * gas sponsor (the backend allowlists this call), so the player pays nothing.
 */
export function buildMtpsFaucet(
  tx: Transaction,
  recipient: string,
  amount: bigint = MTPS_FAUCET_AMOUNT,
): void {
  tx.moveCall({
    target: `${MTPS_PACKAGE_ID}::mtps::mint`,
    arguments: [
      tx.object(MTPS_FAUCET_ID),
      tx.pure.u64(amount),
      tx.pure.address(recipient),
    ],
  });
}

/**
 * Reusable MTPS faucet: mint `amount` (default {@link MTPS_FAUCET_AMOUNT}) to `recipient`,
 * submitted through the supplied `signExec`. Pass a gas-sponsored signer to faucet for free, or a
 * wallet signer to pay your own gas. Generic so any caller can top up any address.
 */
export async function faucetMtps(opts: {
  signExec: SignExec;
  recipient: string;
  amount?: bigint;
}): Promise<{ digest: string }> {
  const tx = new Transaction();
  buildMtpsFaucet(tx, opts.recipient, opts.amount);
  return opts.signExec(tx);
}

/** Minimal `getCoins` surface — satisfied by dapp-kit's SuiClient. */
interface MtpsCoinReader {
  getCoins(input: {
    owner: string;
    coinType: string;
  }): Promise<{ data: { coinObjectId: string; balance: string }[] }>;
}

/**
 * Ensure `owner` holds a single MTPS coin >= `need`, faucet-ing via `signExec` (pass a sponsored
 * signer to top up for free) and polling past indexer lag if it's short. Returns the coin id to
 * stake. For self-play that funds N seats from ONE coin, pass the SUM as `need`. Used by any flow
 * that stakes MTPS from a non-wallet identity (e.g. autonomous bots) where the background
 * wallet auto-faucet doesn't apply.
 */
export async function ensureMtpsStakeCoin(opts: {
  client: MtpsCoinReader;
  signExec: SignExec;
  owner: string;
  need: bigint;
}): Promise<string> {
  const read = async () => {
    try {
      return (
        await opts.client.getCoins({
          owner: opts.owner,
          coinType: MTPS_COIN_TYPE,
        })
      ).data;
    } catch (e) {
      throw new Error(
        `mtps getCoins(owner=${opts.owner}, coinType=${MTPS_COIN_TYPE}) failed: ${String((e as Error)?.message ?? e)}`,
      );
    }
  };
  const pick = (coins: { coinObjectId: string; balance: string }[]) =>
    coins.find((c) => BigInt(c.balance) >= opts.need);

  let coin = pick(await read());
  if (!coin) {
    await faucetMtps({ signExec: opts.signExec, recipient: opts.owner });
    // suix_getCoins can lag the executed mint; poll briefly until the coin is indexed.
    for (let i = 0; i < 8 && !coin; i++) {
      coin = pick(await read());
      if (!coin) await new Promise((r) => setTimeout(r, 600));
    }
  }
  if (!coin) throw new Error("MTPS faucet did not yield enough to stake");
  return coin.coinObjectId;
}

/**
 * SIP-58 address-balance stake path (ADR-0013): fund the stake by withdrawing from the player's
 * MTPS *address balance* instead of a version-pinned coin object, so concurrent opens (every
 * game auto-opening on a reload) never equivocate. ON by default whenever MTPS is configured;
 * set `VITE_MTPS_ADDRESS_BALANCE=false` as a kill switch back to the coin-object path.
 *
 * REQUIRES a backend whose sponsor allowlists `coin::redeem_funds`/`coin::send_funds` (ADR-0013) —
 * an older settler refuses those calls (`sponsor refuses move call …::coin::send_funds`).
 */
export const isMtpsAddressBalance =
  isMtpsConfigured &&
  String(import.meta.env?.VITE_MTPS_ADDRESS_BALANCE ?? "true") !== "false";

/** Read surface for the address-balance funding path: coins (to sweep) + per-type balance (to know
 *  how much already sits in the address balance). Satisfied by dapp-kit's SuiClient. */
interface MtpsBalanceReader extends MtpsCoinReader {
  getBalance(input: { owner: string; coinType: string }): Promise<{
    totalBalance: string;
    fundsInAddressBalance?: string;
  }>;
}

/** Deposit owned MTPS coins into `owner`'s SIP-58 address balance (`0x2::coin::send_funds`),
 *  one call per coin. The sweep is a serialized top-up step — never on the open hot path. */
export function buildSweepToAddressBalance(
  tx: Transaction,
  owner: string,
  coinIds: string[],
): void {
  for (const id of coinIds) {
    tx.moveCall({
      target: "0x2::coin::send_funds",
      typeArguments: [MTPS_COIN_TYPE],
      arguments: [tx.object(id), tx.pure.address(owner)],
    });
  }
}

/**
 * Ensure `owner`'s MTPS ADDRESS BALANCE holds at least `need` (ADR-0013), so a sponsored open
 * can withdraw its stake without a version-pinned coin. Idempotent and off the hot path: if the
 * address balance already covers `need` it does NOTHING (the open's own withdrawal is the only tx).
 * Otherwise it faucets — only when coins + address balance together fall short — then sweeps owned
 * coins into the address balance. Pass a sponsored `signExec` so a 0-SUI player tops up for free.
 */
export async function ensureMtpsAddressBalance(opts: {
  client: MtpsBalanceReader;
  signExec: SignExec;
  owner: string;
  need: bigint;
}): Promise<void> {
  const readBalance = async () => {
    const b = await opts.client.getBalance({
      owner: opts.owner,
      coinType: MTPS_COIN_TYPE,
    });
    return {
      addr: BigInt(b.fundsInAddressBalance ?? "0"),
      total: BigInt(b.totalBalance ?? "0"),
    };
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const readCoins = async () =>
    (
      await opts.client.getCoins({
        owner: opts.owner,
        coinType: MTPS_COIN_TYPE,
      })
    ).data;

  const { addr, total } = await readBalance();
  if (addr >= opts.need) return; // already funded in the address balance — nothing to do
  // Faucet only when even coins + address balance can't cover the stake (mint is free + sponsored).
  if (total < opts.need) {
    await faucetMtps({ signExec: opts.signExec, recipient: opts.owner });
  }
  // Gather coins to sweep, polling past `getCoins` indexer lag — a just-minted faucet coin can lag
  // the balance read, and skipping the sweep would leave the address balance empty (the bug behind
  // "Available amount in account ... is less than requested: 0 < N").
  let coins = await readCoins();
  for (let i = 0; i < 12 && coins.length === 0; i++) {
    await sleep(600);
    coins = await readCoins();
  }
  // Deposit every owned coin into the address balance so the open can withdraw from it.
  if (coins.length > 0) {
    const tx = new Transaction();
    buildSweepToAddressBalance(
      tx,
      opts.owner,
      coins.map((c) => c.coinObjectId),
    );
    await opts.signExec(tx);
  }
  // SIP-58 deposits settle at a CHECKPOINT boundary, not in the depositing tx, so the funds aren't
  // withdrawable in the very next transaction. Wait until the address balance reflects the deposit
  // before returning (so the open's withdrawal doesn't dry-run against a still-empty balance). Best
  // effort: if the RPC never surfaces the settled balance, the open's own retry covers the lag.
  for (let i = 0; i < 15; i++) {
    if ((await readBalance()).addr >= opts.need) return;
    await sleep(600);
  }
}
