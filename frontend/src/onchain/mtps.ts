// MTPS — the free stake token (ADR-0015). Games stake MTPS instead of SUI; gas stays sponsored in
// SUI. The token never shows in the UI — a background top-up keeps the player's balance above a
// threshold, so the stake path never faucets in-line. Minting is admin-only: faucet pulls go
// through the backend (`POST /v1/faucet`), not an on-chain PTB. Ids come from env.
import { Transaction } from "@mysten/sui/transactions";
import { resolveBackendUrl } from "../backend/controlPlane";
import type { SignExec } from "./tunnelTx";

// `import.meta.env?.` (not `.env.`) so the module also loads under node:test, where Vite's
// `import.meta.env` injection is absent — the ids are empty there, which is fine for unit tests.
export const MTPS_PACKAGE_ID = import.meta.env?.VITE_MTPS_PACKAGE_ID ?? "";
export const MTPS_COIN_TYPE = import.meta.env?.VITE_MTPS_COIN_TYPE ?? "";

/** True when the MTPS ids are set — gates the MTPS stake path off a missing env. The faucet is in
 *  the backend now, so there is no on-chain faucet-object id to require. */
export const isMtpsConfigured = Boolean(MTPS_PACKAGE_ID && MTPS_COIN_TYPE);

/** The MTPS token icon (the same icon registered in the coin's on-chain metadata; ADR-0015), for
 *  UI that displays the MTPS balance. */
export const MTPS_ICON_URL = "https://dev.millionstps.io/favicons/favicon.svg";

/** MTPS is a 0-decimal whole-token currency (ADR-0015): 1 MTPS is the integer `1`, not `1e9`. The
 *  `mtps(n)` helper (identity at 0 decimals) is kept so call sites read intent and survive a future
 *  decimals change. Game stakes/chips are therefore whole tokens — see each game's stake constant. */
export const MTPS_DECIMALS = 0;
export const mtps = (whole: bigint): bigint =>
  whole * 10n ** BigInt(MTPS_DECIMALS);

/** Background top-up trigger: refill once the balance falls below this (whole tokens). The backend
 *  faucet mints far more per pull, so one top-up covers many games while the next is in flight. */
export const MTPS_MIN_BALANCE = mtps(1_000n);

/**
 * Faucet MTPS to `recipient` via the backend (`POST /v1/faucet`, ADR-0015). Minting moved fully
 * behind the backend `admin_mint` (the on-chain `mtps::mint` faucet was removed), so this no longer
 * builds or signs a PTB — the backend mints a fixed amount and rate-limits per address. Returns the
 * mint tx digest; throws on a non-2xx (including a 429 cooldown) with the backend's detail.
 */
export async function faucetMtps(opts: {
  recipient: string;
  /** Deposit into the recipient's SIP-58 address balance (the stake path withdraws from it, so no
   *  client-side sweep) vs. an owned coin. Omitted → the backend default (address balance). */
  toBalance?: boolean;
}): Promise<{ digest: string }> {
  const res = await fetch(`${resolveBackendUrl()}/v1/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      address: opts.recipient,
      toBalance: opts.toBalance,
    }),
  });
  if (!res.ok) {
    // Surface the backend's clean `error.message` (the ApiError envelope), not the raw JSON, and
    // attach the HTTP status so callers can special-case the 429 rate limit.
    const raw = await res.text().catch(() => "");
    let message = raw;
    try {
      message =
        (JSON.parse(raw) as { error?: { message?: string } })?.error?.message ??
        raw;
    } catch {
      /* not JSON — fall back to the raw text */
    }
    const err = new Error(
      message || `faucet request failed (${res.status})`,
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const { digest } = (await res.json()) as { digest: string };
  return { digest };
}

const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));

/** Permissionless collectible mint — NFT is transferred to the transaction sender. */
export function buildMintMtpsNft(
  tx: Transaction,
  title: string,
  description: string,
  imageUrl: string,
): void {
  tx.moveCall({
    target: `${MTPS_PACKAGE_ID}::mtps::mint_nft`,
    arguments: [
      tx.pure.vector("u8", utf8(title)),
      tx.pure.vector("u8", utf8(description)),
      tx.pure.vector("u8", utf8(imageUrl)),
    ],
  });
}

export async function mintMtpsNft(opts: {
  signExec: SignExec;
  title: string;
  description: string;
  imageUrl: string;
}): Promise<{ digest: string }> {
  const tx = new Transaction();
  buildMintMtpsNft(tx, opts.title, opts.description, opts.imageUrl);
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
 * Ensure `owner` holds a single MTPS coin >= `need`, faucet-ing via the backend (`faucetMtps`) and
 * polling past indexer lag if it's short. Returns the coin id to stake. For self-play that funds N
 * seats from ONE coin, pass the SUM as `need`. Used by any flow that stakes MTPS from a non-wallet
 * identity (e.g. autonomous bots) where the background wallet auto-faucet doesn't apply.
 */
export async function ensureMtpsStakeCoin(opts: {
  client: MtpsCoinReader;
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
    // This path needs an owned coin to stake, so faucet an owned coin (not the address balance).
    await faucetMtps({ recipient: opts.owner, toBalance: false });
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
  if (total < opts.need) {
    // Not enough owned coins to cover the stake: faucet straight into the address balance
    // (admin_mint_to_balance) — the backend deposit IS the funding, so there's nothing to sweep.
    await faucetMtps({ recipient: opts.owner, toBalance: true });
  } else {
    // Already hold enough as owned coins: sweep them into the address balance (no faucet needed) so
    // the open can withdraw from it.
    const coins = await readCoins();
    if (coins.length > 0) {
      const tx = new Transaction();
      buildSweepToAddressBalance(
        tx,
        opts.owner,
        coins.map((c) => c.coinObjectId),
      );
      await opts.signExec(tx);
    }
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
