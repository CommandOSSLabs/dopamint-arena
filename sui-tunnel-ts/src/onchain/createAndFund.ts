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
 * Append one create-and-fund call, funding both parties from two caller-supplied coins; the
 * funder need not be a party. Defaults to the ID-returning `create_and_fund_with_id` so the new
 * shared tunnel's `ID` composes with later PTB commands. Pass `withId: false` to target the plain
 * `create_and_fund` (shares internally, returns nothing) — for callers that read the tunnel id
 * from `objectChanges` afterwards, and for deployments that predate the `_with_id` variant.
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
    withId?: boolean;
  } & WithCoinType,
): TransactionResult {
  return tx.moveCall({
    target: buildTarget(
      TUNNEL,
      p.withId === false ? "create_and_fund" : "create_and_fund_with_id",
    ),
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
 * Append one returnless `create_and_fund` call (the variant that does NOT return the tunnel's
 * `ID`). Functionally identical to {@link buildCreateAndFund} for the caller who reads the id
 * from the tx's object changes and never chains it in the PTB — e.g. Quantum Poker, whose
 * randomness is two-party commit-reveal, so it needs no on-chain id/seed composition.
 */
export function buildCreateAndFundReturnless(
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

/**
 * PvP one-signature setup: open a shared tunnel AND fund seat A's stake in ONE PTB, so the
 * creator (party A) approves a single wallet tx instead of create + deposit separately.
 * Composes `create` (returns the owned object) → `deposit_party_a` (gated to the sender =
 * party A's address) → `public_share_object` (valid because `Tunnel` has the `store` ability).
 * Party B funds its own seat separately (`buildDepositFromGas`). By default `aAmount` is split
 * off the gas coin (SUI only). Pass `stakeCoin` to split the stake off a caller-owned `Coin<T>`
 * instead — required for a non-SUI `coinType`, and used by the gas-sponsored path (ADR-0009) so
 * the stake stays the user's while the gas is sponsored (with SIP-58 gas there is no gas coin).
 */
export function buildOpenAndFundSeatA(
  tx: Transaction,
  p: {
    partyA: PartyArgs;
    partyB: PartyArgs;
    aAmount: bigint;
    timeoutMs: bigint;
    penaltyAmount?: bigint;
    /** `Coin<T>` to split seat A's stake from; defaults to the gas coin (SUI sender-pays). */
    stakeCoin?: TransactionObjectArgument;
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
  const [coin] = tx.splitCoins(p.stakeCoin ?? tx.gas, [tx.pure.u64(p.aAmount)]);
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
      // The batch self-play opener reads each tunnel id from objectChanges, never in-PTB, so it
      // targets the plain `create_and_fund` — which the deployed package has (the `_with_id`
      // variant is source-only / undeployed). The id-returning path stays for composers below.
      withId: false,
    }),
  );
}

/**
 * Open + fund + activate ONE tunnel in a single PTB via the returnless `create_and_fund`.
 * Splits both seats' stakes off the source coin (gas for SUI) internally, so the caller passes
 * only plain data and reads the tunnel id from object changes. For callers that never chain the
 * id in the PTB (Quantum Poker — commit-reveal randomness, no on-chain seed).
 */
export function buildOpenAndFundOneReturnless(
  tx: Transaction,
  spec: TunnelOpenSpec,
  opts: BatchFundOptions = {},
): void {
  const coinType = opts.coinType ?? SUI_COIN_TYPE;
  if (coinType !== SUI_COIN_TYPE && !opts.sourceCoin) {
    throw new Error(
      `buildOpenAndFundOneReturnless: coinType ${coinType} is not SUI, so opts.sourceCoin ` +
        `(a Coin<${coinType}> to split stakes from) is required.`,
    );
  }
  const source = opts.sourceCoin ?? tx.gas;
  const [coinA, coinB] = tx.splitCoins(source, [
    tx.pure.u64(spec.aAmount),
    tx.pure.u64(spec.bAmount),
  ]);
  buildCreateAndFundReturnless(tx, {
    partyA: spec.partyA,
    partyB: spec.partyB,
    coinA,
    coinB,
    timeoutMs: spec.timeoutMs,
    penaltyAmount: spec.penaltyAmount,
    coinType,
  });
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
