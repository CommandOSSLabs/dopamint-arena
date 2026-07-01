// Streaming Payment — a time-based money stream (salary / subscription / vesting). The sender locks
// a total amount that unlocks LINEARLY over a duration; the recipient withdraws what's unlocked at
// any time; the sender can top up or cancel (the recipient keeps what it earned, the rest refunds).
//
// Wraps the `streaming_payment` Move module, published as a slim standalone package (it's
// self-contained — only `sui::` deps). Denominated in MTPS so it shares the arena's free token.
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { MTPS_COIN_TYPE } from "./mtps";

export const STREAMING_PAYMENT_PACKAGE_ID =
  import.meta.env?.VITE_STREAMING_PAYMENT_PACKAGE_ID ?? "";

/** True once the package id and MTPS coin type are both configured. */
export const isStreamingPaymentConfigured = Boolean(
  STREAMING_PAYMENT_PACKAGE_ID && MTPS_COIN_TYPE,
);

const MODULE = "streaming_payment";
const target = (fn: string) =>
  `${STREAMING_PAYMENT_PACKAGE_ID}::${MODULE}::${fn}`;

/** Minimum stream duration the contract accepts (`MIN_DURATION_MS` = 1 hour). */
export const MIN_DURATION_MS = 3_600_000n;

/** Lifecycle status codes (mirror the Move `STATUS_*` constants). */
export const StreamStatus = { ACTIVE: 0, COMPLETED: 1, CANCELLED: 2 } as const;

export function streamStatusName(status: number): string {
  switch (status) {
    case StreamStatus.ACTIVE:
      return "Active";
    case StreamStatus.COMPLETED:
      return "Completed";
    case StreamStatus.CANCELLED:
      return "Cancelled";
    default:
      return "Unknown";
  }
}

// ============================================
// TRANSACTION BUILDERS
// ============================================

/**
 * Build the create tx: split `totalAmount` MTPS off `fundsCoinId` as the stream's escrow, call
 * `create_stream` (returns the object), then share it so the recipient can withdraw against it.
 */
export function buildCreateStreamTx(opts: {
  fundsCoinId: string;
  totalAmount: bigint;
  recipient: string;
  durationMs: bigint;
  memo?: string;
}): Transaction {
  const tx = new Transaction();

  const [funds] = tx.splitCoins(tx.object(opts.fundsCoinId), [
    tx.pure.u64(opts.totalAmount),
  ]);

  tx.moveCall({
    target: target("create_stream"),
    typeArguments: [MTPS_COIN_TYPE],
    arguments: [
      tx.pure.address(opts.recipient),
      funds,
      tx.pure.u64(opts.durationMs),
      tx.pure.vector(
        "u8",
        Array.from(new TextEncoder().encode(opts.memo ?? "")),
      ),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  return tx;
}

/** Withdraw all unlocked-but-unwithdrawn funds to the recipient (recipient only). */
export function buildWithdrawTx(streamId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("withdraw"),
    typeArguments: [MTPS_COIN_TYPE],
    arguments: [tx.object(streamId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });
  return tx;
}

/** Cancel the stream: recipient keeps what it earned, the rest refunds to the sender (sender only). */
export function buildCancelStreamTx(streamId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("cancel_stream"),
    typeArguments: [MTPS_COIN_TYPE],
    arguments: [tx.object(streamId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });
  return tx;
}

/**
 * Add funds and extend the stream (sender only). Pass `addedDurationMs` and an `addedAmount` that
 * keeps the rate at least constant (the contract rejects a top-up that would lower the unlock curve).
 */
export function buildTopUpTx(opts: {
  streamId: string;
  fundsCoinId: string;
  addedAmount: bigint;
  addedDurationMs: bigint;
}): Transaction {
  const tx = new Transaction();
  const [funds] = tx.splitCoins(tx.object(opts.fundsCoinId), [
    tx.pure.u64(opts.addedAmount),
  ]);
  tx.moveCall({
    target: target("top_up"),
    typeArguments: [MTPS_COIN_TYPE],
    arguments: [
      tx.object(opts.streamId),
      funds,
      tx.pure.u64(opts.addedDurationMs),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

// ============================================
// READS
// ============================================

/** Parsed on-chain `PaymentStream` state. */
export interface StreamFields {
  id: string;
  sender: string;
  recipient: string;
  totalAmount: bigint;
  withdrawnAmount: bigint;
  escrowBalance: bigint;
  startMs: bigint;
  endMs: bigint;
  status: number;
}

/** Minimal client surface, satisfied by dapp-kit's SuiClient. */
export interface StreamReader {
  getObject(input: {
    id: string;
    options?: { showContent?: boolean };
  }): Promise<{ data?: { content?: unknown } | null }>;
  getTransactionBlock(input: {
    digest: string;
    options?: { showObjectChanges?: boolean };
  }): Promise<{ objectChanges?: unknown[] }>;
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

/** Read and parse a shared `PaymentStream`; null if missing or not yet indexed. */
export async function fetchStream(
  client: StreamReader,
  id: string,
): Promise<StreamFields | null> {
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
    sender: String(f.sender),
    recipient: String(f.recipient),
    totalAmount: parseU64ish(f.total_amount),
    withdrawnAmount: parseU64ish(f.withdrawn_amount),
    escrowBalance: parseU64ish(f.funds),
    startMs: parseU64ish(f.start_time_ms),
    endMs: parseU64ish(f.end_time_ms),
    status: Number(f.status),
  };
}

/**
 * Poll `fetchStream` until `predicate` passes — fullnode/indexer often lags right after a write.
 */
export async function fetchStreamAfterMutation(
  client: StreamReader,
  id: string,
  predicate: (fields: StreamFields) => boolean,
  opts?: { attempts?: number; delayMs?: number },
): Promise<StreamFields | null> {
  const attempts = opts?.attempts ?? 10;
  const delayMs = opts?.delayMs ?? 600;

  for (let i = 0; i < attempts; i++) {
    const fresh = await fetchStream(client, id);
    if (fresh && predicate(fresh)) return fresh;
    await new Promise((r) => setTimeout(r, delayMs));
  }

  return fetchStream(client, id);
}

/** Find the `PaymentStream` created by a `buildCreateStreamTx` execution (polls past indexer lag). */
export async function findCreatedStreamId(
  client: StreamReader,
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
          ch.objectType.includes(`::${MODULE}::PaymentStream`) &&
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
// OFF-CHAIN UNLOCK MATH (mirrors the Move exactly)
// ============================================

const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** Amount unlocked at `nowMs`: 0 before start, linear in between, full at/after end. */
export function computeUnlocked(s: StreamFields, nowMs: bigint): bigint {
  if (nowMs <= s.startMs) return 0n;
  if (nowMs >= s.endMs) return s.totalAmount;
  const elapsed = nowMs - s.startMs;
  const duration = s.endMs - s.startMs;
  return (s.totalAmount * elapsed) / duration;
}

/** Unlocked-but-not-withdrawn — what the recipient can withdraw right now. */
export function computeAvailable(s: StreamFields, nowMs: bigint): bigint {
  const unlocked = computeUnlocked(s, nowMs);
  return unlocked > s.withdrawnAmount ? unlocked - s.withdrawnAmount : 0n;
}

/** Still-locked remainder (not yet unlocked). */
export function computeLocked(s: StreamFields, nowMs: bigint): bigint {
  const unlocked = computeUnlocked(s, nowMs);
  return s.totalAmount > unlocked ? s.totalAmount - unlocked : 0n;
}

/** Per-second unlock rate (base units), derived from total / duration. */
export function ratePerSecond(s: StreamFields): bigint {
  const durationMs = s.endMs > s.startMs ? s.endMs - s.startMs : 1n;
  return (s.totalAmount * 1000n) / durationMs;
}

/** Helper for a constant-rate top-up amount over `addedMs` (keeps the unlock curve from dropping). */
export function topUpAmountFor(s: StreamFields, addedMs: bigint): bigint {
  const durationMs = s.endMs > s.startMs ? s.endMs - s.startMs : 1n;
  // ceil(total * addedMs / duration) so the new rate is >= the old (contract requires it).
  return (s.totalAmount * addedMs + durationMs - 1n) / durationMs;
}

export { minBig };
