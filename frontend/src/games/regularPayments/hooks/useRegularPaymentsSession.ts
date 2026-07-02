/**
 * Regular Payments tunnel session (Tunnel Mart / grocery checkout).
 *
 * Bot-server target: shopper = seat A, shop bot = seat B, `DistributedTunnel` + `/v1/mp` relay.
 * Each cart pick = `propose` a catalog-priced payment; Pay now = cooperative settle only.
 *
 * Always user vs shop bot (seat A = shopper, seat B = fleet bot). `autoMode` only toggles
 * the auto-shopping loop — not the opponent.
 *
 * Bot entry is arena-only (`arena.join` via `enterArenaMatch`). `queue.join` is not used — that
 * path is for human PvP matchmaking in other games.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { PaymentsProtocol } from "sui-tunnel-ts/protocol/payments";
import type {
  PaymentMove,
  PaymentsState,
} from "sui-tunnel-ts/protocol/payments";
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { paymentsMoveCodec } from "sui-tunnel-ts/protocol/paymentsCodec";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { coSignCloseFromPeerRoot } from "@/pvp/settleClose";
import { useTelemetry } from "@/telemetry/TelemetryProvider";
import {
  getControlPlaneClient,
  resolveBackendUrl,
  type RegisterSessionResult,
} from "@/backend/controlPlane";
import { settleViaBackend } from "@/backend/settle";
import { MpClient, resolveMpWsUrl, type PvpChannel } from "@/pvp/mpClient";
import {
  closeCooperativeWithRoot,
  readCreatedAt,
  type SuiReads,
} from "@/onchain/tunnelTx";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "@/onchain/mtps";
import { configureSharedBatcher } from "@/onchain/sharedTunnelOpenBatcher";
import { allocateArenaGameForPlay } from "@/onchain/arenaPlay";
import type { ArenaAllocation } from "@/onchain/arenaEnter";
import {
  clearArenaEntry,
  consumeArenaEntry,
  getArenaEntry,
  subscribeArena,
} from "@/onchain/arenaAllocationStore";
import type {
  CartFlyCue,
  CartLine,
  Product,
  Screen,
  SessionPhase,
} from "../types";
import { PRODUCTS } from "../utils/catalog";
import {
  AUTO_ADD_INTERVAL_MS,
  AUTO_BURST_BUDGET_MS,
  AUTO_TARGET_CHOICES,
  AUTO_UI_BATCH_STEPS,
  DEPOSIT_BUDGET,
  REGULAR_PAYMENTS_ARENA_GAME_ID,
  REGULAR_PAYMENTS_GAME_ID,
} from "../utils/constants";
import { addCartLine, cartTotal, verifyMove } from "../utils/sessionCore";
import { formatMtps } from "../utils";

const SETTLE_URL = (digest: string) =>
  `https://suiscan.xyz/testnet/tx/${digest}`;

/** Bot graceful settle + relay RTT; Pay now errors instead of hanging forever. */
const SETTLE_HALF_TIMEOUT_MS = 90_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type RpTunnel = DistributedTunnel<PaymentsState, PaymentMove>;

/** Bot cooperative-close half on the arena wire (`PeerMessage` `settleHalf`). */
interface SettleHalfWire {
  sig: string;
  transcriptRoot: string;
}

function makeInbox(channel: PvpChannel) {
  const buf = new Map<string, unknown>();
  const waiters = new Map<string, (m: unknown) => void>();
  channel.onPeer((m) => {
    const w = waiters.get(m.t);
    if (w) {
      waiters.delete(m.t);
      w(m);
    } else {
      buf.set(m.t, m);
    }
  });
  return <T = unknown>(t: string): Promise<T> =>
    new Promise((res) => {
      const b = buf.get(t);
      if (b) {
        buf.delete(t);
        res(b as T);
      } else {
        waiters.set(t, res as (m: unknown) => void);
      }
    });
}

interface SessionDeps {
  report: ReturnType<typeof useTelemetry>["report"];
  account: string | undefined;
  client: unknown;
  sponsoredSignExec: ReturnType<typeof useSponsoredSignExec>["signExec"];
  signExec: ReturnType<typeof useSponsoredSignExec>["signExec"];
  ensureStakeBalance: ReturnType<
    typeof useSponsoredSignExec
  >["ensureStakeBalance"];
  prepareStake: ReturnType<typeof useSponsoredSignExec>["prepareStake"];
  selectStakeCoin: ReturnType<typeof useSponsoredSignExec>["selectStakeCoin"];
}

interface RegularPaymentsSnapshot {
  screen: Screen;
  phase: SessionPhase;
  cart: CartLine[];
  balanceA: bigint;
  paidSoFar: bigint;
  payTarget: bigint;
  rollingTps: number;
  settleDigest: string | null;
  settleUrl: string | null;
  error: string | null;
  autoMode: boolean;
  autoTarget: bigint;
  cartFlyCue: CartFlyCue | null;
  /** Off-chain pick awaiting bot ACK — blocks another propose, not full-shop dim. */
  pickInFlight: boolean;
}

class RegularPaymentsSession {
  deps: SessionDeps | null = null;
  private gen = 0;
  private listeners = new Set<() => void>();

  private screen: Screen = "lobby";
  private phase: SessionPhase = "idle";
  private cart: CartLine[] = [];
  private balanceA = DEPOSIT_BUDGET;
  private paidSoFar = 0n;
  private payTarget = 0n;
  private rollingTps = 0;
  private settleDigest: string | null = null;
  private settleUrl: string | null = null;
  private error: string | null = null;

  private autoMode = true;
  private autoTarget = 0n;
  private autoAbort: AbortController | null = null;
  private autoLoopRunning = false;
  private lastAddMs = 0;
  private cartFlySeq = 0;
  private cartFlyCue: CartFlyCue | null = null;
  private pickInFlight = false;
  /** P5: auto time-budget burst — defer cart UI patches between flushes. */
  private autoBurstActive = false;
  private burstStepsSinceFlush = 0;

  private tunnel: RpTunnel | null = null;
  private tunnelId = "";
  /** Reset by the hook after a consumed arena entry fails or the round completes. */
  releaseArenaEntryGate: (() => void) | null = null;
  private moveTs = 1n;

  private mp: MpClient | null = null;
  private channel: PvpChannel | null = null;
  private role: "A" | "B" | null = null;
  /** Early `settleHalf` from the shop bot (mirrors blackjack's `bufferedSettleRef`). */
  private bufferedSettleHalf: SettleHalfWire | null = null;
  private settleHalfWaiter: ((half: SettleHalfWire) => void) | null = null;

  private cpSession: RegisterSessionResult | null = null;
  private moveCount = 0;
  private actions = 0;
  private lastHeartbeat = Date.now();
  private tpsWindowStart = Date.now();
  private tpsWindowSteps = 0;
  private localTxnSeq = 0;

  private snap: RegularPaymentsSnapshot = {
    screen: "lobby",
    phase: "idle",
    cart: [],
    balanceA: DEPOSIT_BUDGET,
    paidSoFar: 0n,
    payTarget: 0n,
    rollingTps: 0,
    settleDigest: null,
    settleUrl: null,
    error: null,
    autoMode: true,
    autoTarget: 0n,
    cartFlyCue: null,
    pickInFlight: false,
  };

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): RegularPaymentsSnapshot => this.snap;

  private emit() {
    this.snap = {
      screen: this.screen,
      phase: this.phase,
      cart: this.cart,
      balanceA: this.balanceA,
      paidSoFar: this.paidSoFar,
      payTarget: this.payTarget,
      rollingTps: this.rollingTps,
      settleDigest: this.settleDigest,
      settleUrl: this.settleUrl,
      error: this.error,
      autoMode: this.autoMode,
      autoTarget: this.autoTarget,
      cartFlyCue: this.cartFlyCue,
      pickInFlight: this.pickInFlight,
    };
    for (const l of this.listeners) l();
  }

  private patch(p: Partial<RegularPaymentsSnapshot>) {
    if (p.screen !== undefined) this.screen = p.screen;
    if (p.phase !== undefined) this.phase = p.phase;
    if (p.cart !== undefined) this.cart = p.cart;
    if (p.balanceA !== undefined) this.balanceA = p.balanceA;
    if (p.paidSoFar !== undefined) this.paidSoFar = p.paidSoFar;
    if (p.payTarget !== undefined) this.payTarget = p.payTarget;
    if (p.rollingTps !== undefined) this.rollingTps = p.rollingTps;
    if (p.settleDigest !== undefined) this.settleDigest = p.settleDigest;
    if (p.settleUrl !== undefined) this.settleUrl = p.settleUrl;
    if (p.error !== undefined) this.error = p.error;
    if (p.autoMode !== undefined) this.autoMode = p.autoMode;
    if (p.autoTarget !== undefined) this.autoTarget = p.autoTarget;
    if (p.cartFlyCue !== undefined) this.cartFlyCue = p.cartFlyCue;
    if (p.pickInFlight !== undefined) this.pickInFlight = p.pickInFlight;
    this.emit();
  }

  private syncBalance() {
    const t = this.tunnel;
    if (!t) return;
    this.balanceA = t.displayState.balanceA;
  }

  private flushHeartbeat(force: boolean) {
    const s = this.cpSession;
    if (!s || this.actions === 0) return;
    const now = Date.now();
    const windowMs = now - this.lastHeartbeat;
    if (!force && windowMs < 1000) return;
    const actionsDelta = this.actions;
    this.actions = 0;
    this.lastHeartbeat = now;
    this.deps?.report.recordActions(actionsDelta);
    getControlPlaneClient()
      .sendHeartbeat(s.sessionId, s.statsToken, {
        tunnelId: this.tunnelId,
        nonce: String(this.moveCount),
        actionsDelta,
        windowMs: Math.max(1, windowMs),
      })
      .catch((e) => console.error("[regular-payments] heartbeat failed:", e));
  }

  private bumpTps(steps: number) {
    this.tpsWindowSteps += steps;
    const now = Date.now();
    const elapsed = now - this.tpsWindowStart;
    if (elapsed >= 1000) {
      this.rollingTps = Math.round((this.tpsWindowSteps * 1000) / elapsed);
      this.tpsWindowStart = now;
      this.tpsWindowSteps = 0;
      this.patch({ rollingTps: this.rollingTps });
    }
  }

  private async awaitSettleHalf(timeoutMs: number): Promise<SettleHalfWire> {
    const buffered = this.bufferedSettleHalf;
    if (buffered) {
      this.bufferedSettleHalf = null;
      return buffered;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<SettleHalfWire>((res) => {
          this.settleHalfWaiter = res;
        }),
        new Promise<SettleHalfWire>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Timed out waiting for peer "settleHalf"`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (this.settleHalfWaiter) this.settleHalfWaiter = null;
    }
  }

  private teardownRelay() {
    this.mp?.close();
    this.mp = null;
    this.channel = null;
    this.role = null;
    this.bufferedSettleHalf = null;
    this.settleHalfWaiter = null;
  }

  private abandonTunnel() {
    this.teardownRelay();
    this.tunnel = null;
    this.tunnelId = "";
    this.moveTs = 1n;
    this.cpSession = null;
    this.moveCount = 0;
    this.actions = 0;
    this.paidSoFar = 0n;
    this.payTarget = 0n;
    this.balanceA = DEPOSIT_BUDGET;
    this.rollingTps = 0;
    this.tpsWindowStart = Date.now();
    this.tpsWindowSteps = 0;
    this.cart = [];
    this.pickInFlight = false;
    this.autoBurstActive = false;
    this.burstStepsSinceFlush = 0;
  }

  private flushBurstUi() {
    this.burstStepsSinceFlush = 0;
    this.patch({
      cart: [...this.cart],
      paidSoFar: this.paidSoFar,
      balanceA: this.balanceA,
      pickInFlight: this.pickInFlight,
      rollingTps: this.rollingTps,
    });
  }

  /** Yield until the current pick ACK lands (auto burst uses sleep(0), not 50ms poll). */
  private async waitPickIdle(signal: AbortSignal): Promise<boolean> {
    while (this.pickInFlight) {
      if (signal.aborted || !this.autoMode) return false;
      await sleep(0);
    }
    return true;
  }

  dispose = () => {
    this.gen += 1;
    this.stopAutoLoop();
    this.abandonTunnel();
    this.listeners.clear();
    this.deps?.report.setActive(0);
  };

  /** On-demand arena entry: reserve a shop bot + deposit seat A, then `arena.join`. */
  private fundArenaAndEnter() {
    const deps = this.deps;
    if (!deps?.account) return;

    const myGen = ++this.gen;
    const wallet = deps.account;
    this.patch({
      phase: "opening",
      error: null,
      settleDigest: null,
      settleUrl: null,
      paidSoFar: 0n,
      payTarget: 0n,
      rollingTps: 0,
    });

    void (async () => {
      try {
        const entry = await allocateArenaGameForPlay({
          arenaGameId: REGULAR_PAYMENTS_ARENA_GAME_ID,
          wallet,
          stake: {
            sponsoredSignExec: deps.sponsoredSignExec,
            walletSignExec: deps.signExec,
            prepareStake: deps.prepareStake,
            selectStakeCoin: deps.selectStakeCoin,
            ensureStakeBalance: deps.ensureStakeBalance,
          },
          label: REGULAR_PAYMENTS_ARENA_GAME_ID,
          stakePerGame: DEPOSIT_BUDGET,
        });
        if (this.gen !== myGen) return;
        if (!entry) {
          throw new Error("No shop bot available — try again in a moment.");
        }
        this.enterArenaMatch(entry.allocation, entry.keypair);
      } catch (e) {
        if (this.gen !== myGen) return;
        this.releaseArenaEntryGate?.();
        this.patch({
          phase: "error",
          screen: "lobby",
          error: String((e as Error)?.message ?? e),
        });
      }
    })();
  }

  private wireDistributedTunnel(
    dt: RpTunnel,
    protocol: PaymentsProtocol,
    tunnelId: string,
    initialBalanceA: bigint,
    partyA: string,
    partyB: string,
  ) {
    const deps = this.deps!;
    this.tunnel = dt;
    this.tunnelId = tunnelId;
    this.moveTs = 1n;
    this.cpSession = null;
    this.moveCount = 0;
    this.actions = 0;
    this.lastHeartbeat = Date.now();

    dt.onConfirmed = () => {
      this.moveCount += 1;
      this.actions += 1;
      deps.report.bumpCounters({
        updates: 1,
        signatures: 1,
        verifications: 1,
        bytes: 0,
      });
      this.bumpTps(1);
      this.flushHeartbeat(false);
      this.syncBalance();
      this.pickInFlight = false;

      if (this.autoBurstActive) {
        this.burstStepsSinceFlush += 1;
        if (this.burstStepsSinceFlush >= AUTO_UI_BATCH_STEPS) {
          this.flushBurstUi();
        }
      } else {
        this.patch({
          pickInFlight: false,
          balanceA: this.balanceA,
        });
      }
    };

    getControlPlaneClient()
      .registerSession({
        userAddress: deps.account!,
        game: REGULAR_PAYMENTS_ARENA_GAME_ID,
        tunnels: [{ tunnelId, partyA, partyB }],
      })
      .then((s) => {
        this.cpSession = s;
      })
      .catch((e) =>
        console.error("[regular-payments] registerSession failed:", e),
      );

    deps.report.bumpCounters({ tunnelsOpened: 1 });
    deps.report.setActive(2);
    deps.report.pushLocalTxn({
      id: ++this.localTxnSeq,
      game: REGULAR_PAYMENTS_GAME_ID,
      address: deps.account,
      time: new Date().toLocaleTimeString("en-GB"),
      bot: "Shop",
      type: "Open shop",
      status: "Success",
      amount: formatMtps(initialBalanceA),
    });
    this.syncBalance();
    this.patch({
      screen: "shop",
      phase: "shopping",
      balanceA: initialBalanceA,
      error: null,
    });
  }

  private buildDistributedTunnel(
    tunnelId: string,
    wallet: string,
    tunnelEph: KeyPair,
    oppWallet: string,
    oppPub: Uint8Array,
    role: "A" | "B",
    channel: PvpChannel,
    balances: { a: bigint; b: bigint },
  ): RpTunnel {
    const backend = defaultBackend();
    const protocol = new PaymentsProtocol();
    const dt = new DistributedTunnel<PaymentsState, PaymentMove>(
      protocol,
      {
        tunnelId,
        self: makeEndpoint(backend, wallet, tunnelEph, true),
        opponent: makeEndpoint(
          backend,
          oppWallet,
          { publicKey: oppPub, scheme: tunnelEph.scheme },
          false,
        ),
        selfParty: role,
        moveCodec: paymentsMoveCodec,
      },
      channel.transport,
      balances,
    );
    return dt;
  }

  enterArenaMatch = (allocation: ArenaAllocation, eph: KeyPair) => {
    const deps = this.deps;
    if (!deps?.account) {
      this.patch({
        phase: "error",
        error: "Connect a wallet to enter the shop.",
      });
      return;
    }

    const myGen = ++this.gen;
    this.abandonTunnel();
    this.patch({
      error: null,
    });

    void (async () => {
      try {
        if (this.gen !== myGen) return;
        const wallet = deps.account!;
        const connEph = generateKeyPair();
        const mp = new MpClient(
          resolveMpWsUrl(resolveBackendUrl()),
          wallet,
          connEph,
        );
        this.mp = mp;
        await mp.connect();

        const match = await mp.joinMatch(allocation.matchId);
        if (this.gen !== myGen) return;
        this.role = match.role;

        const channel = mp.channel(match.matchId);
        this.channel = channel;
        this.bufferedSettleHalf = null;
        this.settleHalfWaiter = null;

        const waitPeer = makeInbox(channel);

        channel.addPeerListener((m) => {
          if (m.t !== "settleHalf") return;
          const half: SettleHalfWire = {
            sig: String(m.sig),
            transcriptRoot: String(m.transcriptRoot),
          };
          if (this.settleHalfWaiter) {
            this.settleHalfWaiter(half);
            this.settleHalfWaiter = null;
          } else {
            this.bufferedSettleHalf = half;
          }
        });

        channel.sendPeer({
          t: "hello",
          ephemeralPubkey: toHex(eph.publicKey),
        });
        const hello = await waitPeer<{ ephemeralPubkey: string }>("hello");
        const oppPub = fromHex(hello.ephemeralPubkey);

        const stake =
          allocation.stakeEach != null
            ? BigInt(allocation.stakeEach)
            : DEPOSIT_BUDGET;
        if (match.role !== "A") {
          throw new Error(
            "Regular Payments arena matches must seat the shopper as party A.",
          );
        }
        const protocol = new PaymentsProtocol();
        const dt = this.buildDistributedTunnel(
          allocation.tunnelId,
          wallet,
          eph,
          match.opponentWallet,
          oppPub,
          match.role,
          channel,
          { a: stake, b: stake },
        );

        this.tunnelId = allocation.tunnelId;

        this.wireDistributedTunnel(
          dt,
          protocol,
          allocation.tunnelId,
          dt.state.balanceA,
          wallet,
          match.opponentWallet,
        );
      } catch (e) {
        if (this.gen !== myGen) return;
        this.releaseArenaEntryGate?.();
        deps.report.setActive(0);
        this.abandonTunnel();
        this.patch({
          phase: "error",
          screen: "lobby",
          error: String((e as Error)?.message ?? e),
        });
      }
    })();
  };

  findShop = () => {
    const deps = this.deps;
    if (!deps?.account) {
      this.patch({
        phase: "error",
        error: "Connect a wallet to find a shop.",
      });
      return;
    }
    if (
      this.phase === "opening" ||
      this.phase === "settling" ||
      this.pickInFlight
    ) {
      return;
    }

    if (this.tunnel && this.phase === "shopping") {
      this.syncBalance();

      this.patch({
        screen: "shop",
        error: null,
        paidSoFar: cartTotal(this.cart),
        payTarget: 0n,
        balanceA: this.tunnel.state.balanceA,
      });
      return;
    }

    const arenaEntry = getArenaEntry(REGULAR_PAYMENTS_ARENA_GAME_ID);
    if (arenaEntry) {
      clearArenaEntry(REGULAR_PAYMENTS_ARENA_GAME_ID);
      this.enterArenaMatch(arenaEntry.allocation, arenaEntry.keypair);
      return;
    }

    this.fundArenaAndEnter();
  };

  private stopAutoLoop() {
    this.autoAbort?.abort();
    this.autoAbort = null;
  }

  private startAutoLoop() {
    if (this.autoLoopRunning || !this.autoMode || !this.deps?.account) return;
    const ac = new AbortController();
    this.autoAbort = ac;
    this.autoLoopRunning = true;
    void this.runAutoLoop(ac.signal).finally(() => {
      this.autoLoopRunning = false;
      if (this.autoAbort === ac) this.autoAbort = null;
    });
  }

  bindAutoLoop = (walletConnected: boolean) => {
    if (walletConnected && this.autoMode) {
      this.startAutoLoop();
    } else {
      this.stopAutoLoop();
    }
  };

  private randomAutoTarget(): bigint {
    return AUTO_TARGET_CHOICES[
      Math.floor(Math.random() * AUTO_TARGET_CHOICES.length)
    ]!;
  }

  private pickRandomProduct(): Product {
    return PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)]!;
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
      await sleep(50);
    }
    return true;
  }

  private async runAutoLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.autoMode) {
      if (!this.deps?.account) {
        await sleep(500);
        continue;
      }

      if (
        this.screen !== "shop" ||
        this.phase === "idle" ||
        this.phase === "opening" ||
        this.phase === "error"
      ) {
        if (
          this.phase !== "opening" &&
          this.phase !== "settling" &&
          !this.pickInFlight
        ) {
          this.findShop();
        }
        const shopReady = await this.waitForState(
          signal,
          () =>
            (this.screen === "shop" &&
              this.phase === "shopping" &&
              !this.pickInFlight) ||
            this.phase === "error",
        );
        if (!shopReady) return;
        if (this.phase === "error") {
          await sleep(1000);
          continue;
        }
      }

      if (signal.aborted || !this.autoMode) return;

      const target = this.randomAutoTarget();
      this.patch({ autoTarget: target });

      this.autoBurstActive = true;
      this.burstStepsSinceFlush = 0;
      try {
        const deadline = Date.now() + AUTO_BURST_BUDGET_MS;
        while (
          !signal.aborted &&
          this.autoMode &&
          this.phase === "shopping" &&
          Date.now() < deadline
        ) {
          const total = cartTotal(this.cart);
          if (total >= target) break;

          const product = this.pickRandomProduct();
          const balanceA = this.tunnel?.state.balanceA ?? 0n;
          if (product.priceMtps > balanceA) break;

          this.addToCart(product, true);
          const ready = await this.waitPickIdle(signal);
          if (!ready) return;
          await sleep(0);
        }
      } finally {
        this.autoBurstActive = false;
        this.flushBurstUi();
      }

      if (signal.aborted || !this.autoMode) return;

      const picksDone = await this.waitPickIdle(signal);
      if (!picksDone) return;

      if (this.phase === "shopping" && cartTotal(this.cart) > 0n) {
        this.payNow(true);
      }

      const thankReady = await this.waitForState(
        signal,
        () => this.screen === "thankYou" && this.phase === "idle",
      );
      if (!thankReady) return;

      const lobbyReady = await this.waitForState(
        signal,
        () => this.screen === "lobby",
      );
      if (!lobbyReady) return;

      await sleep(AUTO_ADD_INTERVAL_MS);
    }
  }

  toggleAutoMode = () => {
    if (this.autoMode) {
      this.stopAutoLoop();
      this.autoBurstActive = false;
      this.flushBurstUi();
      this.patch({ autoMode: false });
      return;
    }
    this.patch({ autoMode: true });
    this.startAutoLoop();
  };

  goLobby = () => {
    if (this.tunnel) this.syncBalance();
    this.patch({
      screen: "lobby",
      phase: this.tunnel ? "shopping" : "idle",
      paidSoFar: 0n,
      payTarget: 0n,
      rollingTps: 0,
      error: null,
      settleDigest: null,
      settleUrl: null,
      ...(this.tunnel ? { balanceA: this.balanceA } : {}),
    });
  };

  completeRound = () => {
    this.releaseArenaEntryGate?.();
    this.abandonTunnel();

    this.patch({
      screen: "lobby",
      phase: "idle",
      error: null,
      settleDigest: null,
      settleUrl: null,
      autoTarget: 0n,
    });
  };

  addToCart = (product: Product, fromAuto = false) => {
    if (this.phase !== "shopping" || this.pickInFlight) return;
    const tunnel = this.tunnel;
    if (!tunnel) return;
    if (this.role !== "A") {
      this.patch({ error: "Only seat A (shopper) can add items to the cart." });
      return;
    }

    if (!fromAuto) {
      const now = Date.now();
      if (now - this.lastAddMs < AUTO_ADD_INTERVAL_MS) return;
      this.lastAddMs = now;
    }

    // Cart lines are already paid (balanceA was debited on each confirmed pick).
    // Compare only the next line price to the remaining shopper balance.
    if (product.priceMtps > tunnel.state.balanceA) {
      this.patch({
        error: `Insufficient balance in your tunnel (${formatMtps(tunnel.state.balanceA)} MTPS left of ${formatMtps(DEPOSIT_BUDGET)}).`,
      });
      return;
    }

    const move = { from: "A" as const, amount: product.priceMtps };
    const verification = verifyMove(tunnel.state, move, PRODUCTS);
    if (!verification.valid) {
      this.patch({ error: verification.error ?? "Invalid move." });
      return;
    }

    try {
      tunnel.propose(move, this.moveTs++);
    } catch (e) {
      this.patch({
        error: String((e as Error)?.message ?? e),
      });
      return;
    }
    this.syncBalance();

    if (!fromAuto) {
      this.stopAutoLoop();
      this.autoMode = false;
    }

    const nextCart = addCartLine(this.cart, product);
    this.cart = nextCart;
    this.paidSoFar += product.priceMtps;

    const cartFlyCue: CartFlyCue = {
      seq: ++this.cartFlySeq,
      productId: product.id,
      emoji: product.emoji,
    };
    this.pickInFlight = true;

    if (fromAuto && this.autoBurstActive) {
      // Cart/balance stay in memory until flushBurstUi; fly cue patches every pick.
      this.patch({ cartFlyCue, pickInFlight: true });
      return;
    }

    this.patch({
      pickInFlight: true,
      cart: nextCart,
      paidSoFar: this.paidSoFar,
      cartFlyCue,
      autoMode: this.autoMode,
      balanceA: this.balanceA,
      error: null,
    });
  };

  removeFromCart = (productId: string) => {
    if (this.phase !== "shopping") return;
    if (!this.tunnel) return;
    if (!this.cart.find((l) => l.id === productId)) return;

    this.patch({
      error:
        "Remove from cart over relay requires the shop bot to propose refunds (coming soon).",
    });
  };

  payNow = (_fromAuto = false) => {
    const deps = this.deps;
    const tunnel = this.tunnel;
    const channel = this.channel;
    if (!deps?.account || !tunnel || !channel) return;
    if (this.phase !== "shopping" || this.pickInFlight) return;

    const target = cartTotal(this.cart);
    if (target <= 0n) return;

    const myGen = this.gen;

    this.patch({
      phase: "settling",
      payTarget: target,
      error: null,
      rollingTps: 0,
    });
    this.tpsWindowStart = Date.now();
    this.tpsWindowSteps = 0;

    void (async () => {
      try {
        this.flushHeartbeat(true);
        deps.report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
        deps.report.setActive(0);

        channel.sendPeer({ t: "stop" });

        const other = await this.awaitSettleHalf(SETTLE_HALF_TIMEOUT_MS);

        const createdAt = await readCreatedAt(
          deps.client as SuiReads,
          this.tunnelId,
        );
        const coSigned = coSignCloseFromPeerRoot(
          tunnel,
          createdAt,
          fromHex(other.transcriptRoot),
          fromHex(other.sig),
        );

        const coinType = isMtpsConfigured ? MTPS_COIN_TYPE : undefined;
        const digest =
          this.role === "A"
            ? await settleViaBackend({
                tunnelId: this.tunnelId,
                settlement: coSigned,
                transcript: [],
                label: REGULAR_PAYMENTS_GAME_ID,
                fallbackClose: () =>
                  closeCooperativeWithRoot({
                    signExec: (isMtpsConfigured
                      ? deps.sponsoredSignExec
                      : deps.signExec) as never,
                    tunnelId: this.tunnelId,
                    settlement: coSigned,
                    coinType,
                  }),
              })
            : undefined;

        if (this.gen !== myGen) return;

        deps.report.pushLocalTxn({
          id: ++this.localTxnSeq,
          game: REGULAR_PAYMENTS_GAME_ID,
          digest: digest ?? undefined,
          address: deps.account,
          time: new Date().toLocaleTimeString("en-GB"),
          bot: "Shop",
          type: "Settled",
          status: "Success",
          amount: formatMtps(target),
        });

        this.patch({
          screen: "thankYou",
          phase: "idle",
          settleDigest: digest ?? null,
          settleUrl: digest ? SETTLE_URL(digest) : null,
        });
      } catch (e) {
        if (this.gen !== myGen) return;
        this.syncBalance();
        this.patch({
          phase: "shopping",
          error: String((e as Error)?.message ?? e),
        });
      }
    })();
  };
}

const sessions = new Map<string, RegularPaymentsSession>();

function getSession(windowId: string): RegularPaymentsSession {
  let session = sessions.get(windowId);
  if (!session) {
    session = new RegularPaymentsSession();
    sessions.set(windowId, session);
    const created = session;
    registerWindowDisposer(windowId, "regular-payments", () => {
      created.dispose();
      sessions.delete(windowId);
    });
  }
  return session;
}

export function useRegularPaymentsSession(windowId: string) {
  const arenaEnteredRef = useRef(false);

  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();

  const session = getSession(windowId);
  session.releaseArenaEntryGate = () => {
    arenaEnteredRef.current = false;
  };
  const walletSignExec = useCallback(
    async (tx: Parameters<typeof signAndExecute>[0]["transaction"]) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    },
    [signAndExecute],
  );

  session.deps = {
    report,
    account: account?.address,
    client,
    sponsoredSignExec: sponsored.signExec,
    signExec: walletSignExec as never,
    ensureStakeBalance: sponsored.ensureStakeBalance,
    prepareStake: sponsored.prepareStake,
    selectStakeCoin: sponsored.selectStakeCoin,
  };

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);

  useEffect(() => {
    const tryEnter = () =>
      consumeArenaEntry(
        REGULAR_PAYMENTS_ARENA_GAME_ID,
        arenaEnteredRef,
        () => {
          const s = session.getSnapshot();
          return s.phase === "idle" && s.screen === "lobby";
        },
        (allocation, keypair) => {
          session.enterArenaMatch(allocation, keypair);
        },
      );
    tryEnter();

    return subscribeArena(tryEnter);
  }, [session, snap.phase, snap.screen]);

  useEffect(() => {
    session.bindAutoLoop(Boolean(account?.address));
  }, [account?.address, session]);

  configureSharedBatcher({
    reads: client as never,
    sponsoredSignExec: sponsored.signExec as never,
    signExec: walletSignExec as never,
    ensureStakeBalance: sponsored.ensureStakeBalance,
    prepareStake: sponsored.prepareStake,
    selectStakeCoin: sponsored.selectStakeCoin,
  });

  const itemCount = snap.cart.reduce((n, l) => n + l.qty, 0);
  const cartTotalValue = cartTotal(snap.cart);
  const walletConnected = Boolean(account?.address);
  const busy = snap.phase === "opening" || snap.phase === "settling";

  return {
    ...snap,
    cartTotal: cartTotalValue,
    itemCount,
    walletConnected,
    busy,
    depositBudget: DEPOSIT_BUDGET,

    findShop: session.findShop,
    goLobby: session.goLobby,
    completeRound: session.completeRound,
    payNow: session.payNow,
    addToCart: session.addToCart,
    removeFromCart: session.removeFromCart,
    toggleAutoMode: session.toggleAutoMode,
  };
}
