import { useEffect, useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { otherParty } from "sui-tunnel-ts/protocol/Protocol";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import type { TelemetryWriter } from "../../telemetry/TelemetryProvider";
import {
  closeCooperativeWithRoot,
  openAndFundSelfPlay,
  readCreatedAt,
  type SignExec,
} from "../../onchain/tunnelTx";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { getControlPlaneClient } from "../../backend/controlPlane";
import { coSignedToSettleRequest } from "../../backend/settleRequest";
import { makeKeypairSponsoredSignExec } from "../../onchain/sponsor";
import {
  DOPAMINT_COIN_TYPE,
  ensureDopamintStakeCoin,
  isDopamintConfigured,
} from "../../onchain/dopamint";
import {
  BattleshipProtocol,
  type BattleshipMove,
  type BattleshipState,
} from "./protocol/battleship";
import {
  deriveBattleshipAutoView,
  type AutoEndReason,
  type AutoStage,
  type BattleshipAutoView,
} from "./view";
import {
  type Placement,
  placeFleetRandom,
  placementsToBoard,
} from "./engine/fleet";
import { randomSalts } from "./engine/merkle";
import { makeFleetSecret } from "./engine/selfPlay";
import { type BotDifficulty, DEFAULT_BOT_DIFFICULTY } from "./engine/bot";
import { createBattleshipKit } from "@/agent/games/battleship/kit";
import type { BotContext, GameBot } from "@/agent/gameKit";

/** A planning bot for one Battleship seat, from the canonical agent kit. */
type SeatBot = GameBot<BattleshipState, BattleshipMove>;
/** Live RNG context for kit bots (auto mode runs in real time, not a seeded replay). */
const LIVE_BOT_CONTEXT: BotContext = { rngForSeat: () => Math.random };
import {
  type BattleshipBot,
  type BotReadClient,
  MIN_PLAY_MIST,
  botBalances,
  buildFundBotsTx,
  fundBotsFromFaucet,
  loadOrCreateBattleshipBots,
} from "./engine/bots";

/** Coins locked per seat per match (refunded at close); the loser pays the winner this stake. */
const LOCKED_PER_SEAT = 500n; // SUI-fallback stake (MIST), when DOPAMINT env is unset
const DOPAMINT_PER_SEAT = 1_000_000_000n; // 1 DOPAMINT per seat (9 decimals)
const STAKE = 100n;
/** Spectator pacing per off-chain move, and the pause between matches. */
const SHOOT_MS = 300;
const REVEAL_MS = 120;
const COMMIT_MS = 80;
const NEXT_MATCH_MS = 1200;

export type AutoStatus = "idle" | "funding" | "running" | "ended" | "error";

export interface BattleshipAutoSession {
  status: AutoStatus;
  view: BattleshipAutoView | null;
  error: string | null;
  /** Both bots' on-chain gas balances (MIST). */
  balances: { a: bigint; b: bigint };
  /** True when both bots can cover another match. */
  funded: boolean;
  /** True when a wallet is connected and can fund the bots. */
  canFundFromWallet: boolean;
  /** Faucet-fund both bots (testnet). */
  fund: () => void;
  /** Fund both bots 0.1 SUI each from the connected wallet (one approval). */
  fundFromWallet: () => void;
  /** Begin a continuous bot-vs-bot run; loops until a bot is low on gas or stopped. */
  startAuto: (aDifficulty: BotDifficulty, bDifficulty: BotDifficulty) => void;
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
  view: BattleshipAutoView | null;
  error: string | null;
  balances: { a: bigint; b: bigint };
  funded: boolean;
  canFundFromWallet: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A continuous, ON-CHAIN bot-vs-bot run, kept OUT of React so it survives the
 * window unmounting (minimize / maximize / desktop reflow). Following the caro /
 * poker auto modes, two persistent bot accounts are funded once (faucet) and then
 * SELF-SIGN every match — open + fund a fresh tunnel, play off-chain, cooperative
 * close — so the loop never waits on the player's wallet. It keeps a running
 * scoreboard and stops when a bot is low on gas, or when the user stops it. Bot A
 * signs the on-chain txs (so it pays the gas), mirroring caro's bot X.
 * See `lib/windowSessions`, `engine/bots`, ADR 0003.
 */
class AutoSession {
  deps: AutoDeps | null = null;

  private readonly bots = loadOrCreateBattleshipBots();

  private status: AutoStatus = "idle";
  private view: BattleshipAutoView | null = null;
  private error: string | null = null;
  private balances = { a: 0n, b: 0n };
  private snap: AutoSnapshot = {
    status: "idle",
    view: null,
    error: null,
    balances: { a: 0n, b: 0n },
    funded: false,
    canFundFromWallet: false,
  };
  private listeners = new Set<() => void>();
  private balancesLoaded = false;

  private tunnel: OffchainTunnel<BattleshipState, BattleshipMove> | null = null;
  // Per-seat planning bots from the canonical agent kit (own their injected fleet secret).
  private botA: SeatBot | null = null;
  private botB: SeatBot | null = null;
  private aPlacements: Placement[] = [];
  private bPlacements: Placement[] = [];
  private aDifficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY;
  private bDifficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY;

  private auto = false;
  private stage: AutoStage = "opening";
  private score = { a: 0, b: 0 };
  private match = 0;
  private endReason: AutoEndReason | null = null;

  private txnId = 0;
  private lastShotByA: number | null = null;
  private lastShotByB: number | null = null;
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
    // DOPAMINT mode: bot gas is sponsored and the stake is faucet-minted DOPAMINT, so the bots
    // need no SUI — they're always "funded". SUI fallback still gates on a real gas balance.
    if (isDopamintConfigured) return true;
    return this.balances.a >= MIN_PLAY_MIST && this.balances.b >= MIN_PLAY_MIST;
  }

  private emit() {
    this.snap = {
      status: this.status,
      view: this.view,
      error: this.error,
      balances: { ...this.balances },
      funded: this.funded,
      canFundFromWallet: this.deps?.account != null,
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
  private pushView() {
    if (this.tunnel && this.botA && this.botB) {
      this.view = deriveBattleshipAutoView(
        this.tunnel.state,
        this.aPlacements,
        this.bPlacements,
        {
          lastShotByA: this.lastShotByA,
          lastShotByB: this.lastShotByB,
          onChain: true,
          auto: this.auto,
          stage: this.stage,
          score: { ...this.score },
          match: this.match,
          balance: { a: Number(this.balances.a), b: Number(this.balances.b) },
          endReason: this.endReason,
        },
      );
    }
    this.emit();
  }

  private botSignExec(bot: BattleshipBot): SignExec {
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
  private botSponsoredSignExec(bot: BattleshipBot): SignExec {
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

  startAuto = (aDifficulty: BotDifficulty, bDifficulty: BotDifficulty) => {
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
    this.match = 0;
    this.endReason = null;
    this.txnId = 0;
    this.aDifficulty = aDifficulty;
    this.bDifficulty = bDifficulty;
    this.setStatus("running");
    void this.runMatch();
  };

  stopAuto = () => {
    this.auto = false;
    this.clearNext();
    // Between matches (the next one is only scheduled, not opened): end now.
    if (this.status === "running" && this.stage !== "playing") {
      this.endRun("stopped");
    }
    this.pushView();
  };

  reset = () => {
    this.gen += 1;
    this.clearNext();
    this.auto = false;
    this.tunnel = null;
    this.botA = null;
    this.botB = null;
    this.lastShotByA = null;
    this.lastShotByB = null;
    this.score = { a: 0, b: 0 };
    this.match = 0;
    this.endReason = null;
    this.deps?.report.setActive(0);
    this.status = "idle";
    this.view = null;
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
    this.botA = null;
    this.botB = null;
    this.listeners.clear();
  };

  private endRun(reason: AutoEndReason) {
    this.auto = false;
    this.endReason = reason;
    this.deps?.report.setActive(0);
    this.pushView();
    this.setStatus("ended");
  }

  private reportShotTxn(
    move: Extract<BattleshipMove, { type: "reveal" }>,
    defender: "A" | "B",
  ) {
    const shooter = otherParty(defender);
    this.deps?.report.pushTxn({
      id: (this.txnId += 1),
      game: "battleship",
      time: new Date().toLocaleTimeString("en-GB"),
      bot: shooter === "A" ? "Bot A" : "Bot B",
      type: move.isShip ? "Hit" : "Miss",
      status: "Success",
      amount: move.isShip ? `$${Number(STAKE)}.00` : "$0.00",
    });
  }

  /** Open + fund a fresh tunnel (bot A signs), play it off-chain, settle, then loop or stop. */
  private runMatch = async () => {
    const myGen = this.gen;
    if (!this.deps?.client) {
      this.fail("no Sui client available");
      return;
    }
    this.match += 1;
    this.stage = "opening";
    this.pushView(); // reflect "Opening tunnel…" over the prior board (no-op on the first match)
    this.lastShotByA = null;
    this.lastShotByB = null;

    // The session owns both fleets (so the spectator view can reveal both boards) and injects each
    // into a canonical kit bot, which plans that seat's commit/reveal/shoot moves. See PR #28.
    this.aPlacements = placeFleetRandom(Math.random);
    this.bPlacements = placeFleetRandom(Math.random);
    const aSecret = makeFleetSecret(
      placementsToBoard(this.aPlacements),
      randomSalts(),
    );
    const bSecret = makeFleetSecret(
      placementsToBoard(this.bPlacements),
      randomSalts(),
    );
    this.botA = createBattleshipKit(STAKE, {
      difficulty: this.aDifficulty,
      secret: aSecret,
    }).createBot("A", LIVE_BOT_CONTEXT);
    this.botB = createBattleshipKit(STAKE, {
      difficulty: this.bDifficulty,
      secret: bSecret,
    }).createBot("B", LIVE_BOT_CONTEXT);

    const protocol = new BattleshipProtocol(STAKE);
    const reads = this.deps.client as unknown as Parameters<
      typeof openAndFundSelfPlay
    >[0]["reads"];

    // DOPAMINT mode: stake faucet-minted DOPAMINT and sponsor the bot's open/close gas (no SUI).
    // SUI fallback (DOPAMINT env unset): the bot funds the stake and pays its own gas.
    const dopamintOn = isDopamintConfigured;
    const stakePerSeat = dopamintOn ? DOPAMINT_PER_SEAT : LOCKED_PER_SEAT;
    const coinType = dopamintOn ? DOPAMINT_COIN_TYPE : undefined;

    try {
      const tunnelId = await openAndFundSelfPlay({
        reads,
        signExec: dopamintOn
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

      const tunnel = OffchainTunnel.selfPlay(
        protocol,
        tunnelId,
        this.bots.A.coreKey,
        this.bots.B.coreKey,
        this.bots.A.address,
        this.bots.B.address,
        { a: stakePerSeat, b: stakePerSeat },
      );
      // Record every co-signed update so the close can anchor the transcript root on-chain
      // (close_cooperative_with_root) — the same settle path caro/poker use successfully.
      const transcript = new Transcript(tunnelId);
      tunnel.onUpdate = (u, bytes) => {
        transcript.append(u);
        this.deps?.report.bumpCounters({
          updates: 1,
          signatures: 2,
          verifications: 2,
          bytes,
        });
      };
      this.tunnel = tunnel;
      this.deps.report.bumpCounters({ tunnelsOpened: 1 });
      this.deps.report.setActive(2);

      this.stage = "playing";
      this.pushView();
      await this.playMatch(myGen, tunnel);
      if (this.gen !== myGen) return;

      this.stage = "settling";
      this.pushView();
      this.deps.report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
      this.deps.report.setActive(0);
      // Settle through the backend /settle API: the server submits the close AND archives the
      // transcript to Walrus (ADR-0002/0005). Fall back to a direct bot-key close if it's down.
      const settlement = tunnel.buildSettlementWithRoot(
        createdAt,
        transcript.root(),
        0n,
      );
      try {
        await getControlPlaneClient().settle(
          tunnelId,
          coSignedToSettleRequest(settlement, transcript.toRecord().entries),
        );
      } catch (e) {
        console.error(
          "[battleship] backend settle failed; falling back to bot-key close:",
          e,
        );
        await closeCooperativeWithRoot({
          signExec: dopamintOn
            ? this.botSponsoredSignExec(this.bots.A)
            : this.botSignExec(this.bots.A),
          tunnelId,
          settlement,
          coinType,
        });
      }
      if (this.gen !== myGen) return;

      await this.refreshBalances();
      if (this.gen !== myGen) return;

      this.bookMatch(myGen);
    } catch (e) {
      if (this.gen !== myGen) return;
      this.fail(e);
    }
  };

  /** Drive every off-chain move for both seats until the match ends, via the kit bots. */
  private playMatch = async (
    myGen: number,
    tunnel: OffchainTunnel<BattleshipState, BattleshipMove>,
  ) => {
    const botA = this.botA;
    const botB = this.botB;
    if (!botA || !botB) return;
    while (true) {
      const st = tunnel.state;
      if (st.winner !== 0 || st.phase === "over") break;
      // Battleship is strictly turn/reveal ordered, so exactly one seat has a move; try A then B.
      let by: "A" | "B" = "A";
      let move = botA.plan(st);
      if (!move) {
        by = "B";
        move = botB.plan(st);
      }
      if (!move) break;

      if (move.type === "shoot") await sleep(SHOOT_MS);
      else if (move.type === "reveal") await sleep(REVEAL_MS);
      else await sleep(COMMIT_MS);
      if (this.gen !== myGen || this.tunnel !== tunnel) return;

      if (move.type === "shoot") {
        if (by === "A") this.lastShotByA = move.cell;
        else this.lastShotByB = move.cell;
      }
      tunnel.step(move, by);
      (by === "A" ? botA : botB).confirm(st, move);
      if (move.type === "reveal") this.reportShotTxn(move, by);
      this.pushView();
    }
  };

  /** Record the finished match's winner, then loop or stop. */
  private bookMatch(myGen: number) {
    const st = this.tunnel?.state;
    if (st?.winner === 1) this.score.a += 1;
    else if (st?.winner === 2) this.score.b += 1;
    this.pushView();

    if (!this.auto) {
      this.endRun("stopped");
      return;
    }
    // DOPAMINT mode: gas is sponsored and the stake is faucet-minted, so the bots can't run out —
    // skip the SUI-gas gate that would otherwise end the run (their SUI balance is 0).
    if (
      !isDopamintConfigured &&
      (this.balances.a < MIN_PLAY_MIST || this.balances.b < MIN_PLAY_MIST)
    ) {
      this.endRun("funds");
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
    registerWindowDisposer(windowId, "battleship-auto", () => {
      created.dispose();
      autoSessions.delete(windowId);
    });
  }
  return session;
}

export function useBattleshipAuto(windowId: string): BattleshipAutoSession {
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
    view: snap.view,
    error: snap.error,
    balances: snap.balances,
    funded: snap.funded,
    canFundFromWallet: snap.canFundFromWallet,
    fund: session.fund,
    fundFromWallet: session.fundFromWallet,
    startAuto: session.startAuto,
    stopAuto: session.stopAuto,
    reset: session.reset,
  };
}
