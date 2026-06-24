import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, proof, bytesToHex } from "sui-tunnel-ts";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "@/backend/controlPlane";
import { useTelemetry } from "@/telemetry/TelemetryProvider";
import { settleViaBackend } from "@/backend/settle";
import {
  buildCreateAndFundTx,
  buildSettleWithRootTx,
  parseTunnelId,
} from "@/games/blackjack/app/lib/bjTunnel";
import { submitRebuildingOnStale } from "@/onchain/tunnelTx";
import {
  handToCardIndices,
  handValue,
} from "@/games/blackjack/app/lib/bjCards";
import {
  loadOrCreateBots,
  getSuiClient,
  botBalances,
  fundBots,
  transferBetweenBots,
  type BotIdentity,
} from "@/games/blackjack/app/lib/bjBots";
import {
  DOPAMINT_COIN_TYPE,
  ensureDopamintAddressBalance,
  ensureDopamintStakeCoin,
  isDopamintAddressBalance,
  isDopamintConfigured,
} from "@/onchain/dopamint";
import { makeKeypairSponsoredSignExec } from "@/onchain/sponsor";
import {
  BlackjackBetProtocol,
  FIXED_PLAYER_A,
  fixedBetMove,
  BET_OPTIONS,
  MIN_BET,
  type BetBlackjackState,
  type BetBlackjackMove,
} from "@/games/blackjack/app/lib/bjBetProtocol";

// Re-export so the page imports bet presets from the hook (its single source of game config).
export { BET_OPTIONS, MIN_BET };

type State = BetBlackjackState;

export type BotPhase =
  | "idle"
  | "funding"
  | "opening"
  | "playing"
  | "settling"
  | "done"
  | "error";

export interface BotDigests {
  /** The single open+fund+activate tx (create_and_fund), signed by the player bot. */
  create?: string;
  /** Checkpoint of the final co-signed state (update_state), submitted before close. */
  update?: string;
  close?: string;
  /** Hex of the transcript Merkle root anchored on-chain at close (0x-prefixed). */
  root?: string;
}

export interface BlackjackBotView {
  playerCards: number[];
  dealerCards: number[];
  playerSum: number;
  dealerSum: number;
  playerBalance: number;
  dealerBalance: number;
  round: number;
  phase: "player" | "dealer" | "round_over";
}

export type BlackjackResult = "win" | "lose" | "push";

// One settled round within a single tunnel session. The bots play many rounds before the
// tunnel terminates; this records each so the UI can show a running per-round log.
export interface RoundResult {
  round: number;
  playerSum: number;
  dealerSum: number;
  outcome: BlackjackResult;
  delta: number; // balanceA change in stake units (>0 win, <0 lose, 0 push)
}

// Keep the running log bounded so a long auto-play session can't grow it without limit.
const MAX_ROUNDS_LOGGED = 20;

// One completed tunnel in the auto-play session. Recorded once a tunnel settles so the user
// can review each settlement (which the fast inter-tunnel transition otherwise hides).
export interface TunnelRecord {
  tunnelId: string;
  createDigest?: string;
  closeDigest?: string;
  /** Hex of the transcript Merkle root anchored at close (0x-prefixed). */
  rootHex?: string;
  rounds: number; // rounds played in this tunnel
  result: BlackjackResult;
  finalBalanceA: number; // off-chain final balanceA (stake units)
}

// Cap the persistent tunnel history so a long auto-play session can't grow it without bound.
const MAX_TUNNELS_LOGGED = 30;

export interface BlackjackBotGame {
  view: BlackjackBotView;
  result: BlackjackResult | null;
  rounds: RoundResult[];
  tunnels: TunnelRecord[];
  phase: BotPhase;
  error: string | null;
  fundNote: string | null;
  digests: BotDigests;
  balances: { a: bigint; b: bigint };
  /** When true your bot auto-plays the player's hand; when false you play it (hit/stand). */
  auto: boolean;
  /** Toggle auto-play. Off hands the player's turn to the user; the dealer + betting stay auto. */
  setAuto: (on: boolean) => void;
  /** True when auto is off and it's the player's turn to act (show Hit/Stand). */
  myTurn: boolean;
  /** Take the player's hit this hand (manual mode only). */
  hit: () => void;
  /** Stand the player's hand this hand (manual mode only). */
  stand: () => void;
  /** True while a rebalance transfer is in flight (disables the control). */
  rebalancing: boolean;
  maxRounds: number;
  setMaxRounds: (n: number) => void;
  /** Per-round bet (chips) the bots wager each hand; chosen before play, applied all session. */
  bet: number;
  setBet: (n: number) => void;
  /** Bet denominations offered in the UI (chips). */
  betOptions: number[];
  balancesLoaded: boolean;
  fund: () => void;
  /** Even out the two bots' wallet balances: move half the difference richer→poorer. */
  rebalance: () => void;
  /** Begin a session. autoOn = start in watch (bot plays); false = start in manual (you play). */
  startAuto: (autoOn?: boolean) => void;
  stopAuto: () => void;
  /** Stop play and return to the idle/config screen (does not auto-restart). */
  backToConfig: () => void;
  newGame: () => void;
  refresh: () => Promise<{ a: bigint; b: bigint } | null>;
  pollBalances: (prev?: { a: bigint; b: bigint }) => Promise<void>;
}

// Buy-in (bankroll) each bot brings to the table per game, in MIST. Chips are 1:1 with MIST
// (1 SUI = 1,000,000,000 chips), so this is also the starting chip stack. Sized so the table
// can sustain the full rounds-per-tunnel target before either side is drained. Bots bet the
// minimum (DEFAULT_BET = MIN_BET), so 50,000 chips covers far more than the rounds-per-tunnel
// target while keeping the on-chain deposit — and thus the MIN_PLAY floor — tiny.
const BUY_IN = 50_000n;
// Animation cadence: one move surfaced to the view per tick.
const STEP_MS = 900;
// The bot that opens a tunnel funds BOTH seats from its own gas coin, so it must hold at least
// 2×BUY_IN (both deposits) plus gas to safely play another game; below it, auto-play stops
// rather than risk a mid-game tx running out of gas and leaving a tunnel open. The funder
// alternates each game (see runGame) so this drain stays balanced across both bots.
const MIN_PLAY_MIST = 2n * BUY_IN + 20_000_000n;
// Default per-round bet (chips) until the user picks one: the minimum, to keep the value
// churned each round (and thus variance / required buy-in) as small as possible.
const DEFAULT_BET = Number(MIN_BET);
// Pause between auto-played games. Long enough that the "settling…"/done state for the just-
// finished tunnel stays briefly visible before the next tunnel opens.
const NEXT_GAME_MS = 2500;
// Funding-refresh poll: the fullnode lags the funding tx, so re-read balances a few times
// before giving up rather than reading the stale pre-fund value once.
const POLL_BALANCES_MS = 1500;
const POLL_BALANCES_TRIES = 8;
// Safety bound: the protocol caps rounds, but never spin forever on a logic bug.
const MAX_STEPS = 5000;
// Default number of rounds to play off-chain in one tunnel before auto-settling.
const DEFAULT_MAX_ROUNDS = 100;
// User-selectable range for the "rounds per tunnel" control.
export const MIN_ROUNDS_PER_TUNNEL = 1;
export const MAX_ROUNDS_PER_TUNNEL = 500;

function viewFromState(state: State): BlackjackBotView {
  const round = Number(state.round);
  // Self-play pins the player to seat A (FIXED_PLAYER_A), so balanceA is always the player's
  // chips and balanceB the dealer's — no role rotation to compensate for.
  return {
    playerCards: handToCardIndices(state.playerHand, round * 2),
    dealerCards: handToCardIndices(state.dealerHand, round * 2 + 1),
    playerSum: handValue(state.playerHand),
    dealerSum: handValue(state.dealerHand),
    playerBalance: Number(state.balanceA),
    dealerBalance: Number(state.balanceB),
    round,
    phase: state.phase,
  };
}

const EMPTY_VIEW: BlackjackBotView = {
  playerCards: [],
  dealerCards: [],
  playerSum: 0,
  dealerSum: 0,
  playerBalance: 0,
  dealerBalance: 0,
  round: 0,
  phase: "player",
};

export function useBlackjackBot(): BlackjackBotGame {
  const { report } = useTelemetry();
  // Pin the player to seat A (no role rotation): "Play vs Bot" is one human vs the dealer bot,
  // so a stable seat keeps the player's chips and per-round win/lose from inverting.
  const proto = useMemo(() => new BlackjackBetProtocol(FIXED_PLAYER_A), []);
  const bots = useMemo(() => loadOrCreateBots(), []);
  const client = useMemo(() => getSuiClient(), []);

  const [view, setView] = useState<BlackjackBotView>(EMPTY_VIEW);
  const [result, setResult] = useState<BlackjackResult | null>(null);
  const [rounds, setRounds] = useState<RoundResult[]>([]);
  const [tunnels, setTunnels] = useState<TunnelRecord[]>([]);
  const [phase, setPhase] = useState<BotPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [fundNote, setFundNote] = useState<string | null>(null);
  const [digests, setDigests] = useState<BotDigests>({});
  const [balances, setBalances] = useState<{ a: bigint; b: bigint }>({
    a: 0n,
    b: 0n,
  });
  const [auto, setAutoState] = useState(true);
  const [rebalancing, setRebalancing] = useState(false);
  const [maxRounds, setMaxRoundsState] = useState(DEFAULT_MAX_ROUNDS);
  const [bet, setBetState] = useState(DEFAULT_BET);
  const [balancesLoaded, setBalancesLoaded] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRef = useRef(true); // mirror of `auto` (auto-play the player's hand) readable inside async flows
  // A play session is live (drives tunnel-after-tunnel continuation). Decoupled from `auto`:
  // unchecking auto switches the player's hand to manual but keeps the session running.
  const playingRef = useRef(false);
  // A user-queued manual move (hit/stand) the running interval applies on its next tick, so the
  // manual path reuses the loop's single round-logging/telemetry site (incl. player-bust).
  const pendingMoveRef = useRef<BetBlackjackMove | null>(null);
  const balancesRef = useRef<{ a: bigint; b: bigint }>({ a: 0n, b: 0n });
  const runRef = useRef<() => void>(() => {});
  // Mirror of `maxRounds` so the play loop reads the live target without rebuilding runGame.
  const maxRoundsRef = useRef(DEFAULT_MAX_ROUNDS);
  // Mirror of `bet` so the play loop reads the live wager without rebuilding runGame.
  const betRef = useRef(DEFAULT_BET);
  // Counts games started this session so the create_and_fund signer alternates between bots —
  // the funder pays both deposits, so alternating keeps that drain balanced across both wallets.
  const gamesRef = useRef(0);

  const sessionRef = useRef<RegisterSessionResult | null>(null);
  const moveCountRef = useRef(0);
  const actionsRef = useRef(0);
  const lastHeartbeatRef = useRef(Date.now());

  const flushHeartbeat = useCallback((tunnelId: string, force: boolean) => {
    const s = sessionRef.current;
    if (!s || actionsRef.current === 0) return;
    const now = Date.now();
    const windowMs = now - lastHeartbeatRef.current;
    if (!force && windowMs < 1000) return;
    const actionsDelta = actionsRef.current;
    actionsRef.current = 0;
    lastHeartbeatRef.current = now;
    getControlPlaneClient()
      .sendHeartbeat(s.sessionId, s.statsToken, {
        tunnelId,
        nonce: String(moveCountRef.current),
        actionsDelta,
        windowMs: Math.max(1, windowMs),
      })
      .catch((e) => console.error("[blackjack bot] heartbeat failed:", e));
  }, []);

  // Clamp the rounds-per-tunnel target to a sane range so a custom input can't request 0 or
  // an unbounded number of rounds in a single tunnel.
  const setMaxRounds = useCallback((n: number) => {
    const clamped = Math.max(
      MIN_ROUNDS_PER_TUNNEL,
      Math.min(
        MAX_ROUNDS_PER_TUNNEL,
        Math.floor(Number.isFinite(n) ? n : DEFAULT_MAX_ROUNDS),
      ),
    );
    maxRoundsRef.current = clamped;
    setMaxRoundsState(clamped);
  }, []);

  // Clamp the per-round bet to >= MIN_BET. The per-round upper bound is the table max (the
  // poorer side's balance) and is enforced when the bet move is built, so no fixed cap here.
  const setBet = useCallback((n: number) => {
    const clamped = Math.max(
      Number(MIN_BET),
      Math.floor(Number.isFinite(n) ? n : DEFAULT_BET),
    );
    betRef.current = clamped;
    setBetState(clamped);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const refreshBalances = useCallback(async () => {
    try {
      const b = await botBalances(client, bots);
      balancesRef.current = b;
      setBalances(b);
      return b;
    } catch {
      return null;
    } finally {
      setBalancesLoaded(true);
    }
  }, [client, bots]);

  // Re-read balances repeatedly after a funding tx: the fullnode lags the tx, so a single
  // read sees the stale pre-fund value. Stops early once both bots show funds above `prev`
  // (or above zero when `prev` is omitted), otherwise after a bounded number of tries.
  const pollBalances = useCallback(
    async (prev?: { a: bigint; b: bigint }) => {
      for (let i = 0; i < POLL_BALANCES_TRIES; i++) {
        const b = await refreshBalances();
        if (
          b &&
          (prev ? b.a > prev.a : b.a > 0n) &&
          (prev ? b.b > prev.b : b.b > 0n)
        ) {
          return;
        }
        await new Promise<void>((r) => setTimeout(r, POLL_BALANCES_MS));
      }
    },
    [refreshBalances],
  );

  // Load balances on mount; tear down timers on unmount.
  useEffect(() => {
    void refreshBalances();
    return () => {
      stopTimer();
      if (nextRef.current !== null) clearTimeout(nextRef.current);
    };
  }, [refreshBalances, stopTimer]);

  // Submit a tx signed by a bot keypair; assert success and return the result.
  const submit = useCallback(
    async (tx: Transaction, signer: Ed25519Keypair) => {
      const res = await client.signAndExecuteTransaction({
        signer,
        transaction: tx,
        options: { showObjectChanges: true, showEffects: true },
      });
      if (res.effects?.status?.status !== "success") {
        throw new Error(
          `tx ${res.digest} failed: ${res.effects?.status?.error ?? "unknown"}`,
        );
      }
      await client.waitForTransaction({ digest: res.digest });
      return res;
    },
    [client],
  );

  // DOPAMINT mode: route a bot keypair's tx through the backend gas sponsor (ADR-0009/0010) — the
  // settler pays gas, so the bot signs with zero SUI. Returns just the digest; create flows recover
  // object changes via getTransactionBlock.
  const sponsoredSignExec = useCallback(
    (bot: BotIdentity) =>
      makeKeypairSponsoredSignExec({
        address: bot.address,
        keypair: bot.keypair,
        client: client as never,
      }),
    [client],
  );

  const fund = useCallback(() => {
    void (async () => {
      setPhase("funding");
      setError(null);
      setFundNote(null);
      const prev = balancesRef.current;
      try {
        const status = await fundBots(client, bots);
        // Surface per-bot faucet status (rate limit / error) so the UI explains why nothing
        // may have arrived, rather than silently leaving balances at zero.
        const failed = [
          status.a !== "ok" ? `Player bot: ${status.a}` : null,
          status.b !== "ok" ? `Dealer bot: ${status.b}` : null,
        ].filter(Boolean);
        if (failed.length > 0) {
          setFundNote(
            `Faucet did not fully deliver (${failed.join("; ")}). Try wallet funding or wait and refresh.`,
          );
        }
        await pollBalances(prev);
        setPhase("idle");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [client, bots, pollBalances]);

  // Run exactly one game: open+fund (one tx) -> animated self-play -> cooperative close.
  // When auto-play is on, schedules the next game (or stops if a bot is low on gas).
  const runGame = useCallback(() => {
    stopTimer();
    // DOPAMINT mode: bot gas is sponsored and buy-ins are faucet-minted, so the bots need no SUI —
    // skip the SUI-balance gate (their SUI balance is 0). SUI fallback still gates on real balances.
    if (
      !isDopamintConfigured &&
      (balancesRef.current.a < MIN_PLAY_MIST ||
        balancesRef.current.b < MIN_PLAY_MIST)
    ) {
      autoRef.current = false;
      setAuto(false);
      setError("Fund the bots first");
      setPhase("error");
      return;
    }
    setError(null);
    setView(EMPTY_VIEW);
    setResult(null);
    setRounds([]);
    setDigests({});

    void (async () => {
      try {
        const partyA = { address: bots.a.address, publicKey: bots.a.publicKey };
        const partyB = { address: bots.b.address, publicKey: bots.b.publicKey };

        // 1) open + fund (both buy-ins) + activate in ONE tx: one bot signs a single
        // create_and_fund that funds both seats from its own gas coin. The funder ALTERNATES
        // each game — it pays both buy-ins upfront but only its own seat returns at close, so
        // alternating keeps that transfer from steadily draining one wallet into the other over
        // a long auto-play session. The tunnel is active the moment this lands.
        const funder = gamesRef.current % 2 === 0 ? bots.a : bots.b;
        gamesRef.current += 1;

        // DOPAMINT mode: the funder stakes faucet-minted DOPAMINT (both seats from its one coin)
        // and sponsors its own open/close gas (no SUI). SUI fallback: the funder splits both
        // buy-ins off its gas coin and pays its own gas.
        const coinType = isDopamintConfigured ? DOPAMINT_COIN_TYPE : undefined;

        setPhase("opening");
        let createDigest: string;
        if (isDopamintConfigured) {
          // ADR-0013: the funder bot is the tx sender → its address balance is the stake source.
          // Self-play funds BOTH seats from one source, so withdraw/faucet for the 2-seat total.
          const stakeOpt = isDopamintAddressBalance
            ? (await ensureDopamintAddressBalance({
                client: client as never,
                signExec: sponsoredSignExec(funder),
                owner: funder.address,
                need: 2n * BUY_IN,
              }),
              {
                coinType,
                stakeFromBalance: {
                  amount: 2n * BUY_IN,
                  coinType: DOPAMINT_COIN_TYPE,
                },
              })
            : {
                coinType,
                stakeCoinId: await ensureDopamintStakeCoin({
                  client: client as never,
                  signExec: sponsoredSignExec(funder),
                  owner: funder.address,
                  need: 2n * BUY_IN,
                }),
              };
          const { digest } = await submitRebuildingOnStale(
            () => buildCreateAndFundTx(partyA, partyB, BUY_IN, stakeOpt),
            sponsoredSignExec(funder),
            "blackjack bot open",
          );
          await client.waitForTransaction({ digest });
          createDigest = digest;
        } else {
          const createRes = await submit(
            buildCreateAndFundTx(partyA, partyB, BUY_IN),
            funder.keypair,
          );
          createDigest = createRes.digest;
        }
        const createTxb = await client.getTransactionBlock({
          digest: createDigest,
          options: { showObjectChanges: true },
        });
        const tunnelId = parseTunnelId(createTxb.objectChanges);
        if (!tunnelId) throw new Error("could not find created Tunnel id");
        setDigests((d) => ({ ...d, create: createDigest }));
        report.bumpCounters({ tunnelsOpened: 1 });
        report.setActive(2);

        // 2) read created_at for the settlement timestamp.
        const obj = await client.getObject({
          id: tunnelId,
          options: { showContent: true },
        });
        const fields = (
          obj.data?.content as { fields?: Record<string, unknown> } | undefined
        )?.fields;
        const createdAt = BigInt(
          (fields?.created_at as string | undefined) ?? 0,
        );

        // 3) off-chain self-play tunnel (both keys held locally).
        const tunnel = core.OffchainTunnel.selfPlay(
          proto,
          tunnelId,
          bots.a.coreKey,
          bots.b.coreKey,
          bots.a.address,
          bots.b.address,
          { a: BUY_IN, b: BUY_IN },
        );

        // Accumulate every co-signed update into a transcript; its Merkle root is anchored
        // on-chain at close. Wire the observer BEFORE any step so no update is missed.
        const transcript = new proof.Transcript(tunnelId);
        tunnel.onUpdate = (u) => transcript.append(u);

        // Register the (real, on-chain) tunnel for stats tracking. Best-effort.
        sessionRef.current = null;
        moveCountRef.current = 0;
        actionsRef.current = 0;
        lastHeartbeatRef.current = Date.now();
        getControlPlaneClient()
          .registerSession({
            userAddress: bots.a.address,
            game: "blackjack",
            tunnels: [
              { tunnelId, partyA: bots.a.address, partyB: bots.b.address },
            ],
          })
          .then((s) => {
            sessionRef.current = s;
          })
          .catch((e) =>
            console.error("[blackjack bot] registerSession failed:", e),
          );

        // 4) animate moves; each .step co-signs AND verifies both sigs (mode "full").
        // The dealer ('dealer' phase) moves as B, everyone else as A.
        setPhase("playing");
        setView(viewFromState(tunnel.state));
        pendingMoveRef.current = null; // drop any move queued during the inter-tunnel gap
        // Stop after this many completed rounds in the single tunnel, then settle once.
        const roundsTarget = maxRoundsRef.current;
        let roundsThisTunnel = 0;
        await new Promise<void>((resolve, reject) => {
          let steps = 0;
          let completedRounds = 0;
          // Wall-clock of the last dealer/betting auto-step, used to pace them to STEP_MS in
          // manual mode (the tick itself stays at 30ms so a re-tick of Auto resumes instantly).
          let lastAutoStepAt = 0;
          const delay = autoRef.current ? 30 : STEP_MS;
          timerRef.current = setInterval(() => {
            try {
              if (proto.isTerminal(tunnel.state)) {
                stopTimer();
                resolve();
                return;
              }
              if (steps++ >= MAX_STEPS) {
                throw new Error("self-play exceeded step bound");
              }
              // Move as whoever the protocol expects this phase — the player alternates
              // A,A,B,B across rounds, so a fixed party would make randomMove return null the
              // moment it flips, which a naive loop misreads as "game over" (it would settle
              // after ~2 rounds). In the betting phase, place the chosen fixed bet; otherwise
              // let the protocol pick (basic strategy for the player, deterministic dealer).
              const cur = tunnel.state;
              const by = proto.actorFor(cur);
              // Manual play (auto off): pause at the player's decision and apply only a
              // user-queued hit/stand. The dealer is deterministic and betting auto-deals, so
              // both proceed regardless of the toggle — same split as the PvP mode.
              let move: BetBlackjackMove | null;
              if (!autoRef.current && cur.phase === "player") {
                if (!pendingMoveRef.current) {
                  flushHeartbeat(tunnelId, false);
                  return; // wait for the user's Hit/Stand
                }
                move = pendingMoveRef.current;
                pendingMoveRef.current = null;
              } else {
                // Dealer reveal + next-round deal: in manual mode pace them so they're watchable
                // between the player's decisions; in auto mode fire every tick for max throughput.
                if (!autoRef.current && Date.now() - lastAutoStepAt < STEP_MS) {
                  return;
                }
                lastAutoStepAt = Date.now();
                move =
                  cur.phase === "round_over"
                    ? fixedBetMove(betRef.current, cur)
                    : proto.randomMove(cur, by, Math.random);
              }
              if (!move) {
                stopTimer();
                resolve();
                return;
              }
              // Snapshot before stepping so we can detect a round resolving: the step
              // that first lands on `round_over` is when this round's outcome is known.
              const prevPhase = tunnel.state.phase;
              const prevBalanceA = tunnel.state.balanceA;
              // Sign each update with the on-chain created_at (a validator timestamp,
              // always >= created_at and <= now) so the final co-signed state passes
              // update_state's timestamp check regardless of local clock skew.
              const r = tunnel.step(move, by, {
                mode: "full",
                timestamp: createdAt,
              });
              if (!r.verified)
                throw new Error(`state ${r.nonce} failed dual-verify`);
              moveCountRef.current += 1;
              actionsRef.current += 1;
              report.bumpCounters({
                updates: 1,
                signatures: 2,
                verifications: 2,
              });
              const s = tunnel.state;
              if (s.phase === "round_over" && prevPhase !== "round_over") {
                // Player is pinned to seat A, so balanceA's change is the player's win/loss.
                const delta = Number(s.balanceA - prevBalanceA);
                const outcome: BlackjackResult =
                  delta > 0 ? "win" : delta < 0 ? "lose" : "push";
                const settled: RoundResult = {
                  round: Number(s.round),
                  playerSum: handValue(s.playerHand),
                  dealerSum: handValue(s.dealerHand),
                  outcome,
                  delta,
                };
                setRounds((prev) =>
                  [...prev, settled].slice(-MAX_ROUNDS_LOGGED),
                );
                completedRounds++;
                roundsThisTunnel = completedRounds;
                const row = {
                  id: moveCountRef.current,
                  game: "blackjack",
                  time: new Date().toLocaleTimeString("en-GB"),
                  bot: bots.a.address,
                  type: `Blackjack ${outcome === "win" ? "Win" : outcome === "lose" ? "Loss" : "Push"}`,
                  status: "Success" as const,
                  amount:
                    delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "0",
                };
                // Live Transactions is backend-sourced (on-chain indexer); only My Activity is local.
                report.pushLocalTxn(row);
              }
              setView(viewFromState(tunnel.state));
              // Stop once a bot is bankrupt (terminal) or we've played the requested number
              // of rounds — whichever comes first. Stopping on `round_over` keeps the cut on a
              // clean round boundary, then the existing settle path runs once.
              if (
                proto.isTerminal(tunnel.state) ||
                (s.phase === "round_over" && completedRounds >= roundsTarget)
              ) {
                stopTimer();
                resolve();
              }
              flushHeartbeat(tunnelId, false);
            } catch (err) {
              stopTimer();
              reject(err);
            }
          }, delay);
        });

        setView(viewFromState(tunnel.state));

        // Result from final balanceA vs the buy-in (A is the player bot).
        const finalA = tunnel.state.balanceA;
        const finalResult: BlackjackResult =
          finalA > BUY_IN ? "win" : finalA < BUY_IN ? "lose" : "push";
        setResult(finalResult);

        // 5) settle: anchor the transcript root AND distribute funds via sponsored close, or fallback.
        setPhase("settling");
        flushHeartbeat(tunnelId, true);

        const root = transcript.root();
        const s = tunnel.buildSettlementWithRoot(createdAt, root, 0n);

        let closeDigest = "";
        const backendDigest = await settleViaBackend({
          tunnelId,
          settlement: s,
          transcript: transcript.rawEntries(),
          label: "blackjack",
          fallbackClose: async () => {
            if (isDopamintConfigured) {
              // The funder opened the tunnel and holds the sponsored signer; close DOPAMINT sponsored.
              const { digest } = await sponsoredSignExec(funder)(
                buildSettleWithRootTx(tunnelId, s, coinType),
              );
              await client.waitForTransaction({ digest });
              closeDigest = digest;
            } else {
              const closeRes = await submit(
                buildSettleWithRootTx(tunnelId, s),
                bots.a.keypair,
              );
              closeDigest = closeRes.digest;
            }
          },
        });

        // Backend /settle returns its close digest; the fallback assigns its own (above).
        if (backendDigest) closeDigest = backendDigest;

        const rootHex = `0x${bytesToHex(root)}`;
        setDigests((d) => ({ ...d, close: closeDigest, root: rootHex }));
        report.pushTxn({
          id: actionsRef.current,
          game: "blackjack",
          digest: closeDigest,
          address: bots.a.address,
          time: new Date().toLocaleTimeString("en-GB"),
          bot: bots.a.address,
          type: "Settle",
          status: "Success",
          amount: "",
        });
        report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
        report.setActive(0);

        // Record this settled tunnel into the persistent history (newest first). Survives the
        // auto loop so the user can review each settlement the fast transition would otherwise
        // hide; cleared only on stopAuto/reset, not per tunnel.
        const tunnelRecord: TunnelRecord = {
          tunnelId,
          createDigest,
          closeDigest,
          rootHex,
          rounds: roundsThisTunnel,
          result: finalResult,
          finalBalanceA: Number(finalA),
        };
        setTunnels((prev) =>
          [tunnelRecord, ...prev].slice(0, MAX_TUNNELS_LOGGED),
        );

        const b = await refreshBalances();
        setPhase("done");

        // 7) continue tunnel-after-tunnel while the session is live (auto or manual), until a bot
        // is low on gas or the user goes back. DOPAMINT mode: gas sponsored + buy-ins faucet-
        // minted, so bots can't run dry — skip the SUI gate. Pace fast in auto, relaxed in manual.
        if (playingRef.current) {
          if (
            isDopamintConfigured ||
            (b && b.a >= MIN_PLAY_MIST && b.b >= MIN_PLAY_MIST)
          ) {
            nextRef.current = setTimeout(
              () => {
                if (playingRef.current) runRef.current();
              },
              autoRef.current ? 100 : NEXT_GAME_MS,
            );
          } else {
            playingRef.current = false;
            setError(
              "A bot is low on gas — auto-play stopped. Fund the bots to continue.",
            );
          }
        }
      } catch (e) {
        stopTimer();
        playingRef.current = false; // never loop on errors
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [
    bots,
    client,
    proto,
    submit,
    sponsoredSignExec,
    refreshBalances,
    stopTimer,
  ]);

  // keep a ref to the latest runGame so the auto-play timeout always calls the current one.
  useEffect(() => {
    runRef.current = runGame;
  }, [runGame]);

  // Auto-play toggle (player's hand only). Flipping it mid-session is enough: the running
  // interval reads autoRef live — off makes it wait for a queued Hit/Stand, on resumes
  // auto-stepping the player. The dealer + betting always proceed.
  const setAuto = useCallback((on: boolean) => {
    autoRef.current = on;
    setAutoState(on);
  }, []);

  // Queue a manual player move for the running interval to apply (see pendingMoveRef). No-op
  // unless a tunnel is actively waiting on the player in manual mode; a "hit" at 21+ is dropped
  // (illegal — the table only offers Stand there).
  const queuePlayerMove = useCallback(
    (action: "hit" | "stand") => {
      if (autoRef.current || phase !== "playing" || view.phase !== "player")
        return;
      if (action === "hit" && view.playerSum >= 21) return;
      pendingMoveRef.current = { action };
    },
    [phase, view.phase, view.playerSum],
  );
  const hit = useCallback(() => queuePlayerMove("hit"), [queuePlayerMove]);
  const stand = useCallback(() => queuePlayerMove("stand"), [queuePlayerMove]);

  // It's the user's turn exactly when auto is off, a tunnel is playing, and the protocol is
  // waiting on the player's decision.
  const myTurn = !auto && phase === "playing" && view.phase === "player";

  const newGame = useCallback(() => {
    setAuto(false);
    playingRef.current = false; // single tunnel: don't auto-continue
    runGame();
  }, [runGame, setAuto]);

  // autoOn picks the starting mode: a fresh window starts in watch (auto on); entering from the
  // main menu starts in manual (auto off) so the user plays the hands themselves.
  const startAuto = useCallback(
    (autoOn: boolean = true) => {
      // DOPAMINT mode: no SUI needed (sponsored gas + faucet buy-ins), so skip the balance gate.
      if (
        !isDopamintConfigured &&
        (balancesRef.current.a < MIN_PLAY_MIST ||
          balancesRef.current.b < MIN_PLAY_MIST)
      ) {
        setError("Fund the bots first");
        setPhase("error");
        return;
      }
      setAuto(autoOn);
      playingRef.current = true;
      runGame();
    },
    [runGame, setAuto],
  );

  const stopAuto = useCallback(() => {
    playingRef.current = false;
    pendingMoveRef.current = null;
    if (nextRef.current !== null) {
      clearTimeout(nextRef.current);
      nextRef.current = null;
    }
    // A full stop ends the session — clear the persistent tunnel history so the next
    // run starts with a fresh review list.
    setTunnels([]);
  }, []);

  // Return to the idle/config screen: end the session AND the in-flight self-play interval, then
  // clear the table view so `started` goes false. The page's back button calls this; the
  // auto-pilot won't restart afterward (its one-shot ref is already set), so the user stays on
  // config and drives play manually.
  const backToConfig = useCallback(() => {
    playingRef.current = false;
    pendingMoveRef.current = null;
    stopTimer();
    if (nextRef.current !== null) {
      clearTimeout(nextRef.current);
      nextRef.current = null;
    }
    setView(EMPTY_VIEW);
    setResult(null);
    setPhase("idle");
  }, [stopTimer]);

  // Even out the two bots' wallet balances by moving half the difference from the richer bot to
  // the poorer one (the richer bot signs its own transfer). Over an auto-play session the funder
  // alternates but win/loss swings still skew the wallets; this lets the user square them up so
  // neither bot drifts below the buy-in. Mirrors tic-tac-toe's bot rebalance.
  const rebalance = useCallback(() => {
    void (async () => {
      setError(null);
      const bal = balancesRef.current;
      const fromA = bal.a >= bal.b;
      const from = fromA ? bots.a : bots.b;
      const to = fromA ? bots.b : bots.a;
      const diff = fromA ? bal.a - bal.b : bal.b - bal.a;
      // Don't bother (or pay gas) for trivial gaps — under ~0.004 SUI they're already even enough.
      if (diff < 4_000_000n) {
        setError("Bots are already balanced.");
        return;
      }
      setRebalancing(true);
      try {
        await transferBetweenBots(client, from, to, Number(diff / 2n));
        await refreshBalances();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRebalancing(false);
      }
    })();
  }, [bots, client, refreshBalances]);

  return {
    view,
    result,
    rounds,
    tunnels,
    phase,
    error,
    fundNote,
    digests,
    balances,
    auto,
    setAuto,
    myTurn,
    hit,
    stand,
    rebalancing,
    maxRounds,
    setMaxRounds,
    bet,
    setBet,
    betOptions: [...BET_OPTIONS],
    balancesLoaded,
    fund,
    rebalance,
    startAuto,
    stopAuto,
    backToConfig,
    newGame,
    refresh: refreshBalances,
    pollBalances,
  };
}

export type { BotIdentity };
