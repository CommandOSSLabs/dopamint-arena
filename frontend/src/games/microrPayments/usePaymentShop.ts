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
  type PaymentsState,
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
  DEPOSIT_A,
  DEPOSIT_B,
  MAX_CONCURRENT_RUNNING,
  MINT_COOLDOWN_MS,
  MICRO_UNIT,
  STREAM_DURATION_MS,
  TICK_COUNT,
} from "./constants";
import { openPaymentTunnel } from "./openPaymentTunnel";
import { mintNftRewardToMiner, pickNftReward } from "./nftReward";
import { settlePaymentTunnel, type PaymentTunnel } from "./paymentSettle";
import { createRegularPaymentsKit } from "@/agent/games/regularPayments/kit";
import type {
  MachinePhase,
  MachineSessionView,
  NftReward,
  NftTier,
} from "./types";
import type { GameBot } from "@/agent/gameKit";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRunningPhase(phase: MachinePhase): boolean {
  return phase === "spawning" || phase === "running" || phase === "settling";
}

/** Co-sign micro-payments in bursts, then yield one frame — keeps card counters smooth. */
const FRAME_BUDGET_MS = 8;

/** UI refresh while any card is streaming — decoupled from per-machine burst cadence. */
const TPS_DISPLAY_REFRESH_MS = 100;

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
  tier: NftTier = "unknown";
  reward: NftReward | null = null;
  digest: string | null = null;
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

  private payerBot: GameBot<PaymentsState, PaymentMove> | null = null;

  constructor(id: string, label: string, number: number) {
    this.id = id;
    this.label = label;
  }

  /** Rolling 1 s window — recomputed on read so the UI stays fresh between stream bursts. */
  private readTps(): number {
    if (this.phase !== "running") return 0;
    const now = performance.now();
    const cutoff = now - 1000;
    while (this.tickTimes.length > 0 && this.tickTimes[0] < cutoff) {
      this.tickTimes.shift();
    }
    return this.tickTimes.length;
  }

  toView(): MachineSessionView {
    const revealed = this.phase === "closed";
    return {
      id: this.id,
      label: this.label,
      phase: this.phase,
      error: this.error,
      tickCount: this.tickCount,
      tickMax: TICK_COUNT,
      tps: this.readTps(),
      tier: revealed ? this.tier : "unknown",
      reward: revealed ? this.reward : null,
      digest: this.digest,
    };
  }

  dispose() {
    this.gen += 1;
  }

  async run(deps: ShopDeps, onChange: () => void) {
    const myGen = ++this.gen;
    this.phase = "spawning";
    this.error = null;
    this.digest = null;
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
        { a: DEPOSIT_A, b: DEPOSIT_B },
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

      const kit = createRegularPaymentsKit(MICRO_UNIT);
      this.payerBot = kit.createBot("A", { rngForSeat: () => Math.random });
      onChange();

      deps.report.bumpCounters({ tunnelsOpened: 1 });
      deps.report.pushLocalTxn({
        id: 0,
        game: "Micro Payments",
        time: new Date().toLocaleTimeString("en-GB"),
        bot: "You",
        type: "Opening",
        status: "Success",
        amount: "",
      });

      try {
        const reg = await getControlPlaneClient().registerSession({
          userAddress: deps.account.address,
          game: "micro-payments",
          tunnels: [{ tunnelId, partyA: user.address, partyB: shop.address }],
        });
        this.sessionId = reg.sessionId;
        this.statsToken = reg.statsToken;
        this.lastHeartbeatAt = Date.now();
      } catch (e) {
        console.error("[micro-payments] registerSession failed:", e);
      }

      await this.stream(myGen, deps, onChange);
      if (this.gen !== myGen) return;

      this.phase = "settling";
      onChange();
      this.flushHeartbeat(true);
      this.flushCounters(deps);
      deps.report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });

      const settleP = settlePaymentTunnel({
        tunnel,
        transcript,
        tunnelId,
        createdAt,
        coinType: isMtpsConfigured ? MTPS_COIN_TYPE : undefined,
        fallbackSignExec: isMtpsConfigured
          ? deps.sponsoredSignExec
          : deps.signExec,
      }).catch((e) => {
        console.warn("[micro-payments] settle failed:", e);
        return undefined;
      });

      const mintP =
        isMtpsConfigured && this.reward
          ? mintNftRewardToMiner({
              sponsoredSignExec: deps.sponsoredSignExec,
              walletSignExec: deps.signExec,
              reward: this.reward,
            })
              .then((r) => r.digest)
              .catch((e) => {
                console.warn("[micro-payments] mint failed:", e);
                return undefined;
              })
          : Promise.resolve(undefined);

      const [settleDigest, mintDigest] = await Promise.all([settleP, mintP]);
      if (this.gen !== myGen) return;

      this.digest = mintDigest || null;

      if (deps.account) {
        const time = new Date().toLocaleTimeString("en-GB");
        if (settleDigest) {
          deps.report.pushTxn({
            id: 0,
            game: "Micro Payments",
            digest: settleDigest,
            address: deps.account.address,
            time,
            bot: deps.account.address,
            type: "Settle",
            status: "Success",
            amount: "",
          });
          deps.report.pushLocalTxn({
            id: 0,
            game: "Micro Payments",
            time,
            bot: "You",
            type: "Settled",
            status: "Success",
            amount: "",
            digest: settleDigest,
          });
        }
        if (mintDigest && this.reward) {
          deps.report.pushTxn({
            id: 0,
            game: "Micro Payments",
            digest: mintDigest,
            address: deps.account.address,
            time,
            bot: deps.account.address,
            type: "Mint NFT",
            status: "Success",
            amount: this.reward.title,
          });
          deps.report.pushLocalTxn({
            id: 0,
            game: "Micro Payments",
            time,
            bot: "You",
            type: "Mint NFT",
            status: "Success",
            amount: this.reward.title,
            digest: mintDigest,
          });
        }
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
        const preState = tunnel.state;
        const move = this.payerBot
          ? this.payerBot.plan(preState)
          : ({ from: "A", amount: MICRO_UNIT } satisfies PaymentMove);
        if (!move) {
          // Payer exhausted its budget — stop the stream early
          break;
        }
        const r = tunnel.step(move, "A", { timestamp: this.ts++ });
        if (!r.verified)
          throw new Error("micro-payment step failed verification");

        if (this.payerBot) {
          this.payerBot.confirm(preState, move);
        }

        this.tickCount += 1;
        this.recordTps();
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
    this.reward = pickNftReward();
  }

  private flushCounters(deps: ShopDeps) {
    if (this.pending.updates === 0) return;
    deps.report.bumpCounters(this.pending);
    this.pending = { updates: 0, signatures: 0, verifications: 0, bytes: 0 };
  }

  private recordTps() {
    this.tickTimes.push(performance.now());
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
      .catch((e) => console.error("[micro-payments] heartbeat failed:", e));
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
  private displayRefreshId: ReturnType<typeof setInterval> | null = null;
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
    this.syncDisplayRefresh();
    for (const l of this.listeners) l();
  }

  /** Keep TPS readouts ticking while cards stream — auto mode starves burst-driven emits. */
  private syncDisplayRefresh() {
    const streaming = this.machines.some((m) => m.phase === "running");
    if (streaming && !this.displayRefreshId) {
      this.displayRefreshId = setInterval(
        () => this.emit(),
        TPS_DISPLAY_REFRESH_MS,
      );
    } else if (!streaming && this.displayRefreshId) {
      clearInterval(this.displayRefreshId);
      this.displayRefreshId = null;
    }
  }

  dispose() {
    if (this.displayRefreshId) {
      clearInterval(this.displayRefreshId);
      this.displayRefreshId = null;
    }
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
      `Machine #${this.seq}`,
      this.seq,
    );
    this.machines = [runtime, ...this.machines];
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
    registerWindowDisposer(windowId, "micro-payments", () => {
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
