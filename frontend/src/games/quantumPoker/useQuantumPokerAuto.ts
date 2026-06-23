import { useEffect, useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { QuantumPokerProtocol } from "sui-tunnel-ts/protocol/quantumPoker";
import type { PokerState } from "sui-tunnel-ts/protocol/quantumPoker";
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
  DOPAMINT_COIN_TYPE,
  ensureDopamintStakeCoin,
  isDopamintConfigured,
} from "@/onchain/dopamint";
import { QUANTUM_POKER_STAKE, QUANTUM_POKER_HANDS_PER_TUNNEL } from "./constants";
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
  LIVE_BOT_CONTEXT,
  type PokerSeatBot,
  type PokerTunnel,
} from "./pokerSelfPlay";
import { settlePokerTunnel } from "./pokerSettle";

const STAKE = QUANTUM_POKER_STAKE;
const DOPAMINT_PER_SEAT = 1_000_000_000n; // 1 DOPAMINT per seat (9 decimals)
const HAND_CAP = QUANTUM_POKER_HANDS_PER_TUNNEL;

/** Pause between matches (ms). */
const NEXT_MATCH_MS = 1200;

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
  /** Faucet-fund both bots (testnet). */
  fund: () => void;
  /** Fund both bots 0.1 SUI each from the connected wallet (one approval). */
  fundFromWallet: () => void;
  /** Begin a continuous bot-vs-bot run; personas are random per tunnel. */
  startAuto: () => void;
  /** Stop looping; the current match finishes, then no new one starts. */
  stopAuto: () => void;
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
  };
  private listeners = new Set<() => void>();
  private balancesLoaded = false;

  private tunnel: PokerTunnel | null = null;
  private txnId = 0;

  private auto = false;
  private stage: "opening" | "playing" | "settling" = "opening";

  private nextTimer: ReturnType<typeof setTimeout> | null = null;
  // Bumped on stop/reset/dispose so an in-flight loop knows to abandon ship.
  private gen = 0;
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
    // DOPAMINT mode: bot gas is sponsored and the stake is faucet-minted DOPAMINT, so the bots
    // need no SUI — they're always "funded". SUI fallback still gates on a real gas balance.
    if (isDopamintConfigured) return true;
    // Self-play: bot A funds both seats, so only bot A needs SUI. Bot B accrues winnings.
    return this.balances.a >= MIN_PLAY_MIST;
  }

  private emit() {
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
      state: this.tunnel?.state ?? null,
      holesA: this.tunnel?.state.holeA ?? [],
      holesB: this.tunnel?.state.holeB ?? [],
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

  /** Gas-sponsored signer for a bot keypair (DOPAMINT mode): the settler pays gas, so the bot
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
   *  funding, or while already running. In DOPAMINT mode `funded` is always true. */
  autoStartOnLoad = () => {
    if (this.didAutoStart || this.status !== "idle" || !this.funded) return;
    this.didAutoStart = true;
    this.startAuto();
  };

  stopAuto = () => {
    this.auto = false;
    this.clearNext();
    // Between matches (the next one is only scheduled, not opened): end now.
    if (this.status === "running" && this.stage !== "playing") {
      this.endRun();
    }
    this.pushView();
  };

  reset = () => {
    this.gen += 1;
    this.clearNext();
    this.auto = false;
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
    this.auto = false;
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

    // DOPAMINT mode: stake faucet-minted DOPAMINT and sponsor the bot's open/close gas (no SUI).
    // SUI fallback (DOPAMINT env unset): the bot funds the stake and pays its own gas.
    const dopamintOn = isDopamintConfigured;
    const stakePerSeat = dopamintOn ? DOPAMINT_PER_SEAT : STAKE;
    const coinType = dopamintOn ? DOPAMINT_COIN_TYPE : undefined;

    try {
      const tunnelId = await openAndFundSelfPlay({
        reads,
        signExec: dopamintOn
          ? this.botSponsoredSignExec(this.bots.A)
          : this.botSignExec(this.bots.A),
        partyA: { address: this.bots.A.address, publicKey: this.bots.A.publicKey },
        partyB: { address: this.bots.B.address, publicKey: this.bots.B.publicKey },
        aAmount: stakePerSeat,
        bAmount: stakePerSeat,
        coinType,
        // Self-play funds both seats from one coin, so faucet/select for the 2-seat total.
        stakeCoinId: dopamintOn
          ? await ensureDopamintStakeCoin({
              client: this.deps.client as never,
              signExec: this.botSponsoredSignExec(this.bots.A),
              owner: this.bots.A.address,
              need: 2n * stakePerSeat,
            })
          : undefined,
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
      this.deps.report.pushLocalTxn({
        id: ++this.txnId,
        game: "quantum-poker",
        time: new Date().toLocaleTimeString("en-GB"),
        bot: `${this.personas?.a ?? "Bot A"} vs ${this.personas?.b ?? "Bot B"}`,
        type: "open tunnel",
        status: "Success",
        amount: "",
      });

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
          tunnels: [{ tunnelId, partyA: this.bots.A.address, partyB: this.bots.B.address }],
        });
      } catch (e) {
        console.error("[poker auto] registerSession failed:", e);
      }

      let ts = 1n;
      let pending = 0;
      let lastFlush = Date.now();
      const FLUSH_MS = 80;
      const flush = async () => {
        if (pending > 0) {
          this.deps?.report.bumpCounters({ updates: pending, signatures: pending * 2, verifications: pending * 2 });
          pending = 0;
        }
        this.flushHeartbeat(tunnelId, false);
        this.pushView();
        await sleep(0);
        lastFlush = Date.now();
      };
      let prevHandNo = tunnel.state.handNo;
      while (tunnel.state.phase !== "done") {
        if (this.gen !== myGen) return;
        const r = stepPokerAuto(tunnel, botA, botB, ts++);
        if (!r) break;
        this.actions += 1;
        this.moveCount += 1;
        this.heartbeatActions += 1;
        pending += 1;
        const hn = tunnel.state.handNo;
        if (hn > prevHandNo) {
          this.hands += Number(hn - prevHandNo);
          prevHandNo = hn;
        }
        if (Date.now() - lastFlush >= FLUSH_MS) await flush();
      }
      // Final flush — force the heartbeat so the last window is never dropped.
      if (pending > 0) {
        this.deps?.report.bumpCounters({ updates: pending, signatures: pending * 2, verifications: pending * 2 });
        pending = 0;
      }
      this.flushHeartbeat(tunnelId, true);
      this.pushView();
      if (this.gen !== myGen) return;

      this.stage = "settling";
      this.pushView();
      this.deps.report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
      this.deps.report.setActive(0);
      const settled = await settlePokerTunnel({
        tunnel,
        transcript,
        tunnelId,
        createdAt,
        coinType,
        fallbackSignExec: dopamintOn
          ? this.botSponsoredSignExec(this.bots.A)
          : this.botSignExec(this.bots.A),
      });
      this.deps?.report.pushLocalTxn({
        id: ++this.txnId,
        game: "quantum-poker",
        time: new Date().toLocaleTimeString("en-GB"),
        bot: `${this.personas?.a ?? "Bot A"} vs ${this.personas?.b ?? "Bot B"}`,
        type: `settled · ${HAND_CAP} hands`,
        status: "Success",
        amount: settled.proofUrl ? "walrus ✓" : "closed",
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
    this.pushView();

    if (!this.auto) {
      this.endRun();
      return;
    }
    // DOPAMINT mode: gas is sponsored and the stake is faucet-minted, so the bots can't run out —
    // skip the SUI-gas gate that would otherwise end the run (their SUI balance is 0).
    if (!isDopamintConfigured && this.balances.a < MIN_PLAY_MIST) {
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

export function useQuantumPokerAuto(
  windowId: string,
): QuantumPokerAutoSession {
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
  }, [session, snap.status, snap.funded]);
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
    fund: session.fund,
    fundFromWallet: session.fundFromWallet,
    startAuto: session.startAuto,
    stopAuto: session.stopAuto,
    reset: session.reset,
  };
}
