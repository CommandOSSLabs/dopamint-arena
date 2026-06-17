/**
 * ===== Dopamint extension (not upstream sui-tunnel) =====
 *
 * SDK side of the `tunnel::create_and_fund` Move extension. Kept in its own file (not folded
 * into `txbuilders.ts`) so an upstream SDK re-sync stays a clean no-conflict merge.
 */

import {
  Transaction,
  TransactionObjectArgument,
} from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { buildTarget, MODULES, SUI_COIN_TYPE } from "../config";
import { PartyArgs, WithCoinType } from "./txbuilders";

const TUNNEL = MODULES.TUNNEL;
const CLOCK = SUI_CLOCK_OBJECT_ID;

function vecU8(tx: Transaction, b: Uint8Array) {
  return tx.pure.vector("u8", Array.from(b));
}

/**
 * Append one `create_and_fund` call, funding both parties from two caller-supplied coins.
 * Targets the `public fun` (not `entry`) so it composes with PTB results; the funder need
 * not be a party.
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
): void {
  tx.moveCall({
    target: buildTarget(TUNNEL, "create_and_fund"),
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
   * coin. Required for any non-SUI `coinType` — the gas coin is always `Coin<SUI>`, so non-SUI
   * stakes must come from a coin the caller supplies (e.g. `tx.object(coinId)` or a split result).
   */
  sourceCoin?: TransactionObjectArgument;
}

/**
 * Assemble "open + fund + activate N tunnels in ONE PTB" into `tx`: a single `splitCoins`
 * of all 2N stakes off one source coin, then one `create_and_fund` per spec. The whole batch
 * settles under one signature from the funding wallet.
 *
 * Works with any coin type `T` (the contract's `create_and_fund<T>` is generic):
 * - SUI (default): omit `opts`; stakes are split off the gas coin (`Coin<SUI>`).
 * - Non-SUI: pass `opts.coinType` AND `opts.sourceCoin` (a `Coin<T>` to split from). The gas
 *   coin can't fund a non-SUI batch, so a non-SUI `coinType` without a `sourceCoin` throws rather
 *   than building a tx whose `Coin<SUI>` arguments are typed `<T>` and abort on-chain.
 *
 * Scale note: each spec adds one `splitCoins` output and one `moveCall`, so a very large
 * `specs.length` approaches the PTB command/argument ceilings — keep batches modest.
 */
export function buildOpenAndFundMany(
  tx: Transaction,
  specs: TunnelOpenSpec[],
  opts: BatchFundOptions = {},
): void {
  const coinType = opts.coinType ?? SUI_COIN_TYPE;
  if (coinType !== SUI_COIN_TYPE && !opts.sourceCoin) {
    throw new Error(
      `buildOpenAndFundMany: coinType ${coinType} is not SUI, so opts.sourceCoin (a Coin<${coinType}> ` +
        `to split stakes from) is required — non-SUI stakes cannot come from the gas coin.`,
    );
  }
  // SUI defaults to the gas coin; any other type splits from the caller-supplied coin.
  const source = opts.sourceCoin ?? tx.gas;
  const amounts = specs.flatMap((s) => [s.aAmount, s.bAmount]);
  const coins = tx.splitCoins(
    source,
    amounts.map((a) => tx.pure.u64(a)),
  );
  specs.forEach((s, i) => {
    buildCreateAndFund(tx, {
      partyA: s.partyA,
      partyB: s.partyB,
      coinA: coins[2 * i],
      coinB: coins[2 * i + 1],
      timeoutMs: s.timeoutMs,
      penaltyAmount: s.penaltyAmount,
      coinType,
    });
  });
}
