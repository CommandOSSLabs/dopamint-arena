// Agent Allowance — a delegated, capped, rate-limited, pull-based payment mandate
// (the on-chain `example_agent_allowance` module). A principal escrows MTPS payable
// only to a fixed payee; the payee/delegate PULLS what's owed with no per-charge
// co-signature, bounded by `min(spendCap, max(rateAccrual, voucher))` and the escrow.
//
// Published as a SLIM standalone package (signature + errors + example_agent_allowance)
// because the full sui_tunnel framework exceeds the 128KB single-tx publish limit.
// Funds are denominated in MTPS so the app shares the arena's free stake token.
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { MTPS_COIN_TYPE } from "./mtps";

export const AGENT_ALLOWANCE_PACKAGE_ID =
  import.meta.env?.VITE_AGENT_ALLOWANCE_PACKAGE_ID ?? "";

/** True once the package id and MTPS coin type are both configured. */
export const isAgentAllowanceConfigured = Boolean(
  AGENT_ALLOWANCE_PACKAGE_ID && MTPS_COIN_TYPE,
);

const MODULE = "example_agent_allowance";
const target = (fn: string) =>
  `${AGENT_ALLOWANCE_PACKAGE_ID}::${MODULE}::${fn}`;

/** Lifecycle status codes (mirror the Move `STATUS_*` constants). */
export const AllowanceStatus = { ACTIVE: 0, PAUSED: 1, REVOKED: 2 } as const;

export function allowanceStatusName(status: number): string {
  switch (status) {
    case AllowanceStatus.ACTIVE:
      return "Active";
    case AllowanceStatus.PAUSED:
      return "Paused";
    case AllowanceStatus.REVOKED:
      return "Revoked";
    default:
      return "Unknown";
  }
}

// ============================================
// TRANSACTION BUILDERS
// ============================================

/**
 * Build the create+share tx: split `fundAmount` MTPS off `fundsCoinId` as escrow,
 * then `entry_create_and_share` (the entry variant shares the `Allowance` itself).
 * Leave `principalPublicKey` empty for a pure rate-authorized mandate (no vouchers).
 */
export function buildCreateAllowanceTx(opts: {
  fundsCoinId: string;
  fundAmount: bigint;
  payee: string;
  delegate?: string | null;
  ratePerSecond: bigint;
  spendCap: bigint;
  expiryMs?: bigint;
  principalPublicKey?: Uint8Array;
  signatureType?: number;
}): Transaction {
  const tx = new Transaction();
  const [funds] = tx.splitCoins(tx.object(opts.fundsCoinId), [
    tx.pure.u64(opts.fundAmount),
  ]);
  tx.moveCall({
    target: target("entry_create_and_share"),
    typeArguments: [MTPS_COIN_TYPE],
    arguments: [
      tx.pure.address(opts.payee),
      tx.pure.option("address", opts.delegate ?? null),
      tx.pure.vector(
        "u8",
        Array.from(opts.principalPublicKey ?? new Uint8Array(0)),
      ),
      tx.pure.u8(opts.signatureType ?? 0),
      funds,
      tx.pure.u64(opts.ratePerSecond),
      tx.pure.u64(opts.spendCap),
      tx.pure.u64(opts.expiryMs ?? 0n),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/** Pull `amount` to the payee (callable by payee/delegate/principal). */
export function buildClaimTx(allowanceId: string, amount: bigint): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("entry_claim"),
    typeArguments: [MTPS_COIN_TYPE],
    arguments: [
      tx.object(allowanceId),
      tx.pure.u64(amount),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/** Add escrow to a live allowance (principal only). */
export function buildTopUpTx(
  allowanceId: string,
  fundsCoinId: string,
  amount: bigint,
): Transaction {
  const tx = new Transaction();
  const [funds] = tx.splitCoins(tx.object(fundsCoinId), [tx.pure.u64(amount)]);
  tx.moveCall({
    target: target("entry_top_up"),
    typeArguments: [MTPS_COIN_TYPE],
    arguments: [tx.object(allowanceId), funds],
  });
  return tx;
}

/** Change the streaming rate (principal only); accrual to date is folded in. */
export function buildSetRateTx(
  allowanceId: string,
  newRatePerSecond: bigint,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("set_rate"),
    typeArguments: [MTPS_COIN_TYPE],
    arguments: [
      tx.object(allowanceId),
      tx.pure.u64(newRatePerSecond),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

function buildClockOnlyTx(allowanceId: string, fn: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target(fn),
    typeArguments: [MTPS_COIN_TYPE],
    arguments: [tx.object(allowanceId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });
  return tx;
}

/** Freeze accrual and block claims (principal only). */
export const buildPauseTx = (id: string) => buildClockOnlyTx(id, "pause");
/** Resume a paused allowance; the paused interval is not credited (principal only). */
export const buildResumeTx = (id: string) => buildClockOnlyTx(id, "resume");
/** Settle the payee's earned amount, refund the rest, mark terminal (principal only). */
export const buildRevokeTx = (id: string) =>
  buildClockOnlyTx(id, "entry_revoke");

// ============================================
// READS
// ============================================

/** Parsed on-chain `Allowance` state needed by the UI and the accrual math. */
export interface AllowanceFields {
  id: string;
  principal: string;
  payee: string;
  delegate: string | null;
  ratePerSecond: bigint;
  spendCap: bigint;
  spent: bigint;
  vestedFloor: bigint;
  anchorMs: bigint;
  authorizedTotal: bigint;
  expiryMs: bigint;
  status: number;
  createdAt: bigint;
  escrowBalance: bigint;
}

/** Minimal client surface, satisfied by dapp-kit's SuiClient. */
export interface AllowanceReader {
  getObject(input: {
    id: string;
    options?: { showContent?: boolean };
  }): Promise<{ data?: { content?: unknown } | null }>;
  getTransactionBlock(input: {
    digest: string;
    options?: { showObjectChanges?: boolean };
  }): Promise<{ objectChanges?: unknown[] }>;
}

// `Option<address>` and `Balance<T>` can surface in object JSON either flattened
// (a bare value/null) or nested (`{ vec: [...] }` / `{ value }`, optionally under
// `fields`). Parse defensively so a future RPC shape change doesn't break reads.
function parseOptionAddress(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  const obj = v as { vec?: unknown[]; fields?: { vec?: unknown[] } };
  const vec = obj.vec ?? obj.fields?.vec;
  if (Array.isArray(vec)) return vec.length ? String(vec[0]) : null;
  return null;
}

function parseU64ish(v: unknown): bigint {
  if (v == null) return 0n;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") {
    return BigInt(v);
  }
  const obj = v as { value?: unknown; fields?: { value?: unknown } };
  const inner = obj.value ?? obj.fields?.value;
  return inner != null ? BigInt(inner as string) : 0n;
}

/** Read and parse a shared `Allowance` object; null if missing or not yet indexed. */
export async function fetchAllowance(
  client: AllowanceReader,
  id: string,
): Promise<AllowanceFields | null> {
  const res = await client.getObject({ id, options: { showContent: true } });
  const content = res.data?.content as
    | { dataType?: string; fields?: Record<string, unknown> }
    | undefined;
  if (!content || content.dataType !== "moveObject" || !content.fields) {
    return null;
  }
  const f = content.fields;
  return {
    id,
    principal: String(f.principal),
    payee: String(f.payee),
    delegate: parseOptionAddress(f.delegate),
    ratePerSecond: parseU64ish(f.rate_per_second),
    spendCap: parseU64ish(f.spend_cap),
    spent: parseU64ish(f.spent),
    vestedFloor: parseU64ish(f.vested_floor),
    anchorMs: parseU64ish(f.anchor_ms),
    authorizedTotal: parseU64ish(f.authorized_total),
    expiryMs: parseU64ish(f.expiry_ms),
    status: Number(f.status),
    createdAt: parseU64ish(f.created_at),
    escrowBalance: parseU64ish(f.escrow),
  };
}

/**
 * Find the `Allowance` created by a `buildCreateAllowanceTx` execution. The object
 * changes can lag the digest, so poll briefly past indexer lag before giving up.
 */
export async function findCreatedAllowanceId(
  client: AllowanceReader,
  digest: string,
): Promise<string | null> {
  for (let i = 0; i < 10; i++) {
    try {
      const tb = await client.getTransactionBlock({
        digest,
        options: { showObjectChanges: true },
      });
      for (const c of tb.objectChanges ?? []) {
        const ch = c as {
          type?: string;
          objectType?: string;
          objectId?: string;
        };
        if (
          ch.type === "created" &&
          typeof ch.objectType === "string" &&
          ch.objectType.includes(`::${MODULE}::Allowance`) &&
          ch.objectId
        ) {
          return ch.objectId;
        }
      }
    } catch {
      // digest not indexed yet — fall through to the wait
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return null;
}

// ============================================
// OFF-CHAIN ACCRUAL MATH (mirrors the Move exactly)
// ============================================

/** Subset of allowance state needed to predict entitlement off-chain. */
export interface AccrualState {
  ratePerSecond: bigint;
  vestedFloor: bigint;
  anchorMs: bigint;
  authorizedTotal: bigint;
  spendCap: bigint;
  /** 0 = open-ended. */
  expiryMs: bigint;
  status: number;
}

const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

function rateVested(s: AccrualState, nowMs: bigint): bigint {
  if (s.status !== AllowanceStatus.ACTIVE) {
    return minBig(s.vestedFloor, s.spendCap);
  }
  const deadline = s.expiryMs === 0n ? nowMs : minBig(s.expiryMs, nowMs);
  const elapsedSecs =
    deadline > s.anchorMs ? (deadline - s.anchorMs) / 1000n : 0n;
  const accrued = s.vestedFloor + s.ratePerSecond * elapsedSecs;
  return minBig(accrued, s.spendCap);
}

/** Total entitlement at `nowMs`: `min(spendCap, max(rateVested, authorizedTotal))`. */
export function computeEntitled(s: AccrualState, nowMs: bigint): bigint {
  const byRate = rateVested(s, nowMs);
  const e = byRate > s.authorizedTotal ? byRate : s.authorizedTotal;
  return minBig(e, s.spendCap);
}

/** Pullable right now: `min(entitled - spent, escrow)`, or 0 if not active. */
export function computeAvailable(
  s: AccrualState,
  spent: bigint,
  escrowBalance: bigint,
  nowMs: bigint,
): bigint {
  if (s.status !== AllowanceStatus.ACTIVE) return 0n;
  const entitled = computeEntitled(s, nowMs);
  const unspent = entitled > spent ? entitled - spent : 0n;
  return minBig(unspent, escrowBalance);
}

/** Project the accrual subset out of a full read (for the live ticker). */
export function toAccrualState(a: AllowanceFields): AccrualState {
  return {
    ratePerSecond: a.ratePerSecond,
    vestedFloor: a.vestedFloor,
    anchorMs: a.anchorMs,
    authorizedTotal: a.authorizedTotal,
    spendCap: a.spendCap,
    expiryMs: a.expiryMs,
    status: a.status,
  };
}
