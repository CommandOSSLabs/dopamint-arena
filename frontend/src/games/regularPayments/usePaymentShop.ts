import { useRef, useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import {
  PaymentsProtocol,
  type PaymentMove,
} from "sui-tunnel-ts/protocol/payments";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { getControlPlaneClient } from "@/backend/controlPlane";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "@/onchain/mtps";
import {
  readCreatedAt,
  type SignExec,
  type SuiReads,
} from "@/onchain/tunnelTx";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import {
  useTelemetry,
  type TelemetryWriter,
} from "@/telemetry/TelemetryProvider";
import {
  DEPOSIT_A_MIST,
  DEPOSIT_B_MIST,
  MAX_CONCURRENT_RUNNING,
  MINT_COOLDOWN_MS,
  MICRO_UNIT_MIST,
  STREAM_DURATION_MS,
  TICK_COUNT,
  mistToSui,
} from "./constants";
import { openPaymentTunnel } from "./openPaymentTunnel";
import { settlePaymentTunnel, type PaymentTunnel } from "./paymentSettle";
import type {
  MachinePhase,
  MachineSessionView,
  MicroPaymentTick,
  NftTier,
} from "./types";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRunningPhase(phase: MachinePhase): boolean {
  return phase === "spawning" || phase === "running" || phase === "settling";
}

/** Co-sign micro-payments in bursts, then yield one frame — keeps card counters smooth. */
const FRAME_BUDGET_MS = 8;

type ShopDeps = {
  report: TelemetryWriter;
  account: { address: string } | null;
  client: unknown;
  signExec: SignExec;
  sponsoredSignExec: SignExec;
  selectStakeCoin: (min: bigint) => Promise<string>;
  prepareStake: (need: bigint) => Promise<string>;
  ensureStakeBalance: (need: bigint) => Promise<void>;
};

function nextTier(id: string, tickCount: number): NftTier {
  const n = (id.charCodeAt(0) + tickCount) % 10;
  if (n >= 8) return "epic";
  if (n >= 5) return "rare";
  return "common";
}

class MachineRuntime {
  readonly id: string;
  readonly label: string;

  phase: MachinePhase = "spawning";
  error: string | null = null;
  tickCount = 0;
  tps = 0;
  tier: NftTier = "unknown";
  history: MicroPaymentTick[] = [];
  private tickTimes: number[] = [];

  private gen = 0;
  private tunnel: PaymentTunnel | null = null;
  private transcript: Transcript | null = null;
  private tunnelId = "";
  private createdAt = 0n;
  private ts = 1n;
  private heartbeatActions = 0;
  private moveCount = 0;
  private lastHeartbeatAt = 0;
  private sessionId: string | null = null;
  private statsToken: string | null = null;
  private pending = { updates: 0, signatures: 0, verifications: 0, bytes: 0 };

  constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
  }

  toView(): MachineSessionView {
    const spentMist = BigInt(this.tickCount) * MICRO_UNIT_MIST;
    return {
      id: this.id,
      label: this.label,
      phase: this.phase,
      error: this.error,
      usageSpent: mistToSui(spentMist),
      priceTarget: mistToSui(DEPOSIT_A_MIST),
      microUnit: mistToSui(MICRO_UNIT_MIST),
      tickCount: this.tickCount,
      tps: this.tps,
      tier: this.tier,
      history: this.history,
    };
  }

  dispose() {
    this.gen += 1;
  }

  async run(deps: ShopDeps, onChange: () => void) {
    const myGen = ++this.gen;
    this.phase = "spawning";
    this.error = null;
    onChange();

    if (!deps.account) {
      this.fail("connect a wallet to open a tunnel", onChange);
      return;
    }

    try {
      const user = createParticipant(`pshop-user-${this.id}`);
      const shop = createParticipant(`pshop-shop-${this.id}`);
      const partyA = {
        address: user.address,
        publicKey: user.keyPair.publicKey,
      };
      const partyB = {
        address: shop.address,
        publicKey: shop.keyPair.publicKey,
      };

      const reads = deps.client as SuiReads;
      const tunnelId = await openPaymentTunnel(
        {
          reads,
          signExec: deps.signExec,
          sponsoredSignExec: deps.sponsoredSignExec,
          selectStakeCoin: deps.selectStakeCoin,
          prepareStake: deps.prepareStake,
          ensureStakeBalance: deps.ensureStakeBalance,
        },
        partyA,
        partyB,
      );
      if (this.gen !== myGen) return;

      const createdAt = await readCreatedAt(reads, tunnelId);
      if (this.gen !== myGen) return;

      const tunnel = OffchainTunnel.selfPlay(
        new PaymentsProtocol(),
        tunnelId,
        user.keyPair,
        shop.keyPair,
        user.address,
        shop.address,
        { a: DEPOSIT_A_MIST, b: DEPOSIT_B_MIST },
      );
      const transcript = new Transcript(tunnelId);
      tunnel.onUpdate = (u, bytes) => {
        transcript.append(u);
        this.moveCount += 1;
        this.heartbeatActions += 1;
        this.pending.updates += 1;
        this.pending.signatures += 2;
        this.pending.verifications += 2;
        this.pending.bytes += bytes;
      };

      this.tunnel = tunnel;
      this.transcript = transcript;
      this.tunnelId = tunnelId;
      this.createdAt = createdAt;
      this.moveCount = 0;
      this.heartbeatActions = 0;
      this.phase = "running";
      onChange();

      deps.report.bumpCounters({ tunnelsOpened: 1 });
      deps.report.pushLocalTxn({
        id: 0,
        game: "regular-payments",
        time: new Date().toLocaleTimeString("en-GB"),
        bot: "You",
        type: "Opening",
        status: "Success",
        amount: "",
      });

      try {
        const reg = await getControlPlaneClient().registerSession({
          userAddress: deps.account.address,
          game: "regular-payments",
          tunnels: [{ tunnelId, partyA: user.address, partyB: shop.address }],
        });
        this.sessionId = reg.sessionId;
        this.statsToken = reg.statsToken;
        this.lastHeartbeatAt = Date.now();
      } catch (e) {
        console.error("[regular-payments] registerSession failed:", e);
      }

      await this.stream(myGen, deps, onChange);
      if (this.gen !== myGen) return;

      this.phase = "settling";
      onChange();
      this.flushHeartbeat(true);
      this.flushCounters(deps);
      deps.report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });

      const digest = await settlePaymentTunnel({
        tunnel,
        transcript,
        tunnelId,
        createdAt,
        coinType: isMtpsConfigured ? MTPS_COIN_TYPE : undefined,
        fallbackSignExec: isMtpsConfigured
          ? deps.sponsoredSignExec
          : deps.signExec,
      });
      if (this.gen !== myGen) return;

      if (digest && deps.account) {
        const time = new Date().toLocaleTimeString("en-GB");
        deps.report.pushTxn({
          id: 0,
          game: "regular-payments",
          digest,
          address: deps.account.address,
          time,
          bot: deps.account.address,
          type: "Settle",
          status: "Success",
          amount: "",
        });
        deps.report.pushLocalTxn({
          id: 0,
          game: "regular-payments",
          time,
          bot: "You",
          type: "Settled",
          status: "Success",
          amount: "",
          digest,
        });
      }

      this.phase = "closed";
      onChange();
    } catch (e) {
      if (this.gen === myGen) this.fail(e, onChange);
    }
  }

  private async stream(myGen: number, deps: ShopDeps, onChange: () => void) {
    const tunnel = this.tunnel;
    if (!tunnel) return;

    const streamStart = performance.now();

    while (this.tickCount < TICK_COUNT) {
      if (this.gen !== myGen) return;

      const frameDeadline = performance.now() + FRAME_BUDGET_MS;
      while (this.tickCount < TICK_COUNT && performance.now() < frameDeadline) {
        const r = tunnel.step(
          { from: "A", amount: MICRO_UNIT_MIST } satisfies PaymentMove,
          "A",
          { timestamp: this.ts++ },
        );
        if (!r.verified)
          throw new Error("micro-payment step failed verification");

        this.tickCount += 1;
        this.recordTps();
        this.history.push({
          index: this.tickCount,
          amount: mistToSui(MICRO_UNIT_MIST),
          at: Date.now(),
        });
      }

      this.flushHeartbeat(false);
      this.flushCounters(deps);
      onChange();

      const targetAt =
        streamStart + (this.tickCount / TICK_COUNT) * STREAM_DURATION_MS;
      const wait = targetAt - performance.now();
      if (wait > 0) await sleep(wait);
      else await sleep(0);
    }

    this.flushCounters(deps);
    this.tier = nextTier(this.id, this.tickCount);
  }

  private flushCounters(deps: ShopDeps) {
    if (this.pending.updates === 0) return;
    deps.report.bumpCounters(this.pending);
    this.pending = { updates: 0, signatures: 0, verifications: 0, bytes: 0 };
  }

  private recordTps() {
    const now = performance.now();
    this.tickTimes.push(now);
    const cutoff = now - 1000;
    while (this.tickTimes.length > 0 && this.tickTimes[0] < cutoff) {
      this.tickTimes.shift();
    }
    this.tps = this.tickTimes.length;
  }

  private flushHeartbeat(force: boolean) {
    if (!this.sessionId || !this.statsToken || this.heartbeatActions === 0)
      return;
    const now = Date.now();
    const windowMs = now - this.lastHeartbeatAt;
    if (!force && windowMs < 1000) return;
    const actionsDelta = this.heartbeatActions;
    this.heartbeatActions = 0;
    this.lastHeartbeatAt = now;
    getControlPlaneClient()
      .sendHeartbeat(this.sessionId, this.statsToken, {
        tunnelId: this.tunnelId,
        nonce: String(this.moveCount),
        actionsDelta,
        windowMs: Math.max(1, windowMs),
      })
      .catch((e) => console.error("[regular-payments] heartbeat failed:", e));
  }

  private fail(e: unknown, onChange: () => void) {
    this.error =
      typeof e === "string"
        ? e
        : String((e as Error)?.message ?? e ?? "unknown error");
    this.phase = "error";
    onChange();
  }
}

type Snap = {
  machines: MachineSessionView[];
};

class PaymentShopController {
  private machines: MachineRuntime[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();
  private snap: Snap = { machines: [] };
  private lastActiveReported = -1;
  private lastSpawnAt = 0;
  deps: ShopDeps | null = null;

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  };

  getSnapshot = (): Snap => this.snap;

  private emit() {
    this.snap = {
      machines: this.machines.map((m) => m.toView()),
    };
    const active = this.machines.filter((m) => isRunningPhase(m.phase)).length;
    if (active !== this.lastActiveReported) {
      this.deps?.report.setActive(active);
      this.lastActiveReported = active;
    }
    for (const l of this.listeners) l();
  }

  dispose() {
    for (const m of this.machines) m.dispose();
    this.machines = [];
    this.listeners.clear();
    this.deps?.report.setActive(0);
    this.lastActiveReported = 0;
  }

  spawnMachine = () => {
    const now = Date.now();
    if (now - this.lastSpawnAt < MINT_COOLDOWN_MS) return;

    const deps = this.deps;
    if (!deps?.account) return;

    const running = this.machines.filter((m) => isRunningPhase(m.phase)).length;
    if (running >= MAX_CONCURRENT_RUNNING) return;

    this.lastSpawnAt = now;
    this.seq += 1;
    const runtime = new MachineRuntime(
      `machine-${Date.now()}-${this.seq}`,
      `Random NFT #${this.seq}`,
    );
    this.machines = [...this.machines, runtime];
    this.emit();
    void runtime.run(deps, () => this.emit());
  };
}

const controllers = new Map<string, PaymentShopController>();

function getController(windowId: string): PaymentShopController {
  let c = controllers.get(windowId);
  if (!c) {
    c = new PaymentShopController();
    controllers.set(windowId, c);
    registerWindowDisposer(windowId, "regular-payments", () => {
      c!.dispose();
      controllers.delete(windowId);
    });
  }
  return c;
}

export function usePaymentShop(windowId: string) {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();
  const controller = getController(windowId);
  const mutateRef = useRef(mutateAsync);
  mutateRef.current = mutateAsync;

  controller.deps = {
    report,
    account,
    client,
    signExec: (async (tx) => {
      const r = await mutateRef.current({ transaction: tx });
      return { digest: r.digest };
    }) as SignExec,
    sponsoredSignExec: sponsored.signExec,
    selectStakeCoin: sponsored.selectStakeCoin,
    prepareStake: sponsored.prepareStake,
    ensureStakeBalance: sponsored.ensureStakeBalance,
  };

  const snap = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );

  return {
    machines: snap.machines,
    spawnMachine: controller.spawnMachine,
    walletConnected: !!account,
  };
}
