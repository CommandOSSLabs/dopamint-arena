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
  } & WithCoinType
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

/** One tunnel's open spec: both parties plus each side's stake (SUI MIST by default). */
export interface TunnelOpenSpec {
  partyA: PartyArgs;
  partyB: PartyArgs;
  aAmount: bigint;
  bAmount: bigint;
  timeoutMs: bigint;
  penaltyAmount?: bigint;
}

/**
 * Assemble "open + fund + activate N tunnels in ONE PTB" into `tx`: a single `splitCoins`
 * of all 2N stakes off the gas coin, then one `create_and_fund` per spec. The whole batch
 * settles under one signature from the gas-paying wallet. SUI-only (funds come from gas).
 */
export function buildOpenAndFundMany(
  tx: Transaction,
  specs: TunnelOpenSpec[],
  coinType?: string
): void {
  const amounts = specs.flatMap((s) => [s.aAmount, s.bAmount]);
  const coins = tx.splitCoins(
    tx.gas,
    amounts.map((a) => tx.pure.u64(a))
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
