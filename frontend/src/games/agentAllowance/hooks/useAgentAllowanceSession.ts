/**
 * Agent Allowance session — capped, rate-limited, revocable spending mandate (x402).
 * On-chain: agent_allowance (create / claim / pause / resume / revoke).
 * In-memory only until a resume adapter lands (no localStorage).
 */
import { useEffect, useSyncExternalStore } from "react";
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit";

import { registerWindowDisposer } from "@/lib/windowSessions";
import { MTPS_COIN_TYPE } from "@/onchain/mtps";
import {
  AllowanceStatus,
  buildClaimTx,
  buildCreateAllowanceTx,
  buildPauseTx,
  buildResumeTx,
  buildRevokeTx,
  computeAvailable,
  computeEntitled,
  fetchAllowance,
  fetchAllowanceAfterMutation,
  findCreatedAllowanceId,
  toAccrualState,
  type AllowanceFields,
  type AllowanceReader,
} from "@/onchain/agentAllowance";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";

import {
  isSessionTxPhase,
  type LedgerEntry,
  type MandateMeta,
  type Screen,
  type SessionPhase,
} from "../types";
import {
  CLAIM_SKEW_MS,
  EXPIRY_OPTIONS,
  GAME_ID,
  METER_INTERVAL_MS,
  PROVIDERS,
  parseWholeMtps,
  providerNameFor,
  validateMandateInputs,
} from "../utils";

interface SessionDeps {
  account: string | undefined;
  client: AllowanceReader;
  signExec: ReturnType<typeof useSponsoredSignExec>["signExec"];
  ensureStakeBalance: ReturnType<
    typeof useSponsoredSignExec
  >["ensureStakeBalance"];
}

interface AgentAllowanceSnapshot {
  screen: Screen;
  phase: SessionPhase;
  allowanceId: string | null;
  meta: MandateMeta | null;
  ledger: LedgerEntry[];
  allowance: AllowanceFields | null;
  agentName: string;
  providerIdx: number;
  capInput: string;
  rateInput: string;
  expiryIdx: number;
  nowMs: number;
  error: string | null;
}

class AgentAllowanceSession {
  deps: SessionDeps | null = null;
  private windowId = "";
  private gen = 0;
  private listeners = new Set<() => void>();

  private screen: Screen = "lobby";
  private phase: SessionPhase = "idle";
  private allowanceId: string | null = null;
  private meta: MandateMeta | null = null;
  private ledger: LedgerEntry[] = [];
  private allowance: AllowanceFields | null = null;

  private agentName = "Research Agent";
  private providerIdx = 0;
  private capInput = "100";
  private rateInput = "1";
  private expiryIdx = 0;
  private nowMs = Date.now();
  private error: string | null = null;

  private snap: AgentAllowanceSnapshot = this.buildSnap();

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): AgentAllowanceSnapshot => this.snap;

  init(windowId: string): void {
    this.windowId = windowId;
  }

  dispose(): void {
    this.gen += 1;
  }

  private buildSnap(): AgentAllowanceSnapshot {
    return {
      screen: this.screen,
      phase: this.phase,
      allowanceId: this.allowanceId,
      meta: this.meta,
      ledger: this.ledger,
      allowance: this.allowance,
      agentName: this.agentName,
      providerIdx: this.providerIdx,
      capInput: this.capInput,
      rateInput: this.rateInput,
      expiryIdx: this.expiryIdx,
      nowMs: this.nowMs,
      error: this.error,
    };
  }

  private emit(): void {
    this.snap = this.buildSnap();
    for (const cb of this.listeners) cb();
  }

  private patch(p: Partial<AgentAllowanceSnapshot>): void {
    if (p.screen !== undefined) this.screen = p.screen;
    if (p.phase !== undefined) this.phase = p.phase;
    if (p.allowanceId !== undefined) this.allowanceId = p.allowanceId;
    if (p.meta !== undefined) this.meta = p.meta;
    if (p.ledger !== undefined) this.ledger = p.ledger;
    if (p.allowance !== undefined) this.allowance = p.allowance;
    if (p.agentName !== undefined) this.agentName = p.agentName;
    if (p.providerIdx !== undefined) this.providerIdx = p.providerIdx;
    if (p.capInput !== undefined) this.capInput = p.capInput;
    if (p.rateInput !== undefined) this.rateInput = p.rateInput;
    if (p.expiryIdx !== undefined) this.expiryIdx = p.expiryIdx;
    if (p.nowMs !== undefined) this.nowMs = p.nowMs;
    if (p.error !== undefined) this.error = p.error;
    this.emit();
  }

  applyAllowance = (a: AllowanceFields): void => {
    this.allowance = a;
    if (a.status === AllowanceStatus.REVOKED) {
      this.screen = "lobby";
      this.phase = "idle";
    }
    this.emit();
  };

  /** One-shot chain read — hook for future bot-server WS push → refetch. */
  refreshFromChain = async (): Promise<void> => {
    const deps = this.deps;
    const id = this.allowanceId;
    if (!deps?.client || !id) return;
    const fresh = await fetchAllowance(deps.client, id);
    if (fresh) this.applyAllowance(fresh);
  };

  private reloadAfterMutation(
    predicate: (fields: AllowanceFields) => boolean,
  ): Promise<AllowanceFields | null> {
    const deps = this.deps;
    if (!deps?.client || !this.allowanceId) return Promise.resolve(null);
    return fetchAllowanceAfterMutation(
      deps.client,
      this.allowanceId,
      predicate,
    );
  }

  setNowMs = (ms: number): void => {
    this.nowMs = ms;
    this.emit();
  };

  setAgentName = (v: string) => this.patch({ agentName: v });
  setCapInput = (v: string) => this.patch({ capInput: v });
  setRateInput = (v: string) => this.patch({ rateInput: v });
  setExpiryIdx = (idx: number) =>
    this.patch({
      expiryIdx: Math.max(0, Math.min(idx, EXPIRY_OPTIONS.length - 1)),
    });

  setProviderIdx = (idx: number) => {
    const clamped = Math.max(0, Math.min(idx, PROVIDERS.length - 1));
    this.patch({ providerIdx: clamped });
  };

  deploy = async (): Promise<void> => {
    const deps = this.deps;
    if (!deps?.account || !deps.signExec || !deps.ensureStakeBalance) return;
    if (isSessionTxPhase(this.phase)) return;

    const inputError = validateMandateInputs(this.capInput, this.rateInput);
    if (inputError) {
      this.patch({ error: inputError });
      return;
    }

    const provider = PROVIDERS[this.providerIdx];
    const cap = parseWholeMtps(this.capInput)!;
    const rate = parseWholeMtps(this.rateInput)!;
    const payee = provider.address;
    if (payee.toLowerCase() === deps.account.toLowerCase()) {
      this.patch({ error: "Provider must differ from you (the funder)" });
      return;
    }

    const choice = EXPIRY_OPTIONS[this.expiryIdx];
    const expiryMs = choice.ms === 0n ? 0n : BigInt(Date.now()) + choice.ms;

    this.gen += 1;
    const myGen = this.gen;
    this.patch({ phase: "deploying", error: null });

    try {
      await deps.ensureStakeBalance(cap);
      const tx = buildCreateAllowanceTx({
        stakeFromBalance: { amount: cap, coinType: MTPS_COIN_TYPE },
        fundAmount: cap,
        payee,
        ratePerSecond: rate,
        spendCap: cap,
        expiryMs,
      });
      const { digest } = await deps.signExec(tx);
      if (this.gen !== myGen) return;

      const id = await findCreatedAllowanceId(deps.client, digest);
      if (!id)
        throw new Error("Agent deployed but its mandate id wasn't found yet");

      const loaded = await fetchAllowanceAfterMutation(
        deps.client,
        id,
        (f) => f.status === AllowanceStatus.ACTIVE && f.escrowBalance > 0n,
      );
      if (!loaded) throw new Error("Failed to load created allowance");

      const entry: LedgerEntry = {
        kind: "create",
        digest,
        at: Date.now(),
      };

      this.patch({
        screen: "dashboard",
        phase: "active",
        allowanceId: id,
        meta: {
          agentName: this.agentName.trim() || "Agent",
          providerName: provider.name,
        },
        ledger: [entry],
        allowance: loaded,
        error: null,
      });
    } catch (e) {
      if (this.gen !== myGen) return;
      this.patch({
        phase: "idle",
        error: String((e as Error)?.message ?? e),
      });
    }
  };

  claim = async (): Promise<void> => {
    const deps = this.deps;
    if (!deps?.signExec || !this.allowanceId || !this.allowance) return;
    if (isSessionTxPhase(this.phase)) return;

    const accrual = toAccrualState(this.allowance);
    const amount = computeAvailable(
      accrual,
      this.allowance.spent,
      this.allowance.escrowBalance,
      BigInt(Date.now()) - CLAIM_SKEW_MS,
    );
    if (amount <= 0n) {
      this.patch({ error: "Nothing to pay yet — give it a moment" });
      return;
    }

    this.gen += 1;
    const myGen = this.gen;
    this.patch({ phase: "claiming", error: null });

    try {
      const { digest } = await deps.signExec(
        buildClaimTx(this.allowanceId, amount),
      );
      if (this.gen !== myGen) return;

      const fresh = await this.reloadAfterMutation(
        (f) => f.spent > Number(this.allowance?.spent),
      );
      if (!fresh) throw new Error("Failed to refresh allowance when claim");

      const entry: LedgerEntry = {
        kind: "pull",
        amount,
        digest,
        at: Date.now(),
      };

      this.patch({
        phase: "active",
        error: null,
        ledger: [entry, ...this.ledger],
        allowance: fresh,
      });
    } catch (e) {
      if (this.gen !== myGen) return;
      this.patch({
        phase: "active",
        error: String((e as Error)?.message ?? e),
      });
    }
  };

  pause = async (): Promise<void> => {
    const deps = this.deps;
    if (!deps?.signExec || !this.allowanceId) return;
    if (isSessionTxPhase(this.phase)) return;

    this.gen += 1;
    const myGen = this.gen;

    this.patch({
      phase: "pausing",
      error: null,
    });

    try {
      const { digest } = await deps.signExec(buildPauseTx(this.allowanceId));
      if (this.gen !== myGen) return;

      const fresh = await this.reloadAfterMutation(
        (f) => f.status === AllowanceStatus.PAUSED,
      );
      if (!fresh) throw new Error("Failed to refresh allowance when pause");

      const entry: LedgerEntry = {
        kind: "pause",
        digest,
        at: Date.now(),
      };

      this.patch({
        phase: "active",
        ledger: [entry, ...this.ledger],
        allowance: fresh,
        error: null,
      });
    } catch (e) {
      if (this.gen !== myGen) return;

      this.patch({
        phase: "active",
        error: String((e as Error)?.message ?? e),
      });
    }
  };

  resume = async (): Promise<void> => {
    const deps = this.deps;
    if (!deps?.signExec || !this.allowanceId) return;
    if (isSessionTxPhase(this.phase)) return;

    this.gen += 1;
    const myGen = this.gen;

    this.patch({
      phase: "resuming",
      error: null,
    });

    try {
      const { digest } = await deps.signExec(buildResumeTx(this.allowanceId));
      if (this.gen !== myGen) return;

      const fresh = await this.reloadAfterMutation(
        (f) => f.status === AllowanceStatus.ACTIVE,
      );
      if (!fresh) throw new Error("Failed to refresh allowance when resume");

      const entry: LedgerEntry = {
        kind: "resume",
        digest,
        at: Date.now(),
      };

      this.patch({
        phase: "active",
        ledger: [entry, ...this.ledger],
        allowance: fresh,
        error: null,
      });
    } catch (e) {
      if (this.gen !== myGen) return;

      this.patch({
        phase: "active",
        error: String((e as Error)?.message ?? e),
      });
    }
  };

  revoke = async (): Promise<void> => {
    const deps = this.deps;
    if (!deps?.signExec || !this.allowanceId) return;
    if (isSessionTxPhase(this.phase)) return;

    this.gen += 1;
    const myGen = this.gen;
    this.patch({
      phase: "revoking",
      error: null,
    });

    try {
      await deps.signExec(buildRevokeTx(this.allowanceId));
      if (this.gen !== myGen) return;

      const fresh = await this.reloadAfterMutation(
        (f) => f.status === AllowanceStatus.REVOKED,
      );
      if (!fresh) throw new Error("Failed to refresh allowance when revoke");

      this.patch({
        phase: "idle",
        screen: "lobby",
        allowance: fresh,
        error: null,
      });
    } catch (e) {
      if (this.gen !== myGen) return;

      this.patch({
        phase: "active",
        error: String((e as Error)?.message ?? e),
      });
    }
  };

  reset = (): void => {
    this.gen += 1;
    this.allowanceId = null;
    this.meta = null;
    this.ledger = [];
    this.allowance = null;
    this.patch({
      screen: "lobby",
      phase: "idle",
      allowanceId: null,
      meta: null,
      ledger: [],
      allowance: null,
      error: null,
    });
  };
}

const sessions = new Map<string, AgentAllowanceSession>();

function getSession(windowId: string): AgentAllowanceSession {
  let session = sessions.get(windowId);
  if (!session) {
    session = new AgentAllowanceSession();
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

export function useAgentAllowanceSession(windowId: string) {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const sponsored = useSponsoredSignExec();

  const session = getSession(windowId);
  session.deps = {
    account: account?.address,
    client: suiClient as unknown as AllowanceReader,
    signExec: sponsored.signExec,
    ensureStakeBalance: sponsored.ensureStakeBalance,
  };

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);

  const walletConnected = Boolean(account?.address) && sponsored.ready;

  useEffect(() => {
    if (!snap.allowance || snap.allowance.status !== AllowanceStatus.ACTIVE)
      return;
    const iv = setInterval(
      () => session.setNowMs(Date.now()),
      METER_INTERVAL_MS,
    );
    return () => clearInterval(iv);
  }, [snap.allowance?.status, snap.allowance?.id]);

  const accrual = snap.allowance ? toAccrualState(snap.allowance) : null;
  const now = BigInt(snap.nowMs);
  const entitled = accrual ? computeEntitled(accrual, now) : 0n;

  const available =
    snap.allowance && accrual
      ? computeAvailable(
          accrual,
          snap.allowance.spent,
          snap.allowance.escrowBalance,
          now,
        )
      : 0n;

  const claimable =
    snap.allowance && accrual
      ? computeAvailable(
          accrual,
          snap.allowance.spent,
          snap.allowance.escrowBalance,
          now - CLAIM_SKEW_MS,
        )
      : 0n;

  const providerName =
    snap.meta?.providerName ??
    (snap.allowance
      ? providerNameFor(snap.allowance.payee)
      : PROVIDERS[snap.providerIdx].name);
  const displayAgent = snap.meta?.agentName ?? snap.agentName;

  const expiryLabel = (() => {
    if (!snap.allowance || snap.allowance.expiryMs === 0n) return "no expiry";
    const remMs = Number(snap.allowance.expiryMs - now);
    if (remMs <= 0) return "expired";
    const h = Math.floor(remMs / 3_600_000);
    const m = Math.floor((remMs % 3_600_000) / 60_000);
    return h > 0 ? `expires in ${h}h ${m}m` : `expires in ${m}m`;
  })();

  const fillPct = (() => {
    if (!snap.allowance || snap.allowance.spendCap === 0n) return 0;
    const pct = Number((entitled * 10000n) / snap.allowance.spendCap) / 100;
    return Math.max(0, Math.min(100, pct));
  })();

  const busy = isSessionTxPhase(snap.phase);
  const isRevoked = snap.allowance?.status === AllowanceStatus.REVOKED;
  const isPaused = snap.allowance?.status === AllowanceStatus.PAUSED;

  return {
    ...snap,
    walletConnected,
    busy,
    entitled,
    available,
    claimable,
    fillPct,
    providerName,
    displayAgent,
    expiryLabel,
    isRevoked,
    isPaused,

    setAgentName: session.setAgentName,
    setProviderIdx: session.setProviderIdx,
    setCapInput: session.setCapInput,
    setRateInput: session.setRateInput,
    setExpiryIdx: session.setExpiryIdx,
    deploy: session.deploy,
    claim: session.claim,
    pause: session.pause,
    resume: session.resume,
    revoke: session.revoke,
    reset: session.reset,
    refreshFromChain: session.refreshFromChain,
  };
}
