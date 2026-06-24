/**
 * Watchtower: automated dispute/timeout recovery for abandoned tunnels (Deliverable 4).
 *
 * With thousands of autonomous agents, some counterparties crash or vanish. The on-chain
 * timeout path guarantees the honest party can ALWAYS recover funds — but only if someone
 * drives it. The watchtower monitors tunnels and, on counterparty silence, automatically
 * runs the correct recovery: raise a dispute with the latest co-signed state, wait the
 * timeout, then force-close; or withdraw a never-activated deposit. This is what makes the
 * settlement-success metric (Deliverable 10) achievable at scale.
 *
 * {@link decideRecovery} is pure (fully unit-tested); {@link Watchtower} drives it with
 * injectable liveness fetch + tx submission so it works against any client.
 */

import { TunnelStatus } from "../config";

export type RecoveryAction =
  | "none"
  | "withdraw_timeout"
  | "raise_dispute"
  | "raise_dispute_current_state"
  | "resolve_dispute"
  | "force_close";

export interface TunnelLiveness {
  /** On-chain status (0 CREATED, 1 ACTIVE, 2 CLOSED, 3 DISPUTED, 4 DESTROYED). */
  status: number;
  /** True if THIS party raised the current dispute. */
  iAmDisputeRaiser: boolean;
  /** True if we hold a counterparty-signed state with nonce > the on-chain nonce. */
  hasCounterpartySignedNewerState: boolean;
  createdAtMs: number;
  /** Last successful off-chain exchange with the counterparty. */
  lastActivityMs: number;
  /** Tunnel timeout window (ms). */
  timeoutMs: number;
  nowMs: number;
  /** Whether the counterparty has deposited (relevant while CREATED). */
  counterpartyDeposited: boolean;
  /** Silence threshold (ms) after which the counterparty is presumed crashed. */
  heartbeatTimeoutMs: number;
  /** When the dispute clock started (the on-chain state timestamp), if DISPUTED. */
  disputeStartMs?: number;
}

/**
 * Decide the recovery action for one tunnel. Pure: same inputs → same action.
 * Conservative — only acts when funds are genuinely at risk and recovery is available.
 */
export function decideRecovery(t: TunnelLiveness): RecoveryAction {
  if (t.status === TunnelStatus.CLOSED || t.status >= 4) return "none";

  if (t.status === TunnelStatus.DISPUTED) {
    // If the COUNTERPARTY raised the dispute (possibly with a stale state) and we hold a
    // newer co-signed state, submit it via resolve_dispute to override their state before
    // the timeout lets them force-close on stale balances. This is the honest party's only
    // automated defense against a stale-state dispute.
    if (!t.iAmDisputeRaiser && t.hasCounterpartySignedNewerState) {
      return "resolve_dispute";
    }
    if (
      t.iAmDisputeRaiser &&
      t.disputeStartMs !== undefined &&
      t.nowMs >= t.disputeStartMs + t.timeoutMs
    ) {
      return "force_close";
    }
    return "none"; // wait: we are not the raiser and hold nothing newer, or pre-timeout
  }

  if (t.status === TunnelStatus.CREATED) {
    if (!t.counterpartyDeposited && t.nowMs >= t.createdAtMs + t.timeoutMs) {
      return "withdraw_timeout";
    }
    return "none";
  }

  // ACTIVE: act on counterparty silence
  if (t.nowMs - t.lastActivityMs >= t.heartbeatTimeoutMs) {
    return t.hasCounterpartySignedNewerState
      ? "raise_dispute"
      : "raise_dispute_current_state";
  }
  return "none";
}

/** A monitored tunnel entry. */
export interface WatchedTunnel {
  tunnelId: string;
  /** Fetch the current liveness snapshot (typically from the chain + local state). */
  fetchLiveness: () => Promise<TunnelLiveness> | TunnelLiveness;
}

/** Executes a recovery action for a tunnel (wraps the txbuilders + a client). */
export type RecoveryExecutor = (
  tunnelId: string,
  action: Exclude<RecoveryAction, "none">,
) => Promise<void>;

export interface WatchtowerOptions {
  /** Polling interval (ms). Default 5000. */
  intervalMs?: number;
  /** Called on every action taken (telemetry). */
  onAction?: (tunnelId: string, action: RecoveryAction) => void;
  /** Called on executor errors (does not stop the loop). */
  onError?: (tunnelId: string, err: unknown) => void;
}

/**
 * Drives {@link decideRecovery} over a set of tunnels on an interval, executing recovery
 * actions via the injected executor. Stop with {@link stop}.
 */
export class Watchtower {
  private readonly tunnels = new Map<string, WatchedTunnel>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly execute: RecoveryExecutor,
    private readonly opts: WatchtowerOptions = {},
  ) {}

  watch(t: WatchedTunnel): void {
    this.tunnels.set(t.tunnelId, t);
  }

  unwatch(tunnelId: string): void {
    this.tunnels.delete(tunnelId);
  }

  get size(): number {
    return this.tunnels.size;
  }

  /** Evaluate every watched tunnel once and execute any needed recovery. */
  async tick(): Promise<void> {
    for (const t of this.tunnels.values()) {
      try {
        const liveness = await t.fetchLiveness();
        const action = decideRecovery(liveness);
        this.opts.onAction?.(t.tunnelId, action);
        if (action !== "none") {
          await this.execute(t.tunnelId, action);
          // stop watching once a terminal recovery is submitted
          if (action === "force_close" || action === "withdraw_timeout") {
            this.tunnels.delete(t.tunnelId);
          }
        }
      } catch (err) {
        this.opts.onError?.(t.tunnelId, err);
      }
    }
  }

  /** Start the polling loop. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.tick(),
      this.opts.intervalMs ?? 5000,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
