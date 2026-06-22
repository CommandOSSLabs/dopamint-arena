import { useEffect, useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { QuantumPokerProtocol } from "sui-tunnel-ts/protocol/quantumPoker";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import type { TelemetryWriter } from "../../telemetry/TelemetryProvider";
import {
  openAndFundSelfPlay,
  readCreatedAt,
  type SignExec,
} from "@/onchain/tunnelTx";
import { QUANTUM_POKER_STAKE, QUANTUM_POKER_HAND_CAP } from "./constants";
import {
  loadOrCreateQuantumPokerBots,
  botBalances,
  buildFundBotsTx,
  fundBotsFromFaucet,
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
const HAND_CAP = QUANTUM_POKER_HAND_CAP;

/** Spectator pacing per off-chain move (ms). */
const SPACE_MS = 60;
/** Pause between matches (ms). */
const NEXT_MATCH_MS = 1200;

export type AutoStatus = "idle" | "funding" | "running" | "ended" | "error";

export interface QuantumPokerAutoSession {
  status: AutoStatus;
  personas: { a: string; b: string } | null;
  score: { a: number; b: number };
  tunnels: number;
  actions: number;
  balances: { a: bigint; b: bigint };
  funded: boolean;
  canFundFromWallet: boolean;
  error: string | null;
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
  balances: { a: bigint; b: bigint };
  funded: boolean;
  canFundFromWallet: boolean;
  error: string | null;
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
  private personas: { a: string; b: string } | null = null;
  private score = { a: 0, b: 0 };
  private tunnels = 0;
  private actions = 0;
  private error: string | null = null;
  private balances = { a: 0n, b: 0n };
  private snap: AutoSnapshot = {
    status: "idle",
    personas: null,
    score: { a: 0, b: 0 },
    tunnels: 0,
    actions: 0,
    balances: { a: 0n, b: 0n },
    funded: false,
    canFundFromWallet: false,
    error: null,
  };
  private listeners = new Set<() => void>();
  private balancesLoaded = false;

  private tunnel: PokerTunnel | null = null;

  private auto = false;
  private stage: "opening" | "playing" | "settling" = "opening";

  private nextTimer: ReturnType<typeof setTimeout> | null = null;
  // Bumped on stop/reset/dispose so an in-flight loop knows to abandon ship.
  private gen = 0;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): AutoSnapshot => this.snap;

  private get funded(): boolean {
    return this.balances.a >= MIN_PLAY_MIST && this.balances.b >= MIN_PLAY_MIST;
  }

  private emit() {
    this.snap = {
      status: this.status,
      personas: this.personas,
      score: { ...this.score },
      tunnels: this.tunnels,
      actions: this.actions,
      balances: { ...this.balances },
      funded: this.funded,
      canFundFromWallet: this.deps?.account != null,
      error: this.error,
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
        await fundBotsFromFaucet(client as BotReadClient, this.bots);
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
          buildFundBotsTx(this.bots),
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
    this.personas = null;
    this.setStatus("running");
    void this.runMatch();
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

    try {
      const tunnelId = await openAndFundSelfPlay({
        reads,
        signExec: this.botSignExec(this.bots.A),
        partyA: { address: this.bots.A.address, publicKey: this.bots.A.publicKey },
        partyB: { address: this.bots.B.address, publicKey: this.bots.B.publicKey },
        aAmount: STAKE,
        bAmount: STAKE,
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
        { a: STAKE, b: STAKE },
      );
      tunnel.onUpdate = (u, bytes) => {
        transcript.append(u);
        this.deps?.report.bumpCounters({ updates: 1, signatures: 2, verifications: 2, bytes });
      };
      this.tunnel = tunnel;
      this.deps.report.bumpCounters({ tunnelsOpened: 1 });
      this.deps.report.setActive(2);

      this.stage = "playing";
      this.pushView();

      // Drive moves one step at a time, paced for spectator watchability.
      let ts = 1n;
      while (tunnel.state.phase !== "done") {
        if (this.gen !== myGen) return;
        const r = stepPokerAuto(tunnel, botA, botB, ts++);
        if (!r) break;
        this.actions += 1;
        this.pushView();
        await sleep(SPACE_MS);
      }
      if (this.gen !== myGen) return;

      this.stage = "settling";
      this.pushView();
      this.deps.report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
      this.deps.report.setActive(0);
      await settlePokerTunnel({
        tunnel,
        transcript,
        tunnelId,
        createdAt,
        fallbackSignExec: this.botSignExec(this.bots.A),
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
    if (this.balances.a < MIN_PLAY_MIST || this.balances.b < MIN_PLAY_MIST) {
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
  return {
    status: snap.status,
    personas: snap.personas,
    score: snap.score,
    tunnels: snap.tunnels,
    actions: snap.actions,
    balances: snap.balances,
    funded: snap.funded,
    canFundFromWallet: snap.canFundFromWallet,
    error: snap.error,
    fund: session.fund,
    fundFromWallet: session.fundFromWallet,
    startAuto: session.startAuto,
    stopAuto: session.stopAuto,
    reset: session.reset,
  };
}
