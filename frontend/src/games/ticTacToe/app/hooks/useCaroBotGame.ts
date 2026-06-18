import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, proof, bytesToHex } from "sui-tunnel-ts";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getControlPlaneClient, type RegisterSessionResult } from "@/backend/controlPlane";
import type { Transaction } from "@mysten/sui/transactions";
import {
  MultiGameCaroProtocol,
  type MultiGameCaroState,
  pickCaroMove,
  type BotStrength,
} from "@ttt/shared";
import {
  buildCreateAndFundTx,
  buildSettleWithRootTx,
  buildUpdateStateTx,
  parseTunnelId,
} from "@/games/ticTacToe/app/lib/tunnel";
import {
  loadOrCreateBots,
  getSuiClient,
  botBalances,
  fundBots,
  transferBetweenBots,
  type BotIdentity,
} from "@/games/ticTacToe/app/lib/bots";
import type { Difficulty } from "@/games/ticTacToe/app/hooks/useBotGame";
import type {
  BotPhase,
  BotScore,
  BotDigests,
  TunnelRecord,
} from "@/games/ticTacToe/app/hooks/useBotGame";

const DEFAULT_MAX_GAMES = 5;
const MIN_MAX_GAMES = 1;
const MAX_MAX_GAMES = 100;
const DEFAULT_BOARD_SIZE = 15;
const MIN_BOARD_SIZE = 9;
const MAX_BOARD_SIZE = 29;

const SCORE_KEY = "caro_bot_score.v1";
const STEP_MS = 350;
const MIN_PLAY_MIST = 20_000_000n;
const NEXT_GAME_MS = 1200;
// Cap the in-session settle history so a long auto-play run can't grow it without bound.
const MAX_TUNNELS_LOGGED = 30;

export interface CaroBotGameView {
  board: number[];
  boardSize: number;
  lastMove: number;
  turn: "A" | "B";
  winner: number;
  phase: BotPhase;
  error: string | null;
  digests: BotDigests;
  balances: { x: bigint; o: bigint };
  score: BotScore;
  /** Settled tunnels this session, newest first (one per on-chain close). */
  tunnels: TunnelRecord[];
  auto: boolean;
  rebalancing: boolean;
  maxGames: number;
  currentGame: number;
  setMaxGames: (n: number) => void;
  fund: () => void;
  rebalance: () => void;
  refresh: () => Promise<{ x: bigint; o: bigint } | null>;
  resetScore: () => void;
  newGame: () => void;
  startAuto: () => void;
  stopAuto: () => void;
}

function loadScore(): BotScore {
  try {
    const s = localStorage.getItem(SCORE_KEY);
    if (s) return JSON.parse(s) as BotScore;
  } catch {
    /* ignore */
  }
  return { x: 0, o: 0, draws: 0 };
}

// Difficulty -> per-party heuristic strength. No minimax for caro.
function strengthFor(difficulty: Difficulty, by: "A" | "B"): BotStrength {
  if (difficulty === "uneven") return by === "A" ? "strong" : "weak";
  return "strong"; // perfect/even both strong; "even" gets rng jitter at the call site
}

export function useCaroBotGame(
  difficulty: Difficulty = "even",
  boardSize: number = DEFAULT_BOARD_SIZE,
): CaroBotGameView {
  const bots = useMemo(() => loadOrCreateBots(), []);
  const client = useMemo(() => getSuiClient(), []);

  const [board, setBoard] = useState<number[]>(() =>
    new Array(DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE).fill(0),
  );
  const [size, setSize] = useState<number>(DEFAULT_BOARD_SIZE);
  const [lastMove, setLastMove] = useState<number>(-1);
  const [turn, setTurn] = useState<"A" | "B">("A");
  const [winner, setWinner] = useState<number>(0);
  const [phase, setPhase] = useState<BotPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [digests, setDigests] = useState<BotDigests>({});
  const [balances, setBalances] = useState<{ x: bigint; o: bigint }>({
    x: 0n,
    o: 0n,
  });
  const [score, setScore] = useState<BotScore>(loadScore);
  const [tunnels, setTunnels] = useState<TunnelRecord[]>([]);
  const [auto, setAuto] = useState(false);
  const [rebalancing, setRebalancing] = useState(false);
  const [maxGames, setMaxGamesState] = useState<number>(DEFAULT_MAX_GAMES);
  const [currentGame, setCurrentGame] = useState<number>(1);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRef = useRef(false);
  const balancesRef = useRef<{ x: bigint; o: bigint }>({ x: 0n, o: 0n });
  const runRef = useRef<() => void>(() => {});
  const difficultyRef = useRef<Difficulty>(difficulty);
  difficultyRef.current = difficulty;
  const maxGamesRef = useRef<number>(DEFAULT_MAX_GAMES);
  maxGamesRef.current = maxGames;
  const boardSizeRef = useRef<number>(boardSize);
  boardSizeRef.current = Math.max(
    MIN_BOARD_SIZE,
    Math.min(MAX_BOARD_SIZE, Math.floor(boardSize)),
  );

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
      .catch((e) => console.error("[caro bot] heartbeat failed:", e));
  }, []);

  const setMaxGames = useCallback((n: number) => {
    const clamped = Math.max(
      MIN_MAX_GAMES,
      Math.min(
        MAX_MAX_GAMES,
        Math.floor(Number.isFinite(n) ? n : DEFAULT_MAX_GAMES),
      ),
    );
    setMaxGamesState(clamped);
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

  useEffect(() => {
    void refreshBalances();
    return () => {
      stopTimer();
      if (nextRef.current !== null) clearTimeout(nextRef.current);
    };
  }, [refreshBalances, stopTimer]);

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
      try {
        await fundBots(client, bots);
        await refreshBalances();
        setPhase("idle");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [client, bots, refreshBalances]);

  // Run ONE tunnel that plays `maxGames` caro games and settles once.
  const runGame = useCallback(() => {
    stopTimer();
    if (
      balancesRef.current.x < MIN_PLAY_MIST ||
      balancesRef.current.o < MIN_PLAY_MIST
    ) {
      autoRef.current = false;
      setAuto(false);
      setError("Fund the bots first");
      setPhase("error");
      return;
    }
    const N = boardSizeRef.current;
    // Safety bound on the self-play loop, scaled to the worst case (every cell filled in
    // every game + one advance between games) with 2× headroom — large enough never to fire
    // in legitimate play, small enough to stop a protocol bug from spinning forever.
    const maxSteps = maxGamesRef.current * (N * N + 1) * 2;
    setError(null);
    setBoard(new Array(N * N).fill(0));
    setSize(N);
    setLastMove(-1);
    setTurn("A");
    setWinner(0);
    setDigests({});
    setCurrentGame(1);
    // The scoreboard shows the CURRENT tunnel's tally and resets each tunnel; the settled tally
    // is preserved in the tunnel history.
    setScore({ x: 0, o: 0, draws: 0 });

    const proto = new MultiGameCaroProtocol(maxGamesRef.current, N);

    void (async () => {
      try {
        const partyX = { address: bots.x.address, publicKey: bots.x.publicKey };
        const partyO = { address: bots.o.address, publicKey: bots.o.publicKey };

        // 1) open + fund (both 1-MIST stakes) + activate in ONE tx (bot X signs).
        setPhase("opening");
        const createRes = await submit(
          buildCreateAndFundTx(partyX, partyO, 1n),
          bots.x.keypair,
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
        const createdAt = BigInt(
          (fields?.created_at as string | undefined) ?? 0,
        );

        // 3) off-chain self-play tunnel (both keys local), driving MultiGameCaroProtocol.
        const tunnel = core.OffchainTunnel.selfPlay<
          MultiGameCaroState,
          { cell: number }
        >(
          proto,
          tunnelId,
          bots.x.coreKey,
          bots.o.coreKey,
          bots.x.address,
          bots.o.address,
          { a: 1n, b: 1n },
        );

        const transcript = new proof.Transcript(tunnelId);
        tunnel.onUpdate = (u) => transcript.append(u);

        // Register the (real, on-chain) tunnel for stats tracking. Best-effort.
        sessionRef.current = null;
        moveCountRef.current = 0;
        actionsRef.current = 0;
        lastHeartbeatRef.current = Date.now();
        getControlPlaneClient()
          .registerSession({
            userAddress: bots.x.address,
            game: "tictactoe",
            tunnels: [{ tunnelId, partyA: bots.x.address, partyB: bots.o.address }],
          })
          .then((s) => {
            sessionRef.current = s;
          })
          .catch((e) => console.error("[caro bot] registerSession failed:", e));

        // 4) animate moves across all N games; each .step co-signs + verifies (mode "full").
        setPhase("playing");
        // This tunnel's running tally. Tracked locally (not via the score state) so the close
        // handler can read the final tally without a stale-state read; mirrored into `score`
        // for the live scoreboard.
        const tally: BotScore = { x: 0, o: 0, draws: 0 };
        let lastScoredGame = -1;
        const recordGame = (gameIndex: number, gameWinner: number) => {
          if (gameIndex === lastScoredGame) return;
          lastScoredGame = gameIndex;
          if (gameWinner === 1) tally.x += 1;
          else if (gameWinner === 2) tally.o += 1;
          else if (gameWinner === 3) tally.draws += 1;
          setScore({ ...tally });
        };

        await new Promise<void>((resolve, reject) => {
          let steps = 0;
          timerRef.current = setInterval(() => {
            try {
              if (proto.isTerminal(tunnel.state)) {
                stopTimer();
                resolve();
                return;
              }
              if (steps++ >= maxSteps)
                throw new Error("caro self-play exceeded step bound");
              const inner = tunnel.state.inner;
              const innerOver = inner.winner !== 0;
              // Between games, A drives the advance with any cell; mid-game, the heuristic picks.
              const by: "A" | "B" = innerOver ? "A" : (inner.turn as "A" | "B");
              const cell = innerOver
                ? 0
                : pickCaroMove(
                    inner,
                    by,
                    Math.random,
                    strengthFor(difficultyRef.current, by),
                  );
              // Sign each update with the on-chain created_at so update_state's timestamp
              // check passes regardless of local clock skew.
              const r = tunnel.step({ cell }, by, {
                mode: "full",
                timestamp: createdAt,
              });
              if (!r.verified)
                throw new Error(`state ${r.nonce} failed dual-verify`);

              moveCountRef.current += 1;
              actionsRef.current += 1;

              const next = tunnel.state;
              setBoard([...next.inner.board]);
              setSize(next.inner.size);
              setLastMove(next.inner.lastMove);
              setTurn(next.inner.turn as "A" | "B");
              setWinner(next.inner.winner);
              setCurrentGame(next.gamesPlayed + 1);
              if (next.inner.winner !== 0)
                recordGame(next.gamesPlayed, next.inner.winner);

              if (proto.isTerminal(next)) {
                stopTimer();
                resolve();
              }

              flushHeartbeat(tunnelId, false);
            } catch (err) {
              stopTimer();
              reject(err);
            }
          }, STEP_MS);
        });

        const finalInner = tunnel.state.inner;
        setBoard([...finalInner.board]);
        setLastMove(finalInner.lastMove);
        setWinner(finalInner.winner);

        // 5) checkpoint the FINAL co-signed state (update_state) before the root close.
        setPhase("settling");
        flushHeartbeat(tunnelId, true);
        const latest = tunnel.latest;
        if (latest) {
          const ures = await submit(
            buildUpdateStateTx(tunnelId, latest),
            bots.x.keypair,
          );
          setDigests((d) => ({ ...d, update: ures.digest }));
        }

        // 6) settle: anchor the transcript root AND distribute funds in one cooperative close.
        const root = transcript.root();
        const onchainNonce = latest ? latest.update.nonce : 0n;
        const s = tunnel.buildSettlementWithRoot(createdAt, root, onchainNonce);
        const closeRes = await submit(
          buildSettleWithRootTx(tunnelId, s),
          bots.x.keypair,
        );
        setDigests((d) => ({
          ...d,
          close: closeRes.digest,
          root: `0x${bytesToHex(root)}`,
        }));

        // Record the settled tunnel into the history (newest first), then reset the running
        // score so the next tunnel starts fresh — each settle resets the player tally.
        const record: TunnelRecord = {
          tunnelId,
          closeDigest: closeRes.digest,
          rootHex: `0x${bytesToHex(root)}`,
          games: tally.x + tally.o + tally.draws,
          x: tally.x,
          o: tally.o,
          draws: tally.draws,
        };
        setTunnels((prev) => [record, ...prev].slice(0, MAX_TUNNELS_LOGGED));
        setScore({ x: 0, o: 0, draws: 0 });
        try {
          localStorage.setItem(
            SCORE_KEY,
            JSON.stringify({ x: 0, o: 0, draws: 0 }),
          );
        } catch {
          /* ignore */
        }

        const b = await refreshBalances();
        setPhase("done");

        // 7) auto-play: next tunnel until a bot is low on gas.
        if (autoRef.current) {
          if (b && b.x >= MIN_PLAY_MIST && b.o >= MIN_PLAY_MIST) {
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
        autoRef.current = false;
        setAuto(false);
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [bots, client, submit, refreshBalances, stopTimer]);

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
      balancesRef.current.x < MIN_PLAY_MIST ||
      balancesRef.current.o < MIN_PLAY_MIST
    ) {
      setError("Fund the bots first");
      setPhase("error");
      return;
    }
    autoRef.current = true;
    setAuto(true);
    runGame();
  }, [runGame]);

  const resetScore = useCallback(() => {
    const zero: BotScore = { x: 0, o: 0, draws: 0 };
    setScore(zero);
    try {
      localStorage.setItem(SCORE_KEY, JSON.stringify(zero));
    } catch {
      /* ignore */
    }
  }, []);

  const stopAuto = useCallback(() => {
    autoRef.current = false;
    setAuto(false);
    if (nextRef.current !== null) {
      clearTimeout(nextRef.current);
      nextRef.current = null;
    }
    // Keep the settle history visible after stopping — it's the record of what was played.
  }, []);

  const rebalance = useCallback(() => {
    void (async () => {
      setError(null);
      const b = balancesRef.current;
      const fromX = b.x >= b.o;
      const from = fromX ? bots.x : bots.o;
      const to = fromX ? bots.o : bots.x;
      const diff = fromX ? b.x - b.o : b.o - b.x;
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
    board,
    boardSize: size,
    lastMove,
    turn,
    winner,
    phase,
    error,
    digests,
    balances,
    score,
    tunnels,
    auto,
    rebalancing,
    maxGames,
    currentGame,
    setMaxGames,
    fund,
    rebalance,
    refresh: refreshBalances,
    resetScore,
    newGame,
    startAuto,
    stopAuto,
  };
}

export type { BotIdentity };
