/**
 * ===== Dopamint extension (not upstream sui-tunnel) =====
 *
 * SDK side of the `tunnel::create_and_fund` Move extension. Kept in its own file
 * (not folded into `txbuilders.ts`) so an upstream SDK re-sync stays a clean
 * no-conflict merge.
 */

import {
  Transaction,
  type TransactionObjectArgument,
  type TransactionResult,
} from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { buildTarget, MODULES, SUI_COIN_TYPE } from "../config";
import { buildDeposit, type PartyArgs, type WithCoinType } from "./txbuilders";

const TUNNEL = MODULES.TUNNEL;
const CLOCK = SUI_CLOCK_OBJECT_ID;

function vecU8(tx: Transaction, b: Uint8Array) {
  return tx.pure.vector("u8", Array.from(b));
}

/**
 * Append one `create_and_fund_with_id` call, funding both parties from two caller-supplied
 * coins. Targets the ID-returning `public fun` so its result, the shared
 * tunnel's `ID` composes with later PTB commands; the funder need not be a party.
 */
export function buildCreateAndFund(
  tx: Transaction,
  p: {
    partyA: PartyArgs;
    partyB: PartyArgs;
    coinA: TransactionObjectArgument;
    coinB: TransactionObjectArgument;
    timeoutMs: bigint;
    penaltyAmount?: bigint;
  } & WithCoinType,
): TransactionResult {
  return tx.moveCall({
    target: buildTarget(TUNNEL, "create_and_fund_with_id"),
    typeArguments: [p.coinType ?? SUI_COIN_TYPE],
    arguments: [
      tx.pure.address(p.partyA.address),
      vecU8(tx, p.partyA.publicKey),
      tx.pure.u8(p.partyA.signatureType),
      tx.pure.address(p.partyB.address),
      vecU8(tx, p.partyB.publicKey),
      tx.pure.u8(p.partyB.signatureType),
      p.coinA,
      p.coinB,
      tx.pure.u64(p.timeoutMs),
      tx.pure.u64(p.penaltyAmount ?? 0n),
      tx.object(CLOCK),
    ],
  });
}

/**
 * PvP one-signature setup: open a shared tunnel AND fund seat A's stake in ONE PTB, so the
 * creator (party A) approves a single wallet tx instead of create + deposit separately.
 * Composes `create` (returns the owned object) → `deposit_party_a` (gated to the sender =
 * party A's address) → `public_share_object` (valid because `Tunnel` has the `store` ability).
 * Party B funds its own seat separately (`buildDepositFromGas`). `aAmount` is split off the gas
 * coin, so SUI only — a non-SUI `coinType` would need a supplied source coin (not exposed here).
 */
export function buildOpenAndFundSeatA(
  tx: Transaction,
  p: {
    partyA: PartyArgs;
    partyB: PartyArgs;
    aAmount: bigint;
    timeoutMs: bigint;
    penaltyAmount?: bigint;
  } & WithCoinType,
): void {
  const coinType = p.coinType ?? SUI_COIN_TYPE;
  const tunnel = tx.moveCall({
    target: buildTarget(TUNNEL, "create"),
    typeArguments: [coinType],
    arguments: [
      tx.pure.address(p.partyA.address),
      vecU8(tx, p.partyA.publicKey),
      tx.pure.u8(p.partyA.signatureType),
      tx.pure.address(p.partyB.address),
      vecU8(tx, p.partyB.publicKey),
      tx.pure.u8(p.partyB.signatureType),
      tx.pure.u64(p.timeoutMs),
      tx.pure.u64(p.penaltyAmount ?? 0n),
      tx.object(CLOCK),
    ],
  });
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(p.aAmount)]);
  tx.moveCall({
    target: buildTarget(TUNNEL, "deposit_party_a"),
    typeArguments: [coinType],
    arguments: [tunnel, coin, tx.object(CLOCK)],
  });
  tx.moveCall({
    target: "0x2::transfer::public_share_object",
    typeArguments: [`${buildTarget(TUNNEL, "Tunnel")}<${coinType}>`],
    arguments: [tunnel],
  });
}

/** One tunnel's open spec: both parties plus each side's stake (coin's smallest unit). */
export interface TunnelOpenSpec {
  partyA: PartyArgs;
  partyB: PartyArgs;
  aAmount: bigint;
  bAmount: bigint;
  timeoutMs: bigint;
  penaltyAmount?: bigint;
}

/** Coin selection for a batch open: which coin type, and which coin to split stakes from. */
export interface BatchFundOptions {
  /** Move type argument `T` for every tunnel; defaults to SUI. */
  coinType?: string;
  /**
   * The `Coin<T>` to split all 2N stakes from. Omit only for SUI, where it defaults to the gas
   * coin. Required for any non-SUI `coinType` because gas is always `Coin<SUI>`.
   */
  sourceCoin?: TransactionObjectArgument;
}

/**
 * Assemble "open + fund + activate N tunnels in ONE PTB" into `tx`: one split for
 * all 2N stakes, then one `create_and_fund_with_id` per spec. The whole batch settles under
 * one signature from the funding wallet.
 */
export function buildOpenAndFundMany(
  tx: Transaction,
  specs: TunnelOpenSpec[],
  opts: BatchFundOptions = {},
): TransactionResult[] {
  const coinType = opts.coinType ?? SUI_COIN_TYPE;
  if (coinType !== SUI_COIN_TYPE && !opts.sourceCoin) {
    throw new Error(
      `buildOpenAndFundMany: coinType ${coinType} is not SUI, so opts.sourceCoin (a Coin<${coinType}> ` +
        `to split stakes from) is required — non-SUI stakes cannot come from the gas coin.`,
    );
  }
  const source = opts.sourceCoin ?? tx.gas;
  const amounts = specs.flatMap((s) => [s.aAmount, s.bAmount]);
  const coins = tx.splitCoins(
    source,
    amounts.map((a) => tx.pure.u64(a)),
  );
  return specs.map((s, i) =>
    buildCreateAndFund(tx, {
      partyA: s.partyA,
      partyB: s.partyB,
      coinA: coins[2 * i],
      coinB: coins[2 * i + 1],
      timeoutMs: s.timeoutMs,
      penaltyAmount: s.penaltyAmount,
      coinType,
    }),
  );
}

/** One seat's batch deposit: which already-shared tunnel, and the stake to fund it with. */
export interface BatchDepositSpec {
  tunnelId: string;
  amount: bigint;
}

/**
 * Assemble "fund my seat in N already-shared tunnels in ONE PTB" into `tx`: a single
 * `splitCoins` of all N stakes off one source coin, then one `entry_deposit` per tunnel.
 *
 * This is the human side of batch-open: the backend factory has already created+shared each
 * tunnel (with this wallet as a party), and this PTB funds only this wallet's seats.
 * `entry_deposit` auto-routes by sender, so the gating passes for whichever seat this wallet
 * holds. One transaction = one gas-coin use, so the wallet never fires concurrent on-chain txs
 * and never hits Sui equivocation.
 *
 * Coin selection mirrors `buildOpenAndFundMany`:
 * - SUI (default): omit `opts`; stakes split off the gas coin.
 * - Non-SUI: pass `opts.coinType` AND `opts.sourceCoin`; a non-SUI coinType without a sourceCoin
 *   throws rather than mis-typing gas-coin (`Coin<SUI>`) arguments as `<T>` and aborting on-chain.
 *
 * Scale note: each spec adds one `splitCoins` output + one `moveCall`, so a very large
 * `specs.length` approaches the PTB command/argument ceilings — keep batches modest.
 */
export function buildDepositMany(
  tx: Transaction,
  specs: BatchDepositSpec[],
  opts: BatchFundOptions = {},
): void {
  const coinType = opts.coinType ?? SUI_COIN_TYPE;
  if (coinType !== SUI_COIN_TYPE && !opts.sourceCoin) {
    throw new Error(
      `buildDepositMany: coinType ${coinType} is not SUI, so opts.sourceCoin (a Coin<${coinType}> ` +
        `to split stakes from) is required — non-SUI stakes cannot come from the gas coin.`,
    );
  }
  const source = opts.sourceCoin ?? tx.gas;
  const coins = tx.splitCoins(
    source,
    specs.map((s) => tx.pure.u64(s.amount)),
  );
  specs.forEach((s, i) => {
    buildDeposit(tx, { tunnelId: s.tunnelId, coin: coins[i], coinType });
  });
}
