import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, protocols } from "sui-tunnel-ts";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import {
  buildCreateAndShareTx,
  buildDepositTx,
  buildSettleTx,
  buildUpdateStateTx,
  parseTunnelId,
} from "@/lib/bjTunnel";
import { handToCardIndices, handValue } from "@/lib/bjCards";
import {
  loadOrCreateBots,
  getSuiClient,
  botBalances,
  fundBots,
  type BotIdentity,
} from "@/lib/bjBots";

type State = protocols.BlackjackState;

export type BotPhase =
  | "idle"
  | "funding"
  | "opening"
  | "playing"
  | "settling"
  | "done"
  | "error";

export interface BotDigests {
  create?: string;
  depositA?: string;
  depositB?: string;
  update?: string;
  close?: string;
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
  updateDigest?: string;
  closeDigest?: string;
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
  auto: boolean;
  maxRounds: number;
  setMaxRounds: (n: number) => void;
  fund: () => void;
  startAuto: () => void;
  stopAuto: () => void;
  newGame: () => void;
  refresh: () => Promise<{ a: bigint; b: bigint } | null>;
  pollBalances: (prev?: { a: bigint; b: bigint }) => Promise<void>;
}

// Each bot stakes this much into the tunnel per game.
const STAKE = 500n;
// Animation cadence: one move surfaced to the view per tick.
const STEP_MS = 700;
// A bot must hold at least this much (gas for its txs + the STAKE deposit) to safely play
// another game; below it, auto-play stops rather than risk a mid-game tx running out of gas
// and leaving a tunnel open. ~0.02 SUI (a game costs the busier bot ~0.01 SUI of gas).
const MIN_PLAY_MIST = 20_000_000n;
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
const DEFAULT_MAX_ROUNDS = 10;
// User-selectable range for the "rounds per tunnel" control.
export const MIN_ROUNDS_PER_TUNNEL = 1;
export const MAX_ROUNDS_PER_TUNNEL = 500;

function viewFromState(state: State): BlackjackBotView {
  const round = Number(state.round);
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
  const proto = useMemo(() => new protocols.BlackjackProtocol(), []);
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
  const [auto, setAuto] = useState(false);
  const [maxRounds, setMaxRoundsState] = useState(DEFAULT_MAX_ROUNDS);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRef = useRef(false); // mirror of `auto` readable inside async flows
  const balancesRef = useRef<{ a: bigint; b: bigint }>({ a: 0n, b: 0n });
  const runRef = useRef<() => void>(() => {});
  // Mirror of `maxRounds` so the play loop reads the live target without rebuilding runGame.
  const maxRoundsRef = useRef(DEFAULT_MAX_ROUNDS);

  // Clamp the rounds-per-tunnel target to a sane range so a custom input can't request 0 or
  // an unbounded number of rounds in a single tunnel.
  const setMaxRounds = useCallback((n: number) => {
    const clamped = Math.max(
      MIN_ROUNDS_PER_TUNNEL,
      Math.min(MAX_ROUNDS_PER_TUNNEL, Math.floor(Number.isFinite(n) ? n : DEFAULT_MAX_ROUNDS)),
    );
    maxRoundsRef.current = clamped;
    setMaxRoundsState(clamped);
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

  // Run exactly one game: create -> 2 deposits -> animated self-play -> cooperative close.
  // When auto-play is on, schedules the next game (or stops if a bot is low on gas).
  const runGame = useCallback(() => {
    stopTimer();
    if (
      balancesRef.current.a < MIN_PLAY_MIST ||
      balancesRef.current.b < MIN_PLAY_MIST
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

        // 1) bot A create + share.
        setPhase("opening");
        const createRes = await submit(
          buildCreateAndShareTx(partyA, partyB),
          bots.a.keypair,
        );
        const tunnelId = parseTunnelId(createRes.objectChanges);
        if (!tunnelId) throw new Error("could not find created Tunnel id");
        setDigests((d) => ({ ...d, create: createRes.digest }));

        // 2) read created_at for the settlement timestamp.
        const obj = await client.getObject({
          id: tunnelId,
          options: { showContent: true },
        });
        const fields = (
          obj.data?.content as { fields?: Record<string, unknown> } | undefined
        )?.fields;
        const createdAt = BigInt((fields?.created_at as string | undefined) ?? 0);

        // 3) both bots deposit STAKE.
        const depARes = await submit(
          buildDepositTx(tunnelId, STAKE),
          bots.a.keypair,
        );
        setDigests((d) => ({ ...d, depositA: depARes.digest }));
        const depBRes = await submit(
          buildDepositTx(tunnelId, STAKE),
          bots.b.keypair,
        );
        setDigests((d) => ({ ...d, depositB: depBRes.digest }));

        // 4) off-chain self-play tunnel (both keys held locally).
        const tunnel = core.OffchainTunnel.selfPlay(
          proto,
          tunnelId,
          bots.a.coreKey,
          bots.b.coreKey,
          bots.a.address,
          bots.b.address,
          { a: STAKE, b: STAKE },
        );

        // 5) animate moves; each .step co-signs AND verifies both sigs (mode "full").
        // The dealer ('dealer' phase) moves as B, everyone else as A.
        setPhase("playing");
        setView(viewFromState(tunnel.state));
        // Stop after this many completed rounds in the single tunnel, then settle once.
        const roundsTarget = maxRoundsRef.current;
        let roundsThisTunnel = 0;
        await new Promise<void>((resolve, reject) => {
          let steps = 0;
          let completedRounds = 0;
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
              const by: protocols.Party =
                tunnel.state.phase === "dealer" ? "B" : "A";
              const move = proto.randomMove(tunnel.state, by, Math.random);
              if (!move) {
                stopTimer();
                resolve();
                return;
              }
              // Snapshot before stepping so we can detect a round resolving: the step
              // that first lands on `round_over` is when this round's outcome is known.
              const prevPhase = tunnel.state.phase;
              const prevBalanceA = tunnel.state.balanceA;
              const r = tunnel.step(move, by, { mode: "full" });
              if (!r.verified)
                throw new Error(`state ${r.nonce} failed dual-verify`);
              const s = tunnel.state;
              if (s.phase === "round_over" && prevPhase !== "round_over") {
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
            } catch (err) {
              stopTimer();
              reject(err);
            }
          }, STEP_MS);
        });

        setView(viewFromState(tunnel.state));

        // Result from final balanceA vs STAKE (A is the player bot).
        const finalA = tunnel.state.balanceA;
        const finalResult: BlackjackResult =
          finalA > STAKE ? "win" : finalA < STAKE ? "lose" : "push";
        setResult(finalResult);

        // 6) checkpoint the final co-signed state on-chain, THEN close cooperatively.
        // update_state writes the played-out final state_hash/balances/nonce onto the
        // on-chain StateCommitment (it would otherwise stay at the empty nonce-0 opening).
        // After it lands, on-chain state.nonce == latest.update.nonce, so close_cooperative
        // derives finalNonce = nonce + 1; build the settlement with that same onchainNonce
        // so its signature is over the matching finalNonce.
        setPhase("settling");
        let updateDigest: string | undefined;
        const latest = tunnel.latest;
        if (latest) {
          const updateRes = await submit(
            buildUpdateStateTx(tunnelId, latest),
            bots.a.keypair,
          );
          updateDigest = updateRes.digest;
          setDigests((d) => ({ ...d, update: updateRes.digest }));
        }
        const onchainNonce = latest ? latest.update.nonce : 0n;
        const s = tunnel.buildSettlement(createdAt, onchainNonce);
        const closeRes = await submit(
          buildSettleTx(tunnelId, s),
          bots.a.keypair,
        );
        setDigests((d) => ({ ...d, close: closeRes.digest }));

        // Record this settled tunnel into the persistent history (newest first). Survives the
        // auto loop so the user can review each settlement the fast transition would otherwise
        // hide; cleared only on stopAuto/reset, not per tunnel.
        const tunnelRecord: TunnelRecord = {
          tunnelId,
          createDigest: createRes.digest,
          updateDigest,
          closeDigest: closeRes.digest,
          rounds: roundsThisTunnel,
          result: finalResult,
          finalBalanceA: Number(finalA),
        };
        setTunnels((prev) => [tunnelRecord, ...prev].slice(0, MAX_TUNNELS_LOGGED));

        const b = await refreshBalances();
        setPhase("done");

        // 7) auto-play: continue until a bot is low on gas, or the user stopped.
        if (autoRef.current) {
          if (b && b.a >= MIN_PLAY_MIST && b.b >= MIN_PLAY_MIST) {
            nextRef.current = setTimeout(() => {
              if (autoRef.current) runRef.current();
            }, NEXT_GAME_MS);
          } else {
            autoRef.current = false;
            setAuto(false);
            setError(
              "A bot is low on gas — auto-play stopped. Fund the bots to continue.",
            );
          }
        }
      } catch (e) {
        stopTimer();
        autoRef.current = false; // never loop on errors
        setAuto(false);
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [bots, client, proto, submit, refreshBalances, stopTimer]);

  // keep a ref to the latest runGame so the auto-play timeout always calls the current one.
  useEffect(() => {
    runRef.current = runGame;
  }, [runGame]);

  const newGame = useCallback(() => {
    autoRef.current = false;
    setAuto(false);
    runGame();
  }, [runGame]);

  const startAuto = useCallback(() => {
    if (
      balancesRef.current.a < MIN_PLAY_MIST ||
      balancesRef.current.b < MIN_PLAY_MIST
    ) {
      setError("Fund the bots first");
      setPhase("error");
      return;
    }
    autoRef.current = true;
    setAuto(true);
    runGame();
  }, [runGame]);

  const stopAuto = useCallback(() => {
    autoRef.current = false;
    setAuto(false);
    if (nextRef.current !== null) {
      clearTimeout(nextRef.current);
      nextRef.current = null;
    }
    // A full stop ends the session — clear the persistent tunnel history so the next
    // auto/play run starts with a fresh review list.
    setTunnels([]);
  }, []);

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
    maxRounds,
    setMaxRounds,
    fund,
    startAuto,
    stopAuto,
    newGame,
    refresh: refreshBalances,
    pollBalances,
  };
}

export type { BotIdentity };
