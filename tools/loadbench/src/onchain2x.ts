/**
 * Self-contained on-chain helpers for the SIP-58 probe, on @mysten/sui 2.x.
 *
 * Why a local copy instead of importing the sui-tunnel-ts builders: loadbench is bumped to
 * @mysten/sui 2.x (for SIP-58 address-balance gas + `tx.withdrawal`), while sui-tunnel-ts stays
 * upstream-pinned at 1.28.1. Passing a 2.x `Transaction` into a 1.x builder couples two SDK majors
 * at runtime; copying the handful of builders here keeps every `Transaction` on one version and
 * leaves the upstream framework untouched. The off-chain engine (core/*, protocol/*) carries no
 * `@mysten/sui` Transaction, so those imports stay pointed at sui-tunnel-ts (version-safe).
 *
 * The builders are byte-identical to the canonical ones (createAndFund.ts / txbuilders.ts) — same
 * Move targets, same arg order. The NEW capability is the SIP-58 path: stake withdrawn from the
 * sender's address balance (`coin::redeem_funds`) and gas drawn from the gas owner's address
 * balance (empty `gas_payment` + `ValidDuring`), so one account fires unlimited concurrent txs with
 * no owned-coin version to lock — the whole point of the rerun.
 */

import { SuiClient } from "./suiClient";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  Transaction,
  type TransactionObjectArgument,
  type TransactionResult,
} from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID, SUI_TYPE_ARG, toBase64 } from "@mysten/sui/utils";
import type { CoSignedSettlementWithRoot } from "../../../sui-tunnel-ts/src/core/tunnel";

export const SUI_COIN_TYPE = SUI_TYPE_ARG;
const CLOCK = SUI_CLOCK_OBJECT_ID;

/** `pkg::module::fn`, reading PACKAGE_ID from env (set by the stack's .env.local). */
export function buildTarget(module: string, fn: string): string {
  const pkg = process.env.PACKAGE_ID || process.env.TUNNEL_PACKAGE_ID || "";
  if (!pkg) throw new Error("PACKAGE_ID not set (source tools/loadbench/.env.local)");
  return `${pkg}::${module}::${fn}`;
}

function vecU8(tx: Transaction, b: Uint8Array) {
  return tx.pure.vector("u8", Array.from(b));
}

export interface PartyArgs {
  address: string;
  publicKey: Uint8Array;
  signatureType: number;
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

/** Append one returnless `create_and_fund` (shares internally; id read from objectChanges). */
function buildCreateAndFund(
  tx: Transaction,
  p: {
    partyA: PartyArgs;
    partyB: PartyArgs;
    coinA: TransactionObjectArgument;
    coinB: TransactionObjectArgument;
    timeoutMs: bigint;
    penaltyAmount?: bigint;
    coinType: string;
  },
): TransactionResult {
  return tx.moveCall({
    target: buildTarget("tunnel", "create_and_fund"),
    typeArguments: [p.coinType],
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
 * Open + fund N tunnels in one PTB: split all 2N stakes off `sourceCoin`, then one
 * `create_and_fund` per spec. `sourceCoin` is a `Coin<T>` the caller supplies — for the SIP-58 path
 * it is the coin redeemed from an address-balance withdrawal ({@link redeemStakeFromBalance}).
 */
export function buildOpenAndFundMany(
  tx: Transaction,
  specs: TunnelOpenSpec[],
  coinType: string,
  sourceCoin: TransactionObjectArgument,
): void {
  const amounts = specs.flatMap((s) => [s.aAmount, s.bAmount]);
  const coins = tx.splitCoins(
    sourceCoin,
    amounts.map((a) => tx.pure.u64(a)),
  );
  specs.forEach((s, i) =>
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

/** Root-anchored cooperative close from the engine's CoSignedSettlementWithRoot. */
export function buildCloseWithRootFromSettlement(
  tx: Transaction,
  tunnelId: string,
  s: CoSignedSettlementWithRoot,
  coinType: string,
): void {
  tx.moveCall({
    target: buildTarget("tunnel", "entry_close_cooperative_with_root"),
    typeArguments: [coinType],
    arguments: [
      tx.object(tunnelId),
      tx.pure.u64(s.settlement.partyABalance),
      tx.pure.u64(s.settlement.partyBBalance),
      vecU8(tx, s.sigA),
      vecU8(tx, s.sigB),
      tx.pure.u64(s.settlement.timestamp),
      vecU8(tx, s.settlement.transcriptRoot),
      tx.object(CLOCK),
    ],
  });
}

/**
 * Build a stake `Coin<T>` by withdrawing `amount` from the SENDER's SIP-58 address balance
 * (`coin::redeem_funds<T>(tx.withdrawal(...))`). No object is version-pinned, so concurrent txs each
 * draw their own reservation from the one balance and never equivocate.
 */
export function redeemStakeFromBalance(
  tx: Transaction,
  amount: bigint,
  coinType: string,
): TransactionObjectArgument {
  const [coin] = tx.moveCall({
    target: "0x2::coin::redeem_funds",
    typeArguments: [coinType],
    arguments: [tx.withdrawal({ amount, type: coinType })],
  });
  return coin;
}

/**
 * Destroy the zero remainder a stake split leaves behind on the address-balance path: the redeemed
 * `Coin<T>` is split for exactly the stake total, but the now-zero source coin has no `drop`, so the
 * PTB is rejected ("Unused ValueWithoutDrop") unless it is consumed.
 */
export function consumeZeroRemainder(
  tx: Transaction,
  source: TransactionObjectArgument,
  coinType: string,
): void {
  tx.moveCall({
    target: "0x2::coin::destroy_zero",
    typeArguments: [coinType],
    arguments: [source],
  });
}

/** Per-process monotonic nonce for the `ValidDuring` replay guard (seeded off wall clock). */
let nonceCounter = Date.now() & 0x7fffffff;
export function nextNonce(): number {
  nonceCounter = (nonceCounter + 1) & 0x7fffffff;
  return nonceCounter;
}

/**
 * Set SIP-58 address-balance gas on `tx`: empty gas payment drawn from `owner`'s address balance,
 * with the `ValidDuring` window (epoch-bounded + per-tx nonce) that gives the gas FundsWithdrawal its
 * replay protection. `chainDigest` is the genesis checkpoint digest (base58); without the matching
 * chain + epoch window the node rejects the withdrawal.
 */
export function applyAddressBalanceGas(
  tx: Transaction,
  opts: {
    sender: string;
    owner: string;
    budgetMist: number;
    gasPrice: number | bigint;
    epoch: number | bigint;
    chainDigest: string;
    nonce: number;
  },
): void {
  tx.setSender(opts.sender);
  tx.setGasOwner(opts.owner);
  tx.setGasPayment([]); // empty => address-balance gas (SIP-58); also disables auto gas selection
  tx.setGasBudget(opts.budgetMist);
  tx.setGasPrice(opts.gasPrice);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: Number(opts.epoch),
      maxEpoch: Number(opts.epoch),
      minTimestamp: null,
      maxTimestamp: null,
      chain: opts.chainDigest,
      nonce: opts.nonce,
    },
  });
}

export interface ExecResult {
  digest: string;
  effects: unknown;
  objectChanges: unknown;
}

/**
 * Build (gas already set), sign with the single `signer` (the settler is sender + gas owner for the
 * sponsor-driven path), and submit. Surfaces a Move-aborted (committed-but-failed) tx as a throw, so
 * the caller counts it as an error rather than a success.
 */
export async function submitAddressBalance(
  client: SuiClient,
  signer: Ed25519Keypair,
  tx: Transaction,
  opts: { waitForFinality?: boolean } = {},
): Promise<ExecResult> {
  const bytes = await tx.build({ client });
  const { signature } = await signer.signTransaction(bytes);
  const res = await client.executeTransactionBlock({
    transactionBlock: toBase64(bytes),
    signature: [signature],
    options: { showEffects: true, showObjectChanges: true },
    requestType: opts.waitForFinality ? "WaitForLocalExecution" : undefined,
  });
  const status = (
    res.effects as { status?: { status?: string; error?: string } } | undefined
  )?.status;
  if (status?.status === "failure") {
    throw new Error(
      `tx ${res.digest} failed on-chain: ${status.error ?? "unknown Move abort"}`,
    );
  }
  return {
    digest: res.digest,
    effects: res.effects,
    objectChanges: res.objectChanges,
  };
}

/**
 * Deposit SUI into `owner`'s SIP-58 address balance until it holds >= `needMist`, paid with the
 * signer's OWN coins (normal owned-coin gas — the bootstrap before any address-balance tx). Polls
 * until the checkpoint-settled `fundsInAddressBalance` reflects it: SIP-58 deposits land at a
 * checkpoint boundary, not in the depositing tx, so a withdrawal in the very next tx would otherwise
 * dry-run against a still-empty balance.
 */
export async function ensureAddressBalance(
  client: SuiClient,
  signer: Ed25519Keypair,
  owner: string,
  needMist: bigint,
  coinType: string = SUI_COIN_TYPE,
): Promise<void> {
  const read = async () => {
    const b = (await client.getBalance({ owner, coinType })) as {
      fundsInAddressBalance?: string;
    };
    return BigInt(b.fundsInAddressBalance ?? "0");
  };
  if ((await read()) >= needMist) return;
  const tx = new Transaction();
  const [chunk] = tx.splitCoins(tx.gas, [tx.pure.u64(needMist)]);
  tx.moveCall({
    target: "0x2::coin::send_funds",
    typeArguments: [coinType],
    arguments: [chunk, tx.pure.address(owner)],
  });
  tx.setGasBudget(50_000_000);
  await client.signAndExecuteTransaction({ signer, transaction: tx });
  for (let i = 0; i < 40; i++) {
    if ((await read()) >= needMist) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(
    `address balance for ${owner} did not reach ${needMist} after deposit (checkpoint lag)`,
  );
}

/** Parse created shared object ids of a given type tag from a tx's objectChanges. */
export function getCreatedObjectIds(
  objectChanges: unknown,
  objectType?: string,
): string[] {
  if (!Array.isArray(objectChanges)) return [];
  return (objectChanges as Array<Record<string, unknown>>)
    .filter((c) => {
      if (c.type !== "created") return false;
      if (objectType && !String(c.objectType ?? "").includes(objectType)) return false;
      return true;
    })
    .map((c) => c.objectId as string);
}

/** `(epoch, referenceGasPrice)` from the latest system state, in one RPC. */
export async function epochInfo(
  client: SuiClient,
): Promise<{ epoch: number; gasPrice: number }> {
  const s = (await client.call("suix_getLatestSuiSystemState", [])) as {
    epoch: string;
    referenceGasPrice: string;
  };
  return { epoch: Number(s.epoch), gasPrice: Number(s.referenceGasPrice) };
}

/** Genesis checkpoint (seq 0) digest in base58 — the `ValidDuring.chain` value for this network. */
export async function genesisDigest(client: SuiClient): Promise<string> {
  const cp = (await client.call("sui_getCheckpoint", ["0"])) as { digest: string };
  return cp.digest;
}
