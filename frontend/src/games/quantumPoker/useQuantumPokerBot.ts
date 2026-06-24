import { useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import {
  useTelemetry,
  type TelemetryWriter,
} from "../../telemetry/TelemetryProvider";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import {
  QuantumPokerProtocol,
  type PokerMove,
  type PokerState,
} from "sui-tunnel-ts/protocol/quantumPoker";
import { registerWindowDisposer } from "@/lib/windowSessions";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "@/backend/controlPlane";
import {
  openAndFundSelfPlay,
  readCreatedAt,
  type SignExec,
  type SuiReads,
} from "@/onchain/tunnelTx";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import {
  DOPAMINT_COIN_TYPE,
  isDopamintAddressBalance,
  isDopamintConfigured,
} from "@/onchain/dopamint";
import {
  QUANTUM_POKER_STAKE,
  QUANTUM_POKER_HANDS_PER_TUNNEL,
} from "./constants";
import {
  makeSeatBot,
  randomPokerPersona,
  stepPokerWithHuman,
  applyHumanMove,
  legalPokerActions,
  LIVE_BOT_CONTEXT,
  type PokerSeatBot,
  type PokerTunnel,
  type PokerLegalActions,
} from "./pokerSelfPlay";
import { settlePokerTunnel } from "./pokerSettle";

const STAKE = QUANTUM_POKER_STAKE;
const HAND_CAP = QUANTUM_POKER_HANDS_PER_TUNNEL;
const AUTO_MS = 0; // instant bot/plumbing moves (no pacing)
/** Seconds the human has to act before the turn auto-checks (else folds). */
const TURN_SECONDS = 10;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type QuantumPokerBotStatus =
  | "idle"
  | "funding"
  | "playing"
  | "awaitHuman"
  | "settling"
  | "settled"
  | "error";

export interface QuantumPokerBotSession {
  status: QuantumPokerBotStatus;
  state: PokerState | null;
  humanHoles: number[];
  legal: PokerLegalActions | null;
  error: string | null;
  /** Seconds left on the human's turn timer (null when it isn't the player's turn to act). */
  secondsLeft: number | null;
  /** True when a bot is auto-playing the human's seat (party A). */
  auto: boolean;
  open: () => void;
  act: (move: PokerMove) => void;
  /** Settle the current tunnel early (cash out) — status moves to "settled" when done. */
  settleNow: () => void;
  /** Toggle bot auto-play of the human's seat: on → bot-vs-bot in the same tunnel; off → resume manual. */
  setAuto: (on: boolean) => void;
  /** Hand the human's seat to a bot on Back (alias for setAuto(true)) — the match plays on in the
   *  background until a seat busts → terminal settle. */
  handOffToBot: () => void;
  reset: () => void;
}

interface BotDeps {
  report: TelemetryWriter;
  account: { address: string } | null;
  client: unknown;
  signExec: SignExec;
  /** Gas-sponsored wallet signer (DOPAMINT model): settler pays gas, the wallet co-signs. */
  sponsoredSignExec: SignExec;
  /** Return a user `Coin<DOPAMINT>` object id holding at least `need` to fund the stake. */
  prepareStake: (need: bigint) => Promise<string>;
  /** ADR-0013: ensure the player's DOPAMINT address balance covers the stake. No-op once funded. */
  ensureStakeBalance: (need: bigint) => Promise<void>;
}

interface Snap {
  status: QuantumPokerBotStatus;
  state: PokerState | null;
  humanHoles: number[];
  legal: PokerLegalActions | null;
  error: string | null;
  secondsLeft: number | null;
  auto: boolean;
}

const HUMAN: "A" = "A";

class BotSession {
  deps: BotDeps | null = null;

  private status: QuantumPokerBotStatus = "idle";
  private error: string | null = null;
  private snap: Snap = {
    status: "idle",
    state: null,
    humanHoles: [],
    legal: null,
    error: null,
    secondsLeft: null,
    auto: false,
  };
  private listeners = new Set<() => void>();

  private tunnel: PokerTunnel | null = null;
  private transcript: Transcript | null = null;
  private botA: PokerSeatBot | null = null;
  private botB: PokerSeatBot | null = null;
  private txnId = 0;
  private oppName = "Bot";
  private tunnelId = "";
  private createdAt = 0n;
  /** Coin type `T` staked at open (DOPAMINT or SUI); reused by the on-chain fallback close. */
  private coinType: string | undefined = undefined;
  private ts = 1n;
  private gen = 0;
  private looping = false;
  // Self-play TPS heartbeat: send counts (never a rate); the backend derives windowed TPS. See
  // adding-a-tunnel-game.md "Reporting TPS". (PvP must NOT do this — the relay counts there.)
  private session: RegisterSessionResult | null = null;
  private heartbeatActions = 0;
  private moveCount = 0;
  private lastHeartbeatAt = 0;
  // Human turn timer: counts down from TURN_SECONDS while it's the player's turn; at 0 it auto-checks
  // (else folds) so an idle player can't stall the hand. `secondsLeft` is null when it isn't our turn.
  private secondsLeft: number | null = null;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private turnTick: ReturnType<typeof setInterval> | null = null;
  // Bot auto-play of party A: when on, the drive loop plays the human's seat with botA (bot-vs-bot in
  // the same tunnel) until a seat busts and the terminal settle closes the tunnel. Toggled by the
  // in-game Auto button or set on Back (handOffToBot).
  private auto = false;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  };
  getSnapshot = (): Snap => this.snap;

  private emit() {
    const s = this.tunnel?.state ?? null;
    this.snap = {
      status: this.status,
      state: s,
      // In self-play the tunnel state holds party A's local holeA directly.
      humanHoles: s ? (s.holeA ?? s.shownHoleA ?? []) : [],
      legal:
        this.status === "awaitHuman" && s ? legalPokerActions(s, HUMAN) : null,
      error: this.error,
      secondsLeft: this.secondsLeft,
      auto: this.auto,
    };
    for (const l of this.listeners) l();
  }

  private fail(e: unknown) {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }

  reset = () => {
    this.gen += 1;
    this.looping = false;
    this.auto = false;
    this.clearTurnTimer();
    this.tunnel = null;
    this.transcript = null;
    this.botA = null;
    this.botB = null;
    this.status = "idle";
    this.error = null;
    this.emit();
  };

  dispose = () => {
    this.gen += 1;
    this.looping = false;
    this.clearTurnTimer();
    this.listeners.clear();
  };

  /** Throttled self-play heartbeat: sends the action delta since last flush, never a rate. */
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
      .catch((e) => console.error("[poker bot] heartbeat failed:", e));
  }

  open = () => {
    const deps = this.deps;
    if (!deps) return;
    if (
      this.status !== "idle" &&
      this.status !== "settled" &&
      this.status !== "error"
    )
      return;
    if (!deps.account) {
      this.fail("connect a wallet to stake the tunnel");
      return;
    }
    this.gen += 1;
    const myGen = this.gen;
    this.auto = false;
    this.error = null;
    this.status = "funding";
    this.emit();

    void (async () => {
      try {
        const a = createParticipant("poker-you");
        const b = createParticipant("poker-foe");
        const reads = deps.client as unknown as SuiReads;
        // DOPAMINT mode: stake faucet-minted DOPAMINT and sponsor the wallet's open gas (the
        // connected wallet funds the stake but pays no gas). SUI fallback (env unset): the wallet
        // funds the stake and pays its own gas.
        const dopamintOn = isDopamintConfigured;
        // chips == raw stake (1:1), so a 5000 buy-in means a 5000-chip stack — same as PvP. Deep
        // enough to bet across streets without an early all-in (more off-chain actions per hand).
        const stakePerSeat = STAKE;
        const coinType = dopamintOn ? DOPAMINT_COIN_TYPE : undefined;
        const signExec = dopamintOn ? deps.sponsoredSignExec : deps.signExec;
        // ADR-0013: top up the player's DOPAMINT address balance, then the open withdraws from it
        // (no version-pinned coin → concurrent opens across games never equivocate).
        if (dopamintOn && isDopamintAddressBalance)
          await deps.ensureStakeBalance(2n * stakePerSeat);
        const tunnelId = await openAndFundSelfPlay({
          reads,
          signExec,
          partyA: { address: a.address, publicKey: a.keyPair.publicKey },
          partyB: { address: b.address, publicKey: b.keyPair.publicKey },
          aAmount: stakePerSeat,
          bAmount: stakePerSeat,
          coinType,
          // Self-play funds both seats from one source, so withdraw/faucet for the 2-seat total.
          ...(dopamintOn
            ? isDopamintAddressBalance
              ? {
                  stakeFromBalance: {
                    amount: 2n * stakePerSeat,
                    coinType: DOPAMINT_COIN_TYPE,
                  },
                }
              : { stakeCoinId: await deps.prepareStake(2n * stakePerSeat) }
            : {}),
        });
        if (this.gen !== myGen) return;
        const createdAt = await readCreatedAt(reads, tunnelId);
        if (this.gen !== myGen) return;

        const tunnel: PokerTunnel = OffchainTunnel.selfPlay(
          new QuantumPokerProtocol(HAND_CAP),
          tunnelId,
          a.keyPair,
          b.keyPair,
          a.address,
          b.address,
          { a: stakePerSeat, b: stakePerSeat },
        );
        const transcript = new Transcript(tunnelId);
        tunnel.onUpdate = (u) => transcript.append(u);

        this.tunnel = tunnel;
        this.transcript = transcript;
        this.tunnelId = tunnelId;
        this.createdAt = createdAt;
        this.coinType = coinType;
        this.ts = 1n;
        this.botA = makeSeatBot(
          "A",
          STAKE,
          HAND_CAP,
          randomPokerPersona(Math.random),
          LIVE_BOT_CONTEXT,
        );
        const oppProfile = randomPokerPersona(Math.random);
        this.oppName = oppProfile.name;
        this.botB = makeSeatBot(
          "B",
          STAKE,
          HAND_CAP,
          oppProfile,
          LIVE_BOT_CONTEXT,
        );
        this.deps?.report.pushLocalTxn({
          id: ++this.txnId,
          game: "quantum-poker",
          time: new Date().toLocaleTimeString("en-GB"),
          bot: `You vs ${this.oppName}`,
          type: "open tunnel",
          status: "Success",
          amount: "",
        });

        // Register the self-play session so the backend can derive live TPS from heartbeats.
        this.session = null;
        this.heartbeatActions = 0;
        this.moveCount = 0;
        this.lastHeartbeatAt = Date.now();
        try {
          this.session = await getControlPlaneClient().registerSession({
            userAddress: deps.account?.address ?? a.address,
            game: "quantum-poker",
            tunnels: [{ tunnelId, partyA: a.address, partyB: b.address }],
          });
        } catch (e) {
          console.error("[poker bot] registerSession failed:", e);
        }
        if (this.gen !== myGen) return;

        this.status = "playing";
        this.emit();
        void this.drive(myGen);
      } catch (e) {
        if (this.gen === myGen) this.fail(e);
      }
    })();
  };

  /** Auto-run moves until the human must act, the tunnel ends, or gen changes. */
  private drive = async (myGen: number) => {
    if (this.looping) return;
    this.looping = true;
    try {
      const tunnel = this.tunnel;
      const botA = this.botA;
      const botB = this.botB;
      if (!tunnel || !botA || !botB) return;
      while (this.gen === myGen) {
        const r = stepPokerWithHuman(tunnel, botA, botB, HUMAN, this.ts++);
        if (r.kind === "await-human") {
          if (this.auto) {
            // Auto-play on: botA makes party A's betting move, then the loop keeps stepping toward
            // the showdown/bust — no turn timer, no waiting for a human.
            const move = botA.plan(tunnel.state);
            if (move) {
              applyHumanMove(tunnel, botA, HUMAN, move, this.ts++);
              this.heartbeatActions += 1;
              this.moveCount += 1;
              this.flushHeartbeat(this.tunnelId, false);
              this.emit();
              await sleep(AUTO_MS);
              continue;
            }
          }
          this.status = "awaitHuman";
          this.startTurnTimer(); // arms the countdown and emits
          return;
        }
        if (r.kind === "idle") break; // terminal
        // r.kind === "applied": one verified self-play step → count it for TPS.
        this.heartbeatActions += 1;
        this.moveCount += 1;
        this.flushHeartbeat(this.tunnelId, false);
        this.emit();
        await sleep(AUTO_MS);
      }
      if (this.gen === myGen) await this.settle(myGen);
    } catch (e) {
      if (this.gen === myGen) this.fail(e);
    } finally {
      this.looping = false;
    }
  };

  act = (move: PokerMove) => {
    const tunnel = this.tunnel;
    const botA = this.botA;
    if (!tunnel || !botA || this.status !== "awaitHuman") return;
    this.clearTurnTimer(); // the turn is taken — stop the countdown
    const myGen = this.gen;
    try {
      applyHumanMove(tunnel, botA, HUMAN, move, this.ts++);
      this.heartbeatActions += 1;
      this.moveCount += 1;
      this.flushHeartbeat(this.tunnelId, false);
      this.status = "playing";
      this.emit();
      void this.drive(myGen);
    } catch (e) {
      this.fail(e);
    }
  };

  /** Arm the per-turn countdown; at 0 the turn auto-checks (else folds). */
  private startTurnTimer() {
    this.clearTurnTimer();
    this.secondsLeft = TURN_SECONDS;
    this.emit();
    this.turnTick = setInterval(() => {
      this.secondsLeft = this.secondsLeft != null ? this.secondsLeft - 1 : null;
      this.emit();
    }, 1000);
    this.turnTimer = setTimeout(() => {
      if (this.status !== "awaitHuman" || !this.tunnel) return;
      const legal = legalPokerActions(this.tunnel.state, HUMAN);
      this.act(legal.canCheck ? { kind: "check" } : { kind: "fold" });
    }, TURN_SECONDS * 1000);
  }

  private clearTurnTimer() {
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

  /** End the match early and settle now (player "cash out"). Bumps `gen` so any in-flight drive loop
   *  abandons (no double settle), then closes at the current co-signed state. The window navigates
   *  back to the menu once status reaches "settled". */
  settleNow = () => {
    if (this.status !== "playing" && this.status !== "awaitHuman") return;
    const myGen = ++this.gen;
    void this.settle(myGen);
  };

  /** Toggle bot auto-play of the human's seat (party A). On → botA makes A's betting moves so the
   *  match runs bot-vs-bot in the SAME tunnel until a seat busts (the loop's terminal branch settles);
   *  off → the human resumes at A's next betting turn. No-op outside a live hand. */
  setAuto = (on: boolean) => {
    if (this.auto === on) return;
    if (this.status !== "playing" && this.status !== "awaitHuman") return;
    this.auto = on;
    if (on && this.status === "awaitHuman") {
      // Parked waiting for the human — cancel the countdown and re-kick so botA takes the turn now.
      // `drive` re-entry is safe (it cleared `looping` when it parked).
      this.clearTurnTimer();
      this.status = "playing";
      this.emit();
      void this.drive(this.gen);
    } else {
      // Toggled off (resume manual) or on while already driving — the loop reads `this.auto` at the
      // next await-human; just reflect the flag now.
      this.emit();
    }
  };

  /** The human left without settling (Back): hand their seat to the bot and let it play on in the
   *  background until a seat busts → terminal settle. A convenience alias for enabling auto-play. */
  handOffToBot = () => this.setAuto(true);

  private settle = async (myGen: number) => {
    const tunnel = this.tunnel;
    const transcript = this.transcript;
    const deps = this.deps;
    if (!tunnel || !transcript || !deps) return;
    this.clearTurnTimer();
    this.status = "settling";
    this.emit();
    this.flushHeartbeat(this.tunnelId, true); // tail: don't drop the final partial window
    try {
      const settled = await settlePokerTunnel({
        tunnel,
        transcript,
        tunnelId: this.tunnelId,
        createdAt: this.createdAt,
        coinType: this.coinType,
        // DOPAMINT mode: the on-chain fallback close stakes DOPAMINT, so it must be gas-sponsored.
        fallbackSignExec: isDopamintConfigured
          ? deps.sponsoredSignExec
          : deps.signExec,
      });
      if (this.gen !== myGen) return;
      this.deps?.report.pushLocalTxn({
        id: ++this.txnId,
        game: "quantum-poker",
        time: new Date().toLocaleTimeString("en-GB"),
        bot: `You vs ${this.oppName}`,
        type: "settled",
        status: "Success",
        amount: settled.proofUrl ? "walrus ✓" : "closed",
      });
      this.status = "settled";
      this.emit();
    } catch (e) {
      if (this.gen === myGen) this.fail(e);
    }
  };
}

const sessions = new Map<string, BotSession>();

function getSession(windowId: string): BotSession {
  let s = sessions.get(windowId);
  if (!s) {
    s = new BotSession();
    sessions.set(windowId, s);
    const created = s;
    registerWindowDisposer(windowId, "quantum-poker-bot", () => {
      created.dispose();
      sessions.delete(windowId);
    });
  }
  return s;
}

export function useQuantumPokerBot(windowId: string): QuantumPokerBotSession {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();
  const { report } = useTelemetry();
  const session = getSession(windowId);
  session.deps = {
    report,
    account,
    client,
    signExec: (async (tx) => {
      const r = await mutateAsync({ transaction: tx });
      return { digest: r.digest };
    }) as SignExec,
    sponsoredSignExec: sponsored.signExec,
    prepareStake: sponsored.prepareStake,
    ensureStakeBalance: sponsored.ensureStakeBalance,
  };
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    ...snap,
    open: session.open,
    act: session.act,
    settleNow: session.settleNow,
    setAuto: session.setAuto,
    handOffToBot: session.handOffToBot,
    reset: session.reset,
  };
}
