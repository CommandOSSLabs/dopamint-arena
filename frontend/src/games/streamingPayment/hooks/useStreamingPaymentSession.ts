/**
 * Streaming Payments session — Variant A self-play first.
 * On-chain: PaymentStream (A creates / tops up / cancels).
 * Off-chain: streaming.v1 co-signed ticks (local B until BOT-SERVER relay).
 */
import { useEffect, useSyncExternalStore } from "react";
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";

import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "@/backend/controlPlane";
import { registerWindowDisposer } from "@/lib/windowSessions";
import {
  buildCancelStreamTx,
  buildCreateStreamTx,
  buildTopUpTx,
  computeAvailable,
  computeLocked,
  computeUnlocked,
  fetchStream,
  fetchStreamAfterMutation,
  findCreatedStreamId,
  ratePerSecond,
  StreamStatus,
  topUpAmountFor,
  type StreamFields,
  type StreamReader,
} from "@/onchain/streamingPayment";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { useTelemetry } from "@/telemetry/TelemetryProvider";

import {
  isSessionTxPhase,
  type LedgerEntry,
  type Screen,
  type SessionPhase,
  type StreamMeta,
} from "../types";
import {
  AUTO_TICK_INTERVAL_MS,
  DURATIONS,
  FIXED_RECIPIENT,
  FIXED_RECIPIENT_NAME,
  GAME_ID,
  MINIMUM_AMOUNT,
} from "../utils/constants";
import { parseMtps } from "../utils/formatMtps";
import { buildTick, verifyTick } from "../utils/sessionCore";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface SessionDeps {
  report: ReturnType<typeof useTelemetry>["report"];
  account: string | undefined;
  client: StreamReader;
  signExec: ReturnType<typeof useSponsoredSignExec>["signExec"];
  prepareStake: ReturnType<typeof useSponsoredSignExec>["prepareStake"];
}

interface StreamingSnapshot {
  screen: Screen;
  phase: SessionPhase;
  streamId: string | null;
  meta: StreamMeta | null;
  ledger: LedgerEntry[];
  stream: StreamFields | null;
  recipientIdx: number;
  budgetAmount: string;
  durationIdx: number;
  verifiedAccrued: bigint;
  tickCount: number;
  autoMode: boolean;
  vestComplete: boolean;
  error: string | null;
  displayUnlocked: bigint;
  available: bigint;
  locked: bigint;
  fillPct: number;
}

class StreamingPaymentSession {
  deps: SessionDeps | null = null;
  private windowId = "";
  private gen = 0;
  private listeners = new Set<() => void>();

  // Core state
  private screen: Screen = "lobby";
  private phase: SessionPhase = "idle";
  private streamId: string | null = null;
  private meta: StreamMeta | null = null;
  private ledger: LedgerEntry[] = [];
  private stream: StreamFields | null = null;

  // Form (persists across completeRound for UX)
  private budgetAmount = MINIMUM_AMOUNT;
  private durationIdx = 0;

  // Tick / meter (off-chain streaming.v1 co-signs in self-play)
  private verifiedAccrued = 0n;
  private tickCount = 0;
  private lastTick: ReturnType<typeof buildTick> | null = null;
  private autoMode = true;
  private vestComplete = false;

  // UX / control
  private error: string | null = null;

  // Timers
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private vestCheckHandle: ReturnType<typeof setInterval> | null = null;

  // Auto-repeat (when autoMode, keep creating new streams after terminal / on lobby)
  private autoAbort: AbortController | null = null;
  private autoLoopRunning = false;

  // Telemetry / heartbeat (Variant A: streamId as anchor)
  private cpSession: RegisterSessionResult | null = null;
  private actions = 0;
  private lastHeartbeat = Date.now();
  private tpsWindowStart = Date.now();
  private tpsWindowSteps = 0;

  /** Last emitted snapshot. Referential stability for useSyncExternalStore. */
  private snap: StreamingSnapshot = {
    screen: "lobby",
    phase: "idle",
    streamId: null,
    meta: null,
    ledger: [],
    stream: null,
    recipientIdx: 0,
    budgetAmount: this.budgetAmount,
    durationIdx: 0,
    verifiedAccrued: 0n,
    tickCount: 0,
    autoMode: true,
    vestComplete: false,
    error: null,
    displayUnlocked: 0n,
    available: 0n,
    locked: 0n,
    fillPct: 0,
  };

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): StreamingSnapshot => this.snap;

  private emit() {
    const s = this.stream;
    const now = BigInt(Date.now());

    const available = s ? computeAvailable(s, now) : 0n;
    const locked = s ? computeLocked(s, now) : 0n;
    const displayUnlocked = s ? computeUnlocked(s, now) : 0n;
    const total = s && s.totalAmount > 0n ? s.totalAmount : 1n;
    const fillPct = Math.min(
      100,
      total > 0n ? Number((displayUnlocked * 100n) / total) : 0,
    );

    this.snap = {
      screen: this.screen,
      phase: this.phase,
      streamId: this.streamId,
      meta: this.meta,
      ledger: this.ledger,
      stream: this.stream,
      recipientIdx: 0, // fixed recipient phase — no selection
      budgetAmount: this.budgetAmount,
      durationIdx: this.durationIdx,
      verifiedAccrued: this.verifiedAccrued,
      tickCount: this.tickCount,
      autoMode: this.autoMode,
      vestComplete: this.vestComplete,
      error: this.error,
      displayUnlocked,
      available,
      locked,
      fillPct,
    };
    for (const l of this.listeners) l();
  }

  private patch(p: Partial<StreamingSnapshot>) {
    if (p.screen !== undefined) this.screen = p.screen;
    if (p.phase !== undefined) this.phase = p.phase;
    if (p.streamId !== undefined) this.streamId = p.streamId;
    if (p.meta !== undefined) this.meta = p.meta;
    if (p.ledger !== undefined) this.ledger = p.ledger;
    if (p.stream !== undefined) this.stream = p.stream;
    if (p.budgetAmount !== undefined) this.budgetAmount = p.budgetAmount;
    if (p.durationIdx !== undefined) this.durationIdx = p.durationIdx;
    if (p.verifiedAccrued !== undefined)
      this.verifiedAccrued = p.verifiedAccrued;
    if (p.tickCount !== undefined) this.tickCount = p.tickCount;
    if (p.autoMode !== undefined) this.autoMode = p.autoMode;
    if (p.vestComplete !== undefined) this.vestComplete = p.vestComplete;
    if (p.error !== undefined) this.error = p.error;
    this.emit();
  }

  init(windowId: string) {
    if (this.windowId === windowId) return;
    this.windowId = windowId;

    // Re-arm loops if we are mid-stream (e.g. HMR / remount).
    // In the auto showcase the round is ended by the receiver's on-chain withdraw.
    if (
      this.screen === "dashboard" &&
      this.stream?.status === StreamStatus.ACTIVE
    ) {
      if (this.phase === "streaming" && !this.vestComplete) {
        this.startTickLoop();
      }
      this.startVestWatch();
    }
  }

  dispose = () => {
    this.gen += 1;
    this.stopTickLoop();
    this.stopVestWatch();
    this.stopAutoLoop();
    this.flushHeartbeat(true);
    this.abandon();

    this.listeners.clear();
    this.deps?.report.setActive?.(0);
  };

  // ------------------- timers & loops -------------------

  private startTickLoop() {
    this.stopTickLoop();

    this.tickHandle = setInterval(
      () => this.runTickStep(),
      AUTO_TICK_INTERVAL_MS,
    );
  }

  private stopTickLoop() {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  private startVestWatch() {
    this.stopVestWatch();
    if (!this.stream || this.stream.status !== StreamStatus.ACTIVE) return;

    this.vestCheckHandle = setInterval(() => this.checkVestComplete(), 250);
    this.checkVestComplete();
  }

  private stopVestWatch() {
    if (this.vestCheckHandle) {
      clearInterval(this.vestCheckHandle);
      this.vestCheckHandle = null;
    }
  }

  private checkVestComplete() {
    const s = this.stream;
    if (!s || this.vestComplete || s.status !== StreamStatus.ACTIVE) return;
    if (BigInt(Date.now()) < s.endMs) return;
    this.applyVestComplete();
  }

  private applyVestComplete() {
    const s = this.stream;
    if (!s || this.vestComplete || s.status !== StreamStatus.ACTIVE) return;

    this.vestComplete = true;
    this.stopTickLoop();
    this.stopVestWatch();
    this.flushHeartbeat(true);
    this.deps?.report.setActive?.(0);

    const entry: LedgerEntry = {
      kind: "complete",
      amount: s.totalAmount,
      digest: s.id,
      at: Date.now(),
    };

    this.patch({
      phase: "idle",
      vestComplete: true,
      ledger: [...this.ledger, entry],
    });
  }

  // ------------------- auto repeat loop (lobby -> start -> terminal -> repeat) -------------------

  bindAutoLoop = (walletConnected: boolean) => {
    if (walletConnected && this.autoMode) {
      this.startAutoLoop();
    } else {
      this.stopAutoLoop();
    }
  };

  private startAutoLoop() {
    if (this.autoLoopRunning || !this.autoMode) return;
    const ac = new AbortController();
    this.autoAbort = ac;
    this.autoLoopRunning = true;
    void this.runAutoLoop(ac.signal).finally(() => {
      this.autoLoopRunning = false;
      if (this.autoAbort === ac) this.autoAbort = null;
    });
  }

  private stopAutoLoop() {
    this.autoAbort?.abort();
    this.autoAbort = null;
  }

  private async runAutoLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.autoMode && this.deps?.account) {
      // If we're sitting in lobby (or just arrived via newStream), auto kick a new stream
      if (this.screen === "lobby" && this.phase === "idle") {
        await sleep(400);

        if (signal.aborted || !this.autoMode || !this.deps?.account) break;

        this.startStream();
      }

      // Wait for an active streaming session to be live
      await this.waitForState(
        signal,
        () =>
          this.screen === "dashboard" &&
          this.phase === "streaming" &&
          !!this.stream &&
          this.stream.status === StreamStatus.ACTIVE,
        45_000,
      );

      if (signal.aborted || !this.autoMode) break;

      // Vest complete (clock) or on-chain terminal (cancel).
      const roundEnded = await this.waitForState(
        signal,
        () =>
          this.vestComplete ||
          (!!this.stream && this.stream.status === StreamStatus.CANCELLED),
        300_000,
      );
      if (!roundEnded || signal.aborted || !this.autoMode) break;

      const lobbyReady = await this.waitForState(
        signal,
        () => this.screen === "lobby",
        60_000,
      );
      if (!lobbyReady || signal.aborted || !this.autoMode) break;

      await sleep(400);
    }
  }

  private async waitForState(
    signal: AbortSignal,
    predicate: () => boolean,
    timeoutMs = 180_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (signal.aborted || !this.autoMode) return false;
      if (Date.now() > deadline) return false;
      await sleep(80);
    }
    return true;
  }

  private runTickStep() {
    const deps = this.deps;
    const s = this.stream;
    if (!s || s.status !== StreamStatus.ACTIVE || !this.streamId) return;

    const nowMs = BigInt(Date.now());

    // No more ticks after full vest (verify would reject anyway).
    if (nowMs > s.endMs) {
      this.stopTickLoop();
      return;
    }

    const nextNonce = (this.lastTick?.tickNonce ?? -1) + 1;
    const proposed = buildTick(s, nextNonce, nowMs);
    const err = verifyTick(s, proposed, this.lastTick);
    if (err) return; // skip; time will advance or chain state drifted

    // Self-play: local verification acts as B's co-sign for this tick.
    // (In target: relay forwards proposal, real B verifies + returns co-sig.)
    this.lastTick = proposed;
    this.verifiedAccrued = proposed.accruedUnlocked;
    this.tickCount = proposed.tickNonce + 1;
    this.actions += 1;

    // Count 1 verified co-sign tick = 1 action for TPS/heartbeat
    deps?.report.bumpCounters?.({
      updates: 1,
      signatures: 2,
      verifications: 1,
    });
    this.bumpTps(1);
    this.flushHeartbeat(false);

    // // Live UI update (displayUnlocked etc recomputed in emit)
    // this.patch({});
  }

  private bumpTps(steps: number) {
    this.tpsWindowSteps += steps;
    const now = Date.now();
    const elapsed = now - this.tpsWindowStart;
    if (elapsed >= 1000) {
      this.tpsWindowStart = now;
      this.tpsWindowSteps = 0;
    }
  }

  private flushHeartbeat(force: boolean) {
    const s = this.cpSession;
    if (!s || this.actions === 0 || !this.streamId) return;
    const now = Date.now();
    const windowMs = now - this.lastHeartbeat;
    if (!force && windowMs < 1000) return;

    const actionsDelta = this.actions;
    this.actions = 0;
    this.lastHeartbeat = now;

    this.deps?.report.recordActions?.(actionsDelta);

    getControlPlaneClient()
      .sendHeartbeat(s.sessionId, s.statsToken, {
        tunnelId: this.streamId, // anchor until BE adds dedicated streaming ref
        nonce: String(this.tickCount),
        actionsDelta,
        windowMs: Math.max(1, windowMs),
      })
      .catch((e) => console.error("[streaming-payment] heartbeat failed:", e));
  }

  private async ensureCpSession() {
    const deps = this.deps;
    if (!deps?.account || !this.streamId || this.cpSession) return;
    const a = deps.account;
    const b = this.meta?.recipientAddress ?? FIXED_RECIPIENT;
    try {
      const res = await getControlPlaneClient().registerSession({
        userAddress: a,
        game: GAME_ID,
        tunnels: [{ tunnelId: this.streamId, partyA: a, partyB: b }],
      });
      this.cpSession = res;
    } catch (e) {
      console.error("[streaming-payment] registerSession failed:", e);
    }
  }

  // ------------------- actions -------------------

  setBudgetAmount = (v: string) => {
    this.budgetAmount = v;
    this.emit();
  };

  setDurationIdx = (idx: number) => {
    const clamped = Math.max(0, Math.min(idx, DURATIONS.length - 1));
    this.durationIdx = clamped;
    this.emit();
  };

  toggleAutoMode = () => {
    const next = !this.autoMode;

    this.patch({
      autoMode: next,
    });

    if (next) {
      this.startAutoLoop();
    } else {
      this.stopAutoLoop();
    }
  };

  startStream = async () => {
    const deps = this.deps;
    if (!deps?.account || !deps.signExec || !deps.prepareStake) return;
    if (isSessionTxPhase(this.phase)) return;

    const total = parseMtps(this.budgetAmount);
    if (total <= 0n) {
      this.patch({ error: "Enter a positive amount to stream." });
      return;
    }

    // Self-play receiver: generate local keypair so it can later on-chain withdraw.
    // (This makes the on-chain recipient controllable by our local B for the demo.
    // The "fixed address" was previous phase; for real withdraw in showcase we must use B's addr.)
    const b = createParticipant("streaming-receiver");
    const bAddress = b.address;

    const dur = DURATIONS[this.durationIdx].ms;
    const recipient = bAddress;
    const recipientName = FIXED_RECIPIENT_NAME;

    this.gen += 1;
    const myGen = this.gen;

    this.patch({
      phase: "creating",
      error: null,
    });

    try {
      // Get an MTPS coin (or address-balance funded) with >= total
      const fundsCoinId = await deps.prepareStake(total);

      const tx = buildCreateStreamTx({
        fundsCoinId,
        totalAmount: total,
        recipient,
        durationMs: dur,
        memo: "Dopamint arena stream",
      });

      const res = await deps.signExec(tx);
      const digest = res.digest;
      if (this.gen !== myGen) return;

      const sid = await findCreatedStreamId(deps.client, digest);
      if (!sid) {
        throw new Error(
          "Stream created but not indexed yet. Retry in a moment.",
        );
      }

      const initial = await fetchStream(deps.client, sid);
      if (!initial) throw new Error("Failed to load created stream fields.");

      const entry: LedgerEntry = {
        kind: "create",
        amount: total,
        digest,
        at: Date.now(),
      };

      // Telemetry (non-blocking)
      this.ensureCpSession();
      deps.report.bumpCounters?.({ tunnelsOpened: 1 });
      deps.report.setActive?.(1);

      this.patch({
        screen: "dashboard",
        phase: "streaming",
        streamId: sid,
        meta: { recipientName, recipientAddress: recipient },
        ledger: [entry],
        stream: initial,
        verifiedAccrued: 0n,
        tickCount: 0,
        vestComplete: false,
        error: null,
      });

      this.vestComplete = false;
      this.startTickLoop();
      this.startVestWatch();
    } catch (e: any) {
      if (this.gen !== myGen) return;
      this.streamId = null;
      this.stream = null;
      this.patch({
        phase: "idle",
        screen: "lobby",
        error: String(e?.message ?? e),
      });
    }
  };

  topUp = async () => {
    const deps = this.deps;
    const s = this.stream;
    if (!deps?.signExec || !deps.prepareStake || !this.streamId || !s) return;
    if (isSessionTxPhase(this.phase) || s.status !== StreamStatus.ACTIVE)
      return;

    const durationMs = DURATIONS[this.durationIdx].ms;

    const added = topUpAmountFor(s, durationMs);
    if (added <= 0n) return;

    this.patch({ phase: "toppingUp" });
    this.gen += 1;
    const myGen = this.gen;

    try {
      const fundsCoinId = await deps.prepareStake(added);

      const tx = buildTopUpTx({
        streamId: this.streamId,
        fundsCoinId,
        addedAmount: added,
        addedDurationMs: durationMs,
      });

      const res = await deps.signExec(tx);
      const digest = res.digest;
      if (this.gen !== myGen) return;

      const entry: LedgerEntry = {
        kind: "topup",
        amount: added,
        digest,
        at: Date.now(),
      };
      this.ledger = [...this.ledger, entry];

      const before = s;
      const fresh = await fetchStreamAfterMutation(
        deps.client,
        this.streamId,
        (f) => f.totalAmount > before.totalAmount || f.endMs > before.endMs,
      );
      if (fresh) {
        this.stream = fresh;
        this.lastTick = null;
      }

      this.patch({
        phase: "streaming",
        ledger: this.ledger,
        stream: this.stream,
      });
    } catch (e: any) {
      if (this.gen !== myGen) return;

      this.patch({
        phase: "streaming",
        error: String(e?.message ?? e),
      });
    }
  };

  cancelStream = async () => {
    const deps = this.deps;

    if (!deps?.signExec || !this.streamId || isSessionTxPhase(this.phase))
      return;

    this.patch({
      phase: "cancelling",
    });

    this.gen += 1;
    const myGen = this.gen;

    try {
      const tx = buildCancelStreamTx(this.streamId);
      const res = await deps.signExec(tx);
      const digest = res.digest;
      if (this.gen !== myGen) return;

      const entry: LedgerEntry = {
        kind: "cancel",
        digest,
        at: Date.now(),
      };

      this.flushHeartbeat(true);
      this.stopTickLoop();
      this.stopVestWatch();

      const fresh = await fetchStreamAfterMutation(
        deps.client,
        this.streamId,
        (f) => f.status === StreamStatus.CANCELLED,
      );
      if (fresh) this.stream = fresh;

      this.patch({
        phase: "idle",
        ledger: [...this.ledger, entry],
        stream: this.stream,
      });
      this.deps?.report.setActive?.(0);
    } catch (e: any) {
      this.patch({ phase: "streaming", error: String(e?.message ?? e) });
    }
  };

  /** Dashboard terminal banner → lobby; keeps autoMode for the next round. */
  completeRound = () => {
    if (this.screen === "lobby" && !this.streamId) return;

    this.gen += 1;
    this.stopTickLoop();
    this.stopVestWatch();
    this.flushHeartbeat(true);
    this.abandon();

    this.patch({
      screen: "lobby",
      phase: "idle",
      streamId: null,
      meta: null,
      ledger: [],
      stream: null,
      verifiedAccrued: 0n,
      tickCount: 0,
      vestComplete: false,
      error: null,
    });
  };

  newStream = () => {
    this.completeRound();
  };

  private abandon() {
    this.streamId = null;
    this.meta = null;
    this.ledger = [];
    this.stream = null;
    this.verifiedAccrued = 0n;
    this.lastTick = null;
    this.tickCount = 0;
    this.vestComplete = false;
    this.actions = 0;
    this.cpSession = null;
    this.tpsWindowStart = Date.now();
    this.tpsWindowSteps = 0;
    this.error = null;
  }
}

const sessions = new Map<string, StreamingPaymentSession>();

function getSession(windowId: string): StreamingPaymentSession {
  let session = sessions.get(windowId);
  if (!session) {
    session = new StreamingPaymentSession();
    sessions.set(windowId, session);
    const created = session;
    registerWindowDisposer(windowId, GAME_ID, () => {
      created.dispose();
      sessions.delete(windowId);
    });
  }
  session.init(windowId);
  return session;
}

export function useStreamingPaymentSession(windowId: string) {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const sponsored = useSponsoredSignExec();

  const session = getSession(windowId);
  session.deps = {
    report,
    account: account?.address,
    client: suiClient as unknown as StreamReader,
    signExec: sponsored.signExec,
    prepareStake: sponsored.prepareStake,
  };

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);

  const walletConnected = Boolean(account?.address) && sponsored.ready;

  // Drive the auto-repeat loop after deps + wallet are ready (see init() comment).
  useEffect(() => {
    session.bindAutoLoop(walletConnected);
    return () => session.bindAutoLoop(false);
  }, [walletConnected, snap.autoMode]);

  // Live derived values (not stored in snap to avoid duplication)
  const formRate = (() => {
    const tot = parseMtps(snap.budgetAmount || "0");
    const d = DURATIONS[snap.durationIdx];
    return d.ms > 0n ? (tot * 1000n) / d.ms : 0n;
  })();

  const ratePerSecondVal = snap.stream ? ratePerSecond(snap.stream) : 0n;
  const recipientName = snap.meta?.recipientName ?? FIXED_RECIPIENT_NAME;
  const recipientAddress = snap.meta?.recipientAddress ?? FIXED_RECIPIENT;
  const busy =
    snap.phase === "creating" ||
    snap.phase === "toppingUp" ||
    snap.phase === "cancelling";

  return {
    ...snap,
    walletConnected,
    formRate,
    ratePerSecond: ratePerSecondVal,
    recipientName,
    recipientAddress,
    busy,

    // form controls
    setBudgetAmount: session.setBudgetAmount,
    setDurationIdx: session.setDurationIdx,

    // actions
    startStream: session.startStream,
    topUp: session.topUp,
    cancelStream: session.cancelStream,
    completeRound: session.completeRound,
    newStream: session.newStream,
    toggleAutoMode: session.toggleAutoMode,
  };
}
