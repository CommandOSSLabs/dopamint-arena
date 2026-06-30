import { useEffect, useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { QuantumPokerProtocol } from "sui-tunnel-ts/protocol/quantumPoker";
import type {
  PokerState,
  PokerMove,
} from "sui-tunnel-ts/protocol/quantumPoker";
import { registerWindowDisposer } from "@/lib/windowSessions";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "@/backend/controlPlane";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import type { TelemetryWriter } from "../../telemetry/TelemetryProvider";
import {
  openAndFundSelfPlay,
  readCreatedAt,
  type SignExec,
} from "@/onchain/tunnelTx";
import { makeKeypairSponsoredSignExec } from "@/onchain/sponsor";
import {
  MTPS_COIN_TYPE,
  ensureMtpsAddressBalance,
  ensureMtpsStakeCoin,
  isMtpsAddressBalance,
  isMtpsConfigured,
} from "@/onchain/mtps";
import {
  QUANTUM_POKER_STAKE,
  QUANTUM_POKER_HANDS_PER_TUNNEL,
} from "./constants";
import {
  loadOrCreateQuantumPokerBots,
  botBalances,
  buildFundBotATx,
  fundBotAFromFaucet,
  MIN_PLAY_MIST,
  type QuantumPokerBot,
  type BotReadClient,
} from "./bots";
import {
  makeSeatBot,
  randomPokerPersona,
  stepPokerAuto,
  stepPokerWithHuman,
  applyHumanMove,
  legalPokerActions,
  isHumanBettingTurn,
  LIVE_BOT_CONTEXT,
  type PokerSeatBot,
  type PokerTunnel,
  type PokerLegalActions,
} from "./pokerSelfPlay";
import { settlePokerTunnel } from "./pokerSettle";

const STAKE = QUANTUM_POKER_STAKE;
const MTPS_PER_SEAT = 1_000_000n; // 0.001 MTPS/seat → a clean 1.0M-chip stack; still deep enough to run a full HAND_CAP without busting
const HAND_CAP = QUANTUM_POKER_HANDS_PER_TUNNEL;

/** Pause between matches (ms). */
const NEXT_MATCH_MS = 1200;
/** Brief delay before the on-load auto-start so the window/table mounts first. */
const AUTO_START_DELAY_MS = 300;
/** Seconds the human has to act on take-over before the turn auto-checks (else folds). */
const TURN_SECONDS = 10;
/** Per-move pacing while a human is at the table, so the run-out is watchable (not instant). */
const MANUAL_PACE_MS = 320;
/** Idle poll cadence while parked waiting for the human to act. */
const POLL_MS = 110;

export type AutoStatus = "idle" | "funding" | "running" | "ended" | "error";

export interface QuantumPokerAutoSession {
  status: AutoStatus;
  personas: { a: string; b: string } | null;
  score: { a: number; b: number };
  tunnels: number;
  actions: number;
  /** Cumulative hands dealt across all tunnels this run. */
  hands: number;
  balances: { a: bigint; b: bigint };
  funded: boolean;
  canFundFromWallet: boolean;
  error: string | null;
  /** Live poker table state (null before the first tunnel opens). */
  state: PokerState | null;
  /** Party A hole cards to display (both shown in auto/spectator mode). */
  holesA: number[];
  /** Party B hole cards to display. */
  holesB: number[];
  /** True when a human is playing seat A (take-over / live); false = bot-vs-bot attract. */
  manual: boolean;
  /** During take-over, true = a bot auto-plays seat A for the human (the 🤖 Auto toggle). */
  autoSeat: boolean;
  /** Legal betting options for seat A, non-null only when it's the human's turn to act. */
  legal: PokerLegalActions | null;
  /** Seconds left on the human's turn timer (null when it isn't the player's turn). */
  secondsLeft: number | null;
  /** Hover-freeze latch state (attract only). */
  paused: boolean;
  /** Faucet-fund both bots (testnet). */
  fund: () => void;
  /** Fund both bots 0.1 SUI each from the connected wallet (one approval). */
  fundFromWallet: () => void;
  /** Begin a continuous bot-vs-bot run; personas are random per tunnel. */
  startAuto: () => void;
  /** Stop looping; the current match finishes, then no new one starts. */
  stopAuto: () => void;
  /** Hand seat A to the human at the next hand boundary (the in-flight hand finishes bot-driven). */
  takeOver: () => void;
  /** Return seat A to the bot (back to attract); the tunnel keeps recycling. */
  returnHome: () => void;
  /** During take-over, hand seat A to a bot (on) or take it back (off) — the 🤖 Auto toggle. */
  setAutoSeat: (on: boolean) => void;
  /** Queue the human's betting move (consumed by the play loop). */
  act: (move: PokerMove) => void;
  /** Hover-freeze the attract loop (latch). */
  pause: () => void;
  /** Unfreeze the attract loop. */
  resume: () => void;
  /** Back to the setup screen, clearing the scoreboard. */
  reset: () => void;
}

interface AutoDeps {
  report: TelemetryWriter;
  /** dapp-kit SuiClient (testnet) — reads + signs the bots' own txs. */
  client: unknown;
  /** Connected wallet address, or null when no wallet is connected. */
  account: { address: string } | null;
  /** Sign + execute a tx with the connected wallet (for wallet funding). */
  walletSignExec: SignExec;
}

/** The slice of SuiClient used to submit a bot-signed tx. */
interface SignClient {
  signAndExecuteTransaction(input: {
    signer: unknown;
    transaction: unknown;
    options?: { showEffects?: boolean };
  }): Promise<{
    digest: string;
    effects?: { status?: { status?: string; error?: string } };
  }>;
  waitForTransaction(input: { digest: string }): Promise<unknown>;
}

interface AutoSnapshot {
  status: AutoStatus;
  personas: { a: string; b: string } | null;
  score: { a: number; b: number };
  tunnels: number;
  actions: number;
  /** Cumulative hands dealt across all tunnels this run. */
  hands: number;
  balances: { a: bigint; b: bigint };
  funded: boolean;
  canFundFromWallet: boolean;
  error: string | null;
  state: PokerState | null;
  holesA: number[];
  holesB: number[];
  manual: boolean;
  autoSeat: boolean;
  legal: PokerLegalActions | null;
  secondsLeft: number | null;
  paused: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A continuous, ON-CHAIN bot-vs-bot run, kept OUT of React so it survives the
 * window unmounting (minimize / maximize / desktop reflow). Two persistent bot
 * accounts are funded once (faucet) and then SELF-SIGN every match — open + fund
 * a fresh tunnel, play off-chain with random personas, cooperative close — so
 * the loop never waits on the player's wallet. It keeps a running scoreboard and
 * stops when a bot is low on gas, or when the user stops it. Bot A signs the
 * on-chain txs (so it pays the gas).
 * See `lib/windowSessions`, `./bots`, ADR 0003.
 */
class AutoSession {
  deps: AutoDeps | null = null;

  private readonly bots = loadOrCreateQuantumPokerBots();

  private status: AutoStatus = "idle";
  // Guards the one-shot auto-start on window load, so a user Stop is never overridden by a remount.
  private didAutoStart = false;
  private personas: { a: string; b: string } | null = null;
  private score = { a: 0, b: 0 };
  private tunnels = 0;
  private actions = 0;
  private hands = 0;
  private error: string | null = null;
  private balances = { a: 0n, b: 0n };
  private snap: AutoSnapshot = {
    status: "idle",
    personas: null,
    score: { a: 0, b: 0 },
    tunnels: 0,
    actions: 0,
    hands: 0,
    balances: { a: 0n, b: 0n },
    funded: false,
    canFundFromWallet: false,
    error: null,
    state: null,
    holesA: [],
    holesB: [],
    manual: false,
    autoSeat: false,
    legal: null,
    secondsLeft: null,
    paused: false,
  };
  private listeners = new Set<() => void>();
  private balancesLoaded = false;

  private tunnel: PokerTunnel | null = null;
  private txnId = 0;

  private auto = false;
  // Take-over sub-mode: true = a bot auto-plays the human's seat A (🤖 Auto); false = the human plays.
  private autoSeat = false;
  private stage: "opening" | "playing" | "settling" = "opening";

  // Take-over mode: false = bot plays seat A (attract); true = a human plays seat A (live). The
  // tunnel stays selfPlay either way — the human's moves are co-signed as seat A's bot key (ADR-0012).
  private manual = false;
  // Take-over requested; flips `manual=true` at the next hand boundary so the in-flight hand finishes
  // bot-driven (the human starts the NEXT hand).
  private takeoverPending = false;
  // The hand number at which take-over was requested; `manual` latches once handNo advances past it.
  private takeoverFromHand: bigint | null = null;
  // Hover-freeze latch (attract only — when live the shell is inert, so pause is a no-op there).
  private paused = false;
  // The human's queued betting move, consumed by the play loop and then cleared.
  private pendingMove: PokerMove | null = null;
  // Human turn timer: counts down from TURN_SECONDS while it's the player's turn; at 0 it auto-checks
  // (else folds) so an idle player can't stall the hand. `secondsLeft` is null when it isn't our turn.
  private secondsLeft: number | null = null;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private turnTick: ReturnType<typeof setInterval> | null = null;

  private nextTimer: ReturnType<typeof setTimeout> | null = null;
  // Bumped on reset/dispose so an in-flight loop knows to abandon ship.
  private gen = 0;
  // Set by stopAuto (Back/Stop): the loop breaks out of play, settles THIS tunnel (fire-and-forget
  // via the backend), then stops without reopening. Unlike `gen`, it lets the close go through.
  private stopRequested = false;
  private session: RegisterSessionResult | null = null;
  private heartbeatActions = 0;
  private lastHeartbeatAt = 0;
  private moveCount = 0;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): AutoSnapshot => this.snap;

  private get funded(): boolean {
    // MTPS mode: bot gas is sponsored and the stake is faucet-minted MTPS, so the bots
    // need no SUI — they're always "funded". SUI fallback still gates on a real gas balance.
    if (isMtpsConfigured) return true;
    // Self-play: bot A funds both seats, so only bot A needs SUI. Bot B accrues winnings.
    return this.balances.a >= MIN_PLAY_MIST;
  }

  private emit() {
    const state = this.tunnel?.state ?? null;
    // Seat A (the human when manual) always shows its own holes. Seat B stays HIDDEN in manual mode
    // until showdown (only `shownHoleB` is revealed) — a human must not see the bot's cards live; in
    // attract both seats are shown (spectator view).
    const holesA = this.manual
      ? (state?.holeA ?? state?.shownHoleA ?? [])
      : (state?.holeA ?? []);
    const holesB = this.manual
      ? (state?.shownHoleB ?? [])
      : (state?.holeB ?? []);
    this.snap = {
      status: this.status,
      personas: this.personas,
      score: { ...this.score },
      tunnels: this.tunnels,
      actions: this.actions,
      hands: this.hands,
      balances: { ...this.balances },
      funded: this.funded,
      canFundFromWallet: this.deps?.account != null,
      error: this.error,
      state,
      holesA,
      holesB,
      manual: this.manual,
      autoSeat: this.autoSeat,
      legal:
        this.manual && !this.autoSeat && state && isHumanBettingTurn(state, "A")
          ? legalPokerActions(state, "A")
          : null,
      secondsLeft: this.secondsLeft,
      paused: this.paused,
    };
    for (const l of this.listeners) l();
  }

  private setStatus(s: AutoStatus) {
    this.status = s;
    this.emit();
  }

  private fail(e: unknown) {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.auto = false;
    this.deps?.report.setActive(0);
    this.emit();
  }

  private clearNext() {
    if (this.nextTimer !== null) {
      clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }
  }

  /** Emit the current session state to subscribers. */
  private pushView() {
    this.emit();
  }

  private botSignExec(bot: QuantumPokerBot): SignExec {
    const client = this.deps?.client as SignClient;
    return async (tx) => {
      const r = await client.signAndExecuteTransaction({
        signer: bot.keypair,
        transaction: tx,
        options: { showEffects: true },
      });
      if (r.effects?.status?.status && r.effects.status.status !== "success") {
        throw new Error(
          `tx ${r.digest} failed: ${r.effects.status.error ?? "unknown"}`,
        );
      }
      await client.waitForTransaction({ digest: r.digest });
      return { digest: r.digest };
    };
  }

  /** Gas-sponsored signer for a bot keypair (MTPS mode): the settler pays gas, so the bot
   *  needs zero SUI — it only signs. */
  private botSponsoredSignExec(bot: QuantumPokerBot): SignExec {
    return makeKeypairSponsoredSignExec({
      address: bot.address,
      keypair: bot.keypair,
      client: this.deps?.client as never,
    });
  }

  refreshBalances = async () => {
    const client = this.deps?.client;
    if (!client) return;
    try {
      this.balances = await botBalances(client as BotReadClient, this.bots);
      this.balancesLoaded = true;
      this.emit();
    } catch {
      /* balance reads are best-effort */
    }
  };

  /** Read balances once when the window first mounts (so the setup screen is accurate). */
  ensureBalances = () => {
    if (!this.balancesLoaded) void this.refreshBalances();
  };

  fund = () => {
    const client = this.deps?.client;
    if (!client || this.status === "funding" || this.status === "running")
      return;
    this.error = null;
    this.setStatus("funding");
    void (async () => {
      try {
        await fundBotAFromFaucet(client as BotReadClient, this.bots);
        await this.refreshBalances();
        this.setStatus("idle");
      } catch (e) {
        this.fail(e);
      }
    })();
  };

  fundFromWallet = () => {
    const deps = this.deps;
    if (
      !deps?.client ||
      !deps.account ||
      this.status === "funding" ||
      this.status === "running"
    )
      return;
    this.error = null;
    this.setStatus("funding");
    void (async () => {
      try {
        const { digest } = await deps.walletSignExec(
          buildFundBotATx(this.bots),
        );
        await (
          deps.client as {
            waitForTransaction(i: { digest: string }): Promise<unknown>;
          }
        ).waitForTransaction({ digest });
        await this.refreshBalances();
        this.setStatus("idle");
      } catch (e) {
        this.fail(e);
      }
    })();
  };

  startAuto = () => {
    if (this.status === "running" || this.status === "funding") return;
    if (!this.funded) {
      this.error = "Fund both bots first";
      this.setStatus("error");
      return;
    }
    this.gen += 1;
    this.stopRequested = false;
    this.clearNext();
    this.error = null;
    this.auto = true;
    this.score = { a: 0, b: 0 };
    this.tunnels = 0;
    this.actions = 0;
    this.hands = 0;
    this.personas = null;
    this.setStatus("running");
    void this.runMatch();
  };

  /** Start the loop once when the window first loads — watch-bot runs without a manual Start. No-op
   *  after the first auto-start (so a user Stop is not re-overridden on a later remount), while
   *  funding, or while already running. In MTPS mode `funded` is always true. */
  autoStartOnLoad = () => {
    if (this.didAutoStart || this.status !== "idle" || !this.funded) return;
    // Gate auto-start behind a connected wallet: the bots self-fund (faucet + sponsored gas) and
    // never spend the user's coins, but auto-opening sponsored tunnels on every bare page load would
    // burn backend gas with no user in the loop. Require a wallet connect first, like every other
    // game; once connected, the hook effect re-fires and this proceeds. (Manual Start is unaffected.)
    if (!this.deps?.account) return;
    this.didAutoStart = true;
    // Brief delay so the window/table mounts first. Stored in nextTimer so stop/reset/dispose cancel
    // it (via clearNext) if the window closes within the delay.
    this.clearNext();
    this.nextTimer = setTimeout(() => {
      this.nextTimer = null;
      this.startAuto();
    }, AUTO_START_DELAY_MS);
  };

  stopAuto = () => {
    // Fire-and-forget CLOSE: signal the loop to finish the current tunnel — it leaves play, fires the
    // cooperative settle (the backend queues/processes the HTTP), then stops (auto=false → no reopen).
    // The settle runs in the background store, so the user Backs out immediately without a stranded
    // open tunnel. (reset/dispose still bump `gen` to hard-abandon; this one lets the close through.)
    this.stopRequested = true;
    this.auto = false;
    this.clearNext();
    this.endRun();
  };

  /** Request take-over: the human takes seat A at the next hand boundary (the in-flight hand finishes
   *  bot-driven). Records the current handNo; the loop flips `manual=true` once handNo advances past
   *  it. Unfreezes a hover-pause so the loop resumes and can latch the take-over. */
  takeOver = () => {
    if (!this.manual) {
      this.takeoverPending = true;
      this.takeoverFromHand = this.tunnel?.state.handNo ?? null;
    }
    this.resume();
  };

  /** Return seat A to the bot (back to attract). The tunnel keeps recycling — take-over is cosmetic, so
   *  the channel is never abandoned. */
  returnHome = () => {
    this.manual = false;
    this.autoSeat = false;
    this.takeoverPending = false;
    this.takeoverFromHand = null;
    this.pendingMove = null;
    this.clearTurn();
    this.emit();
  };

  /** During take-over, hand seat A to a bot (on) or take it back (off). The tunnel is untouched —
   *  only who supplies seat A's moves flips. Switching to the bot drops any half-armed human turn. */
  setAutoSeat = (on: boolean) => {
    if (!this.manual || this.autoSeat === on) return;
    this.autoSeat = on;
    if (on) {
      this.pendingMove = null;
      this.clearTurn();
    }
    this.emit();
  };

  /** Queue the human's betting move (consumed by the play loop). No-op in attract. */
  act = (move: PokerMove) => {
    if (!this.manual || this.autoSeat) return;
    this.pendingMove = move;
    this.clearTurn();
  };

  pause = () => {
    this.paused = true;
    this.emit();
  };

  resume = () => {
    this.paused = false;
    this.emit();
  };

  /** Arm the per-turn countdown for the human's seat. At 0 the turn auto-checks if legal (else
   *  folds) by queueing the move; the loop then applies it. */
  private armTurn() {
    if (this.secondsLeft !== null) return; // already armed for this turn
    this.secondsLeft = TURN_SECONDS;
    this.emit();
    this.turnTick = setInterval(() => {
      this.secondsLeft = this.secondsLeft != null ? this.secondsLeft - 1 : null;
      this.emit();
    }, 1000);
    this.turnTimer = setTimeout(() => {
      if (!this.manual || !this.tunnel) return;
      const legal = legalPokerActions(this.tunnel.state, "A");
      this.pendingMove = legal.canCheck ? { kind: "check" } : { kind: "fold" };
      this.clearTurn();
    }, TURN_SECONDS * 1000);
  }

  private clearTurn() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    if (this.turnTick) {
      clearInterval(this.turnTick);
      this.turnTick = null;
    }
    this.secondsLeft = null;
  }

  reset = () => {
    this.gen += 1;
    this.stopRequested = false;
    this.clearNext();
    this.clearTurn();
    this.auto = false;
    this.manual = false;
    this.autoSeat = false;
    this.takeoverPending = false;
    this.takeoverFromHand = null;
    this.pendingMove = null;
    this.paused = false;
    this.tunnel = null;
    this.personas = null;
    this.score = { a: 0, b: 0 };
    this.tunnels = 0;
    this.actions = 0;
    this.hands = 0;
    this.deps?.report.setActive(0);
    this.status = "idle";
    this.error = null;
    this.emit();
    void this.refreshBalances();
  };

  dispose = () => {
    this.gen += 1;
    this.clearNext();
    this.clearTurn();
    this.auto = false;
    this.manual = false;
    this.deps?.report.setActive(0);
    this.tunnel = null;
    this.listeners.clear();
  };

  private endRun() {
    this.auto = false;
    this.deps?.report.setActive(0);
    this.pushView();
    this.setStatus("ended");
  }

  private flushHeartbeat(tunnelId: string, force: boolean) {
    const session = this.session;
    if (!session || this.heartbeatActions === 0) return;
    const now = Date.now();
    const windowMs = now - this.lastHeartbeatAt;
    if (!force && windowMs < 1000) return;
    const actionsDelta = this.heartbeatActions;
    this.heartbeatActions = 0;
    this.lastHeartbeatAt = now;
    // Same count, locally: feed the per-game TPS chip its real rate when no backend is connected.
    this.deps?.report.recordActions(actionsDelta);
    getControlPlaneClient()
      .sendHeartbeat(session.sessionId, session.statsToken, {
        tunnelId,
        nonce: String(this.moveCount),
        actionsDelta,
        windowMs: Math.max(1, windowMs),
      })
      .catch((e) => console.error("[poker auto] heartbeat failed:", e));
  }

  /** Open + fund a fresh tunnel (bot A signs), play it off-chain, settle, then loop or stop. */
  private runMatch = async () => {
    const myGen = this.gen;
    if (!this.deps?.client) {
      this.fail("no Sui client available");
      return;
    }
    this.tunnels += 1;
    this.stage = "opening";
    this.pushView();

    // Random personas per tunnel.
    const personaA = randomPokerPersona(Math.random);
    const personaB = randomPokerPersona(Math.random);
    this.personas = { a: personaA.name, b: personaB.name };
    const botA: PokerSeatBot = makeSeatBot(
      "A",
      STAKE,
      HAND_CAP,
      personaA,
      LIVE_BOT_CONTEXT,
    );
    const botB: PokerSeatBot = makeSeatBot(
      "B",
      STAKE,
      HAND_CAP,
      personaB,
      LIVE_BOT_CONTEXT,
    );

    const reads = this.deps.client as unknown as Parameters<
      typeof openAndFundSelfPlay
    >[0]["reads"];

    // MTPS mode: stake faucet-minted MTPS and sponsor the bot's open/close gas (no SUI).
    // SUI fallback (MTPS env unset): the bot funds the stake and pays its own gas.
    const mtpsOn = isMtpsConfigured;
    const stakePerSeat = mtpsOn ? MTPS_PER_SEAT : STAKE;
    const coinType = mtpsOn ? MTPS_COIN_TYPE : undefined;

    try {
      // ADR-0013: the autonomous bot A is the tx sender, so withdraw the stake from BOT A's
      // address balance (top it up first). Withdrawals don't pin a coin version → concurrent
      // bot opens across games never equivocate.
      if (mtpsOn && isMtpsAddressBalance)
        await ensureMtpsAddressBalance({
          client: this.deps.client as never,
          signExec: this.botSponsoredSignExec(this.bots.A),
          owner: this.bots.A.address,
          need: 2n * stakePerSeat,
        });
      const tunnelId = await openAndFundSelfPlay({
        reads,
        signExec: mtpsOn
          ? this.botSponsoredSignExec(this.bots.A)
          : this.botSignExec(this.bots.A),
        partyA: {
          address: this.bots.A.address,
          publicKey: this.bots.A.publicKey,
        },
        partyB: {
          address: this.bots.B.address,
          publicKey: this.bots.B.publicKey,
        },
        aAmount: stakePerSeat,
        bAmount: stakePerSeat,
        coinType,
        // Self-play funds both seats from one source, so withdraw/faucet for the 2-seat total.
        ...(mtpsOn
          ? isMtpsAddressBalance
            ? {
                stakeFromBalance: {
                  amount: 2n * stakePerSeat,
                  coinType: MTPS_COIN_TYPE,
                },
              }
            : {
                stakeCoinId: await ensureMtpsStakeCoin({
                  client: this.deps.client as never,
                  signExec: this.botSponsoredSignExec(this.bots.A),
                  owner: this.bots.A.address,
                  need: 2n * stakePerSeat,
                }),
              }
          : {}),
      });
      if (this.gen !== myGen) return;

      const createdAt = await readCreatedAt(reads, tunnelId);
      if (this.gen !== myGen) return;

      const transcript = new Transcript(tunnelId);
      const tunnel: PokerTunnel = OffchainTunnel.selfPlay(
        new QuantumPokerProtocol(HAND_CAP),
        tunnelId,
        this.bots.A.coreKey,
        this.bots.B.coreKey,
        this.bots.A.address,
        this.bots.B.address,
        { a: stakePerSeat, b: stakePerSeat },
      );
      tunnel.onUpdate = (u) => {
        transcript.append(u);
      };
      this.tunnel = tunnel;
      this.deps.report.bumpCounters({ tunnelsOpened: 1 });
      this.deps.report.setActive(2);

      this.stage = "playing";
      this.pushView();

      // Register session for heartbeat (best-effort).
      this.session = null;
      this.heartbeatActions = 0;
      this.lastHeartbeatAt = Date.now();
      this.moveCount = 0;
      try {
        this.session = await getControlPlaneClient().registerSession({
          userAddress: this.deps?.account?.address ?? this.bots.A.address,
          game: "quantum-poker",
          tunnels: [
            {
              tunnelId,
              partyA: this.bots.A.address,
              partyB: this.bots.B.address,
            },
          ],
        });
      } catch (e) {
        console.error("[poker auto] registerSession failed:", e);
      }

      let ts = 1n;
      let pending = 0;
      let lastFlush = Date.now();
      // Frame budget: step moves synchronously, then render + yield once per budget. 16ms ≈ one
      // 60Hz display frame — the smoothest a standard screen can show, so dropping below it (e.g.
      // battleship's 8ms) only burns extra renders the monitor never paints, costing TPS for no
      // visible gain. At 16ms the watch-bot repaints smoothly instead of in 80ms jerks while keeping
      // render overhead low. Only the local render + counter batch run per budget; the network
      // heartbeat self-throttles to ≤1/s (flushHeartbeat), so a tight budget never floods the backend.
      const FLUSH_MS = 16;
      const flush = async () => {
        if (pending > 0) {
          this.deps?.report.bumpCounters({
            updates: pending,
            signatures: pending * 2,
            verifications: pending * 2,
          });
          pending = 0;
        }
        this.flushHeartbeat(tunnelId, false);
        this.pushView();
        await sleep(0);
        lastFlush = Date.now();
      };
      let prevHandNo = tunnel.state.handNo;
      // One "My Activity" row per finished hand (mirroring blackjack's per-round rows). A hand
      // settles its net into balanceA at `hand_over` (bets ride in totalBet until then), so the
      // delta since the last hand is this hand's result from seat A's perspective — the seat a
      // human takes over. `prevHandPhase` makes the push fire once, on the transition INTO hand_over.
      let prevHandPhase = tunnel.state.phase;
      let prevHandBalanceA = tunnel.state.balanceA;
      while (tunnel.state.phase !== "done") {
        if (this.gen !== myGen) return;
        if (this.stopRequested) break; // Back/Stop → leave play, settle this tunnel below, then stop
        // Hover-freeze (attract only — when live the shell is inert, so the latch is ignored). Hold
        // here without tearing down the loop; keep the heartbeat/view alive while parked.
        while (
          this.paused &&
          !this.manual &&
          this.gen === myGen &&
          !this.stopRequested
        ) {
          this.flushHeartbeat(tunnelId, true);
          this.pushView();
          await sleep(90);
        }
        if (this.gen !== myGen) return;
        if (this.stopRequested) break;
        // Take-over latches at the hand boundary: the in-flight bot-driven hand finishes, then the human
        // takes seat A from the NEXT hand (handNo has advanced past the value recorded in takeOver()).
        if (
          this.takeoverPending &&
          (this.takeoverFromHand === null ||
            tunnel.state.handNo > this.takeoverFromHand)
        ) {
          this.manual = true;
          this.takeoverPending = false;
          this.takeoverFromHand = null;
          this.deps?.report.setActive(1);
          this.pushView();
        }
        if (this.manual && !this.autoSeat) {
          const step = stepPokerWithHuman(tunnel, botA, botB, "A", ts);
          if (step.kind === "await-human") {
            // Park for the human: arm the countdown and poll until act() (or the timer) queues a move.
            // CRUCIAL: do NOT bump `ts` and do NOT count an action here — no move was applied. The same
            // timestamp is reused once the human's move lands below.
            if (this.pendingMove === null) {
              this.armTurn();
              this.pushView();
              await sleep(POLL_MS);
              continue;
            }
            applyHumanMove(tunnel, botA, "A", this.pendingMove, ts++);
            this.pendingMove = null;
            this.clearTurn();
          } else if (step.kind === "idle") {
            break; // terminal
          } else {
            // A non-betting/bot move was applied (commit/reveal/next_hand or seat B). stepPokerWithHuman
            // consumed `ts` internally for the applied step, so advance it here to match.
            ts++;
          }
        } else {
          // Attract, or take-over with 🤖 Auto on — a bot drives seat A (and seat B).
          const r = stepPokerAuto(tunnel, botA, botB, ts++);
          if (!r) break;
        }
        this.actions += 1;
        this.moveCount += 1;
        this.heartbeatActions += 1;
        pending += 1;
        const hn = tunnel.state.handNo;
        if (hn > prevHandNo) {
          this.hands += Number(hn - prevHandNo);
          prevHandNo = hn;
        }
        if (
          tunnel.state.phase === "hand_over" &&
          prevHandPhase !== "hand_over"
        ) {
          const delta = tunnel.state.balanceA - prevHandBalanceA;
          prevHandBalanceA = tunnel.state.balanceA;
          this.deps?.report.pushLocalTxn({
            id: ++this.txnId,
            game: "quantum-poker",
            time: new Date().toLocaleTimeString("en-GB"),
            bot: this.manual
              ? "You"
              : `${this.personas?.a ?? "Bot A"} vs ${this.personas?.b ?? "Bot B"}`,
            type: delta > 0n ? "Poker Win" : delta < 0n ? "Poker Loss" : "Push",
            status: "Success",
            amount: delta > 0n ? `+${delta}` : delta < 0n ? `${delta}` : "0",
          });
        }
        prevHandPhase = tunnel.state.phase;
        // Watchable pacing only while a human actually plays the seat; attract — and Auto, where a bot
        // drives the seat — stay on the 16ms render-throttle, i.e. full watch-bots speed.
        if (this.manual && !this.autoSeat) await sleep(MANUAL_PACE_MS);
        if (Date.now() - lastFlush >= FLUSH_MS) await flush();
      }
      // Final flush — force the heartbeat so the last window is never dropped.
      if (pending > 0) {
        this.deps?.report.bumpCounters({
          updates: pending,
          signatures: pending * 2,
          verifications: pending * 2,
        });
        pending = 0;
      }
      this.flushHeartbeat(tunnelId, true);
      this.pushView();
      if (this.gen !== myGen) return;

      this.stage = "settling";
      this.pushView();
      this.deps.report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
      this.deps.report.setActive(0);
      // AWAIT the close before opening the next tunnel. The close and the next open share mutable
      // objects (the sponsor's gas coin, bot A's stake coins, the faucet), so running them
      // concurrently equivocates those objects — the sponsor then fails with "object … unavailable
      // for consumption (needs to be rebuilt)" and risks a 1/3-validator lock. Serializing avoids it.
      const settled = await settlePokerTunnel({
        tunnel,
        transcript,
        tunnelId,
        createdAt,
        coinType,
        fallbackSignExec: mtpsOn
          ? this.botSponsoredSignExec(this.bots.A)
          : this.botSignExec(this.bots.A),
      });
      // One "Settle" row per tunnel close on the Live Transactions feed — same shape as
      // tic-tac-toe/blackjack (id, digest, settler address, type "Settle"), plus the Walrus
      // proof poker uniquely produces. Per-hand results already went to My Activity above.
      this.deps?.report.pushTxn({
        id: ++this.txnId,
        game: "quantum-poker",
        digest: settled.txDigest,
        address: this.bots.A.address,
        proofUrl: settled.proofUrl ?? undefined,
        time: new Date().toLocaleTimeString("en-GB"),
        bot: this.bots.A.address,
        type: "Settle",
        status: "Success",
        amount: "",
      });
      if (this.gen !== myGen) return;

      await this.refreshBalances();
      if (this.gen !== myGen) return;

      this.bookMatch(myGen);
    } catch (e) {
      if (this.gen !== myGen) return;
      this.fail(e);
    }
  };

  /** Record the finished match's winner, then loop or stop. */
  private bookMatch(myGen: number) {
    const st = this.tunnel?.state;
    if (st && st.balanceA > st.balanceB) this.score.a += 1;
    else if (st && st.balanceB > st.balanceA) this.score.b += 1;
    // ties: no increment
    // The match settled: drop any queued human move and stop the turn timer so a stale act() can't
    // apply against the closed tunnel before the next match opens.
    this.pendingMove = null;
    this.clearTurn();
    this.pushView();

    if (!this.auto) {
      this.endRun();
      return;
    }
    // MTPS mode: gas is sponsored and the stake is faucet-minted, so the bots can't run out —
    // skip the SUI-gas gate that would otherwise end the run (their SUI balance is 0).
    if (!isMtpsConfigured && this.balances.a < MIN_PLAY_MIST) {
      this.endRun();
      return;
    }
    this.nextTimer = setTimeout(() => {
      if (this.gen === myGen && this.auto) void this.runMatch();
    }, NEXT_MATCH_MS);
  }
}

const autoSessions = new Map<string, AutoSession>();

function getAutoSession(windowId: string): AutoSession {
  let session = autoSessions.get(windowId);
  if (!session) {
    session = new AutoSession();
    autoSessions.set(windowId, session);
    const created = session;
    registerWindowDisposer(windowId, "quantum-poker-auto", () => {
      created.dispose();
      autoSessions.delete(windowId);
    });
  }
  return session;
}

export function useQuantumPokerAuto(windowId: string): QuantumPokerAutoSession {
  const { report } = useTelemetry();
  const client = useSuiClient();
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const session = getAutoSession(windowId);
  session.deps = {
    report,
    client,
    account,
    walletSignExec: (async (
      tx: Parameters<typeof signAndExecute>[0]["transaction"],
    ) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    }) as SignExec,
  };

  useEffect(() => {
    session.ensureBalances();
  }, [session, client]);

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);

  // Auto-start the bot loop on load (deps are wired above), so watch-bot runs without a manual Start.
  useEffect(() => {
    session.autoStartOnLoad();
  }, [session, snap.status, snap.funded, account?.address]);
  return {
    status: snap.status,
    personas: snap.personas,
    score: snap.score,
    tunnels: snap.tunnels,
    actions: snap.actions,
    hands: snap.hands,
    balances: snap.balances,
    funded: snap.funded,
    canFundFromWallet: snap.canFundFromWallet,
    error: snap.error,
    state: snap.state,
    holesA: snap.holesA,
    holesB: snap.holesB,
    manual: snap.manual,
    autoSeat: snap.autoSeat,
    legal: snap.legal,
    secondsLeft: snap.secondsLeft,
    paused: snap.paused,
    fund: session.fund,
    fundFromWallet: session.fundFromWallet,
    startAuto: session.startAuto,
    stopAuto: session.stopAuto,
    takeOver: session.takeOver,
    returnHome: session.returnHome,
    act: session.act,
    setAutoSeat: session.setAutoSeat,
    pause: session.pause,
    resume: session.resume,
    reset: session.reset,
  };
}
