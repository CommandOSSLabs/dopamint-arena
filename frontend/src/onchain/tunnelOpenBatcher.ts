// Connect-time coalescing coordinator (ADR-0019). Every self-play window funds its tunnel through
// ONE shared batcher: requests issued in the same connect tick are debounced into a single flush,
// the summed stake is funded once, and one `openAndFundMany` PTB opens them all — so the gas
// sponsor sees ~2 calls per connect instead of one per window. A batch of size 1 is exactly the
// old per-window open. Created tunnels are correlated back to requesters by party-A address.
import {
  openAndFundMany,
  openAndFundSeatAMany,
  openAndFundSelfPlay,
  openAndFundSharedTunnel,
  normalizeSuiAddress,
  BatchCommittedError,
  type PartyOnchain,
  type SignExec,
  type SuiReads,
  type TunnelOpenManySpec,
  type TunnelOpenSeatASpec,
} from "./tunnelTx";
import { withSponsorFallback } from "./sponsor";
import { MTPS_COIN_TYPE, isMtpsAddressBalance, isMtpsConfigured } from "./mtps";

export interface TunnelOpenRequest {
  partyA: PartyOnchain;
  partyB: PartyOnchain;
  aAmount: bigint;
  bAmount: bigint;
  /** How many seats this opener funds. `"both"` (default) is self-play — one wallet funds both
   *  seats (ADR-0019). `"seatA"` is the genuine-two-party arena (ADR-0023) — the user funds only
   *  seat A and the counterparty fleet bot deposits seat B itself; `bAmount` is ignored. */
  fundMode?: "both" | "seatA";
  /** Coin type `T` for the tunnel; defaults per env (MTPS when configured, else SUI). */
  coinType?: string;
  /** ADR-0013: fund the stake from the player's address balance when the env supports it. */
  usesAddressBalance?: boolean;
  timeoutMs?: bigint;
  penaltyAmount?: bigint;
}

/** Wallet-bound capabilities the batcher needs at flush time (latest values, read lazily). */
export interface BatcherDeps {
  reads: SuiReads;
  sponsoredSignExec: SignExec;
  signExec: SignExec;
  ensureStakeBalance: (need: bigint) => Promise<void>;
  prepareStake: (need: bigint) => Promise<string>;
  selectStakeCoin: (need: bigint) => Promise<string>;
}

/** Default PTB batch size. ~7 catalog games fit in one PTB; this caps a pathological flood under
 *  the PTB command/argument ceiling. Larger flushes chunk into ceil(N / MAX_BATCH) PTBs. */
const DEFAULT_MAX_BATCH = 16;
const DEFAULT_FLUSH_DELAY_MS = 30;

type FundingMode = "balance" | "mtps-coin" | "sui";

interface Pending {
  req: TunnelOpenRequest;
  resolve: (tunnelId: string) => void;
  reject: (err: unknown) => void;
}

function fundingModeOf(req: TunnelOpenRequest): FundingMode {
  if (!isMtpsConfigured) return "sui";
  if (req.usesAddressBalance && isMtpsAddressBalance) return "balance";
  return "mtps-coin";
}

function coinTypeOf(req: TunnelOpenRequest): string | undefined {
  if (req.coinType) return req.coinType;
  return isMtpsConfigured ? MTPS_COIN_TYPE : undefined;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

const specOf = (req: TunnelOpenRequest): TunnelOpenManySpec => ({
  partyA: req.partyA,
  partyB: req.partyB,
  aAmount: req.aAmount,
  bAmount: req.bAmount,
  timeoutMs: req.timeoutMs,
  penaltyAmount: req.penaltyAmount,
});

const seatASpecOf = (req: TunnelOpenRequest): TunnelOpenSeatASpec => ({
  partyA: req.partyA,
  partyB: req.partyB,
  aAmount: req.aAmount,
  timeoutMs: req.timeoutMs,
  penaltyAmount: req.penaltyAmount,
});

/** The stake this opener funds: seat A only in arena (`seatA`) mode, both seats in self-play. */
const stakeTotalOf = (req: TunnelOpenRequest): bigint =>
  req.fundMode === "seatA" ? req.aAmount : req.aAmount + req.bAmount;

export class TunnelOpenBatcher {
  private queue: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxBatch: number;
  private readonly flushDelayMs: number;

  constructor(
    private readonly getDeps: () => BatcherDeps | null,
    opts?: { maxBatch?: number; flushDelayMs?: number },
  ) {
    this.maxBatch = opts?.maxBatch ?? DEFAULT_MAX_BATCH;
    this.flushDelayMs = opts?.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
  }

  /** Enroll a tunnel open; resolves with the created tunnel id once the coalesced flush lands. */
  request(req: TunnelOpenRequest): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ req, resolve, reject });
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushDelayMs);
  }

  private async flush(): Promise<void> {
    const batch = this.queue;
    this.queue = [];
    if (batch.length === 0) return;

    const deps = this.getDeps();
    if (!deps) {
      const err = new Error("no wallet connected — cannot open tunnels");
      for (const p of batch) p.reject(err);
      return;
    }

    // Group by funding mode + coin type: each group needs its own stake source, so it is its own
    // PTB stream. In practice the arena runs one mode, so this is usually a single group.
    const groups = new Map<string, Pending[]>();
    for (const p of batch) {
      // Fund mode joins the key: a seat-A (arena) open and a both-seats (self-play) open build
      // different PTBs and sum stakes differently, so they must not share one chunk.
      const key = `${p.req.fundMode ?? "both"}:${fundingModeOf(p.req)}:${coinTypeOf(p.req) ?? "SUI"}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
    }

    await Promise.all(
      [...groups.values()].map((group) => this.flushGroup(group, deps)),
    );
  }

  private async flushGroup(group: Pending[], deps: BatcherDeps): Promise<void> {
    const mode = fundingModeOf(group[0].req);
    const coinType = coinTypeOf(group[0].req);
    const groupTotal = group.reduce((sum, p) => sum + stakeTotalOf(p.req), 0n);

    // Address-balance mode: top up ONCE for the whole group; each chunk's PTB withdraws its share.
    if (mode === "balance") {
      try {
        await deps.ensureStakeBalance(groupTotal);
      } catch (err) {
        for (const p of group) p.reject(err);
        return;
      }
    }

    const chunks = chunk(group, this.maxBatch);
    if (chunks.length > 1) {
      console.info(
        `[tunnelOpenBatcher] ${group.length} opens > maxBatch ${this.maxBatch} → ${chunks.length} PTBs`,
      );
    }
    await Promise.all(
      chunks.map((c) => this.flushChunk(c, deps, mode, coinType)),
    );
  }

  private async flushChunk(
    chunkPending: Pending[],
    deps: BatcherDeps,
    mode: FundingMode,
    coinType: string | undefined,
  ): Promise<void> {
    const seatA = chunkPending[0].req.fundMode === "seatA";
    const chunkTotal = chunkPending.reduce(
      (s, p) => s + stakeTotalOf(p.req),
      0n,
    );
    try {
      const map = seatA
        ? await this.openSeatAChunk(
            deps,
            mode,
            coinType,
            chunkPending.map((p) => seatASpecOf(p.req)),
            chunkTotal,
          )
        : await this.openChunk(
            deps,
            mode,
            coinType,
            chunkPending.map((p) => specOf(p.req)),
            chunkTotal,
          );
      for (const p of chunkPending) {
        const id = map.get(normalizeSuiAddress(p.req.partyA.address));
        if (id) p.resolve(id);
        else
          p.reject(
            new Error(`no tunnel matched party-A ${p.req.partyA.address}`),
          );
      }
    } catch (batchErr) {
      // POST-COMMIT failure: the batch PTB already landed on-chain — tunnels exist and stake is
      // consumed. Retrying via single opens would double-open and double-consume stake. Reject all
      // pending requests immediately without any fallback.
      if (batchErr instanceof BatchCommittedError) {
        for (const p of chunkPending) p.reject(batchErr);
        return;
      }
      // PRE-COMMIT failure: atomic PTB rejected before landing (one bad spec aborts the chunk).
      // Fall back to per-request single opens so one failure can't strand its siblings.
      console.warn(
        `[tunnelOpenBatcher] batched open failed (${(batchErr as Error)?.message}); ` +
          `falling back to ${chunkPending.length} single opens`,
      );
      await Promise.all(
        chunkPending.map(async (p) => {
          try {
            const id = seatA
              ? await this.openSeatASingle(deps, mode, coinType, p.req)
              : await this.openSingle(deps, mode, coinType, p.req);
            p.resolve(id);
          } catch (singleErr) {
            p.reject(singleErr);
          }
        }),
      );
    }
  }

  private async openChunk(
    deps: BatcherDeps,
    mode: FundingMode,
    coinType: string | undefined,
    specs: TunnelOpenManySpec[],
    total: bigint,
  ): Promise<Map<string, string>> {
    if (mode === "balance") {
      return openAndFundMany({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec,
        specs,
        coinType,
        stakeFromBalance: {
          amount: total,
          coinType: coinType ?? MTPS_COIN_TYPE,
        },
      });
    }
    if (mode === "mtps-coin") {
      return deps.prepareStake(total).then((stakeCoinId) =>
        openAndFundMany({
          reads: deps.reads,
          signExec: deps.sponsoredSignExec,
          specs,
          coinType,
          stakeCoinId,
        }),
      );
    }
    // SUI: sponsored open off a user coin, falling back to a wallet-signed gas-funded open.
    // We inline the sponsor fallback here (rather than delegating to withSponsorFallback) so that
    // BatchCommittedError can propagate immediately — if the sponsored PTB already committed,
    // retrying via sender-pays would double-open and double-consume stake.
    let sponsorErr: unknown;
    try {
      return await openAndFundMany({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec,
        specs,
        coinType,
        stakeCoinId: await deps.selectStakeCoin(total),
      });
    } catch (err) {
      if (err instanceof BatchCommittedError) throw err; // committed: never retry
      sponsorErr = err;
    }
    console.warn(
      `[sponsor] batched open/fund: sponsor failed, falling back to sender-pays`,
      sponsorErr,
    );
    try {
      return await openAndFundMany({
        reads: deps.reads,
        signExec: deps.signExec,
        specs,
        coinType,
      });
    } catch (payErr) {
      if (payErr instanceof BatchCommittedError) throw payErr; // committed: never retry
      throw new Error(
        `batched open/fund: sponsored path failed [${String((sponsorErr as Error)?.message ?? sponsorErr)}]; sender-pays fallback failed [${String((payErr as Error)?.message ?? payErr)}]`,
      );
    }
  }

  /** Seat-A (arena) analog of {@link openChunk}: one PTB opening N tunnels funding only seat A
   *  (the fleet bot funds seat B), correlated by party-A. Same sponsor → sender-pays fallback. */
  private async openSeatAChunk(
    deps: BatcherDeps,
    mode: FundingMode,
    coinType: string | undefined,
    specs: TunnelOpenSeatASpec[],
    total: bigint,
  ): Promise<Map<string, string>> {
    if (mode === "balance") {
      return openAndFundSeatAMany({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec,
        specs,
        coinType,
        stakeFromBalance: {
          amount: total,
          coinType: coinType ?? MTPS_COIN_TYPE,
        },
      });
    }
    if (mode === "mtps-coin") {
      const stakeCoinId = await deps.prepareStake(total);
      return openAndFundSeatAMany({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec,
        specs,
        coinType,
        stakeCoinId,
      });
    }
    // SUI: sponsored open off a user coin, else wallet-signed gas-funded. BatchCommittedError
    // propagates immediately — a committed PTB must never retry (double-open).
    let sponsorErr: unknown;
    try {
      return await openAndFundSeatAMany({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec,
        specs,
        coinType,
        stakeCoinId: await deps.selectStakeCoin(total),
      });
    } catch (err) {
      if (err instanceof BatchCommittedError) throw err;
      sponsorErr = err;
    }
    console.warn(
      `[sponsor] seat-A batched open: sponsor failed, falling back to sender-pays`,
      sponsorErr,
    );
    try {
      return await openAndFundSeatAMany({
        reads: deps.reads,
        signExec: deps.signExec,
        specs,
        coinType,
      });
    } catch (payErr) {
      if (payErr instanceof BatchCommittedError) throw payErr;
      throw new Error(
        `seat-A batched open: sponsored path failed [${String((sponsorErr as Error)?.message ?? sponsorErr)}]; sender-pays fallback failed [${String((payErr as Error)?.message ?? payErr)}]`,
      );
    }
  }

  /** Pre-commit fallback for one seat-A request: a single `openAndFundSharedTunnel`. */
  private async openSeatASingle(
    deps: BatcherDeps,
    mode: FundingMode,
    coinType: string | undefined,
    req: TunnelOpenRequest,
  ): Promise<string> {
    const total = req.aAmount;
    if (mode === "balance") {
      return openAndFundSharedTunnel({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec,
        partyA: req.partyA,
        partyB: req.partyB,
        amount: total,
        coinType,
        stakeFromBalance: {
          amount: total,
          coinType: coinType ?? MTPS_COIN_TYPE,
        },
      });
    }
    if (mode === "mtps-coin") {
      return openAndFundSharedTunnel({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec,
        partyA: req.partyA,
        partyB: req.partyB,
        amount: total,
        coinType,
        stakeCoinId: await deps.prepareStake(total),
      });
    }
    return withSponsorFallback(
      async () =>
        openAndFundSharedTunnel({
          reads: deps.reads,
          signExec: deps.sponsoredSignExec,
          partyA: req.partyA,
          partyB: req.partyB,
          amount: total,
          coinType,
          stakeCoinId: await deps.selectStakeCoin(total),
        }),
      () =>
        openAndFundSharedTunnel({
          reads: deps.reads,
          signExec: deps.signExec,
          partyA: req.partyA,
          partyB: req.partyB,
          amount: total,
          coinType,
        }),
      "single seat-A open/fund fallback",
    );
  }

  private async openSingle(
    deps: BatcherDeps,
    mode: FundingMode,
    coinType: string | undefined,
    req: TunnelOpenRequest,
  ): Promise<string> {
    const total = req.aAmount + req.bAmount;
    if (mode === "balance") {
      return openAndFundSelfPlay({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec as never,
        partyA: req.partyA,
        partyB: req.partyB,
        aAmount: req.aAmount,
        bAmount: req.bAmount,
        coinType,
        stakeFromBalance: {
          amount: total,
          coinType: coinType ?? MTPS_COIN_TYPE,
        },
      });
    }
    if (mode === "mtps-coin") {
      return openAndFundSelfPlay({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec as never,
        partyA: req.partyA,
        partyB: req.partyB,
        aAmount: req.aAmount,
        bAmount: req.bAmount,
        coinType,
        stakeCoinId: await deps.prepareStake(total),
      });
    }
    return withSponsorFallback(
      async () =>
        openAndFundSelfPlay({
          reads: deps.reads,
          signExec: deps.sponsoredSignExec as never,
          partyA: req.partyA,
          partyB: req.partyB,
          aAmount: req.aAmount,
          bAmount: req.bAmount,
          stakeCoinId: await deps.selectStakeCoin(total),
        }),
      () =>
        openAndFundSelfPlay({
          reads: deps.reads,
          signExec: deps.signExec as never,
          partyA: req.partyA,
          partyB: req.partyB,
          aAmount: req.aAmount,
          bAmount: req.bAmount,
        }),
      "single open/fund fallback",
    );
  }
}
