/**
 * Time-windowed bulk-open job (design §4.1). Workers never sign; they enqueue seat-A open
 * intents through the chain bridge. This main-thread job drains the per-sender queue on a
 * fixed ~5 s tick and is the single place where many game-window opens are meant to collapse
 * into ONE sponsored PTB — the motivation is the Enoki rate limit (one sponsor+execute pair
 * per batch), not wallet popups (sponsored opens are already popup-free).
 *
 * STATUS — structure only, no PTB batching yet. The existing many-opens builder
 * (`openAndFundMany` / `buildOpenAndFundMany`) is the SELF-PLAY `create_and_fund` shape and
 * cannot be reused for the PvP seat-A open: (1) it funds BOTH seats from one sender, whereas a
 * PvP open funds only seat A via `create_and_share` (seat B deposits separately) — reusing it
 * double-consumes the wallet and pre-funds seat B; and (2) it demuxes created tunnels by
 * party-A address, but a PvP open's party-A address IS the wallet (pvpMatchHook), identical
 * across one sender's opens, so per-intent correlation by party-A collapses. The real PvP
 * many-opens builder is new on-chain code (see TODO in {@link BulkOpenJob.openBatch}). Until it
 * lands, this job keeps the queue / per-sender shard / early-flush / demux structure in place
 * behind the `?engine=worker` flag and opens each match with the existing per-match opener, so
 * behaviour is identical to the direct path (it does NOT yet reduce the Enoki sponsor count).
 */
import type { OpenTunnelParams } from "../engineApi";
import { engineEnabled } from "../flag";
import { BatchCommittedError, normalizeSuiAddress } from "@/onchain/tunnelTx";

/** The batching window (design §4.1): a fixed ~5 s tick, not a sub-second debounce — independent
 *  game opens arrive seconds apart, so a short debounce would never coalesce them. */
export const BULK_OPEN_WINDOW_MS = 5000;

/** A lone intent that has waited this short minimum with nothing else arriving flushes early, so
 *  a single match doesn't pay the full {@link BULK_OPEN_WINDOW_MS} to start (design §4.1). */
export const BULK_OPEN_LONE_FLUSH_MS = 300;

export type OpenResult = { tunnelId: string };

/** The actual per-match seat-A open (e.g. `openSharedTunnelStaked` via the chain bridge). The job
 *  wraps this; today it calls it once per intent, later it composes them into one PTB. */
export type PerMatchOpen = (params: OpenTunnelParams) => Promise<OpenResult>;

export interface BulkOpenJobOptions {
  windowMs?: number;
  loneFlushMs?: number;
  /** Flag predicate (injectable for tests); defaults to the `?engine=worker` flag. Off → the job
   *  is a transparent pass-through (immediate per-match open), so non-worker behaviour is unchanged. */
  enabled?: () => boolean;
}

interface PendingOpen {
  params: OpenTunnelParams;
  resolve: (result: OpenResult) => void;
  reject: (err: unknown) => void;
}

/** One sender's accumulating window. A Sui tx has a single `sender` and the sponsor guard forces
 *  every stake withdrawal to `WithdrawFrom::Sender`, so cross-sender batching is rejected — the
 *  job shards by sender and each shard becomes (at most) one PTB. */
interface SenderShard {
  pending: PendingOpen[];
  windowTimer: ReturnType<typeof setTimeout> | null;
  loneTimer: ReturnType<typeof setTimeout> | null;
}

export class BulkOpenJob {
  private readonly shards = new Map<string, SenderShard>();
  private readonly windowMs: number;
  private readonly loneFlushMs: number;
  private readonly enabled: () => boolean;

  constructor(
    private readonly perMatchOpen: PerMatchOpen,
    opts?: BulkOpenJobOptions,
  ) {
    this.windowMs = opts?.windowMs ?? BULK_OPEN_WINDOW_MS;
    this.loneFlushMs = opts?.loneFlushMs ?? BULK_OPEN_LONE_FLUSH_MS;
    this.enabled = opts?.enabled ?? engineEnabled;
  }

  /** Enqueue a seat-A open; resolves with the tunnel id once this sender's window flushes. Off the
   *  worker flag, opens immediately (no window) so the non-worker path is unchanged. */
  enqueue(params: OpenTunnelParams): Promise<OpenResult> {
    if (!this.enabled()) return this.perMatchOpen(params);
    return new Promise<OpenResult>((resolve, reject) => {
      const sender = senderOf(params);
      const shard = this.shardFor(sender);
      shard.pending.push({ params, resolve, reject });
      if (shard.pending.length === 1) {
        // First intent: arm the full window plus a short lone-flush timer.
        shard.windowTimer = setTimeout(() => this.flush(sender), this.windowMs);
        shard.loneTimer = setTimeout(() => {
          // Still lone — nothing else joined the window — so don't make it wait the full tick.
          if (this.shards.get(sender)?.pending.length === 1) this.flush(sender);
        }, this.loneFlushMs);
      } else if (shard.loneTimer) {
        // A real batch is forming: cancel the early flush and let the full window accumulate more.
        clearTimeout(shard.loneTimer);
        shard.loneTimer = null;
      }
    });
  }

  private shardFor(sender: string): SenderShard {
    let shard = this.shards.get(sender);
    if (!shard) {
      shard = { pending: [], windowTimer: null, loneTimer: null };
      this.shards.set(sender, shard);
    }
    return shard;
  }

  /** Detach and open this sender's accumulated window. */
  private flush(sender: string): void {
    const shard = this.shards.get(sender);
    if (!shard || shard.pending.length === 0) return;
    if (shard.windowTimer) clearTimeout(shard.windowTimer);
    if (shard.loneTimer) clearTimeout(shard.loneTimer);
    const batch = shard.pending;
    this.shards.delete(sender);
    void this.openBatch(batch);
  }

  /**
   * Open every intent in one sender's window and demux a tunnel id back to each.
   *
   * TODO(bulk-open PTB, design §4.1): compose these into ONE Programmable Transaction Block —
   * `create` + `deposit_party_a` + `public_share_object` ×N with ONE summed `redeem_funds`
   * withdrawal (NOT N withdrawals), chunked to fit the settler gas cap (~0.1 SUI) and the PTB
   * command/input/128 KB ceilings. That builder is new on-chain code: the existing
   * `openAndFundMany` is the self-play `create_and_fund` shape (funds both seats; demuxes by
   * party-A) and is unsafe here — see the module header. The batched path MUST (a) demux per
   * intent WITHOUT relying on party-A (it's the shared wallet — use objectChanges order or the
   * per-match party-B ephemeral), (b) on a pre-commit reject retry offenders individually, and
   * (c) on a `BatchCommittedError` reject all affected intents and NEVER retry (a post-commit
   * retry double-opens and double-consumes stake).
   *
   * Until then: no batching — open each match with the per-match opener. The per-match opener
   * doesn't throw `BatchCommittedError` today, but the never-retry rule is enforced here at the
   * flush boundary so it already holds when the batched path lands.
   */
  private async openBatch(batch: PendingOpen[]): Promise<void> {
    await Promise.all(
      batch.map(async (p) => {
        try {
          p.resolve(await this.perMatchOpen(p.params));
        } catch (err) {
          if (err instanceof BatchCommittedError) {
            // Surface a committed-but-uncorrelated open distinctly; the tunnel exists and the
            // stake is consumed, so we reject (never retry) — a retry would double-open.
            console.error(
              "[bulkOpenJob] open committed but correlation failed — not retrying",
              err,
            );
          }
          p.reject(err);
        }
      }),
    );
  }
}

/** Shard key: the PTB sender. A PvP seat-A open's party-A address IS the user's wallet
 *  (pvpMatchHook), which signs/sends the open — normalize it so padding differences don't split
 *  one sender into two shards. */
function senderOf(params: OpenTunnelParams): string {
  return normalizeSuiAddress(params.partyA.address);
}
