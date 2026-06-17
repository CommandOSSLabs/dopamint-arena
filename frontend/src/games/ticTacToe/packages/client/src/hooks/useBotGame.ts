import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, proof, protocols, bytesToHex } from "sui-tunnel-ts";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import {
  optimalMoves,
  CELL_EMPTY,
  CELL_PLAYER,
  CELL_SERVER,
  MultiGameTicTacToeProtocol,
  type MultiGameTicTacToeState,
} from "@ttt/shared";
import {
  buildCreateAndFundTx,
  buildSettleWithRootTx,
  buildUpdateStateTx,
  parseTunnelId,
} from "@/lib/tunnel";
import {
  loadOrCreateBots,
  getSuiClient,
  botBalances,
  fundBots,
  transferBetweenBots,
  type BotIdentity,
} from "@/lib/bots";

// The move pickers reason over a single inner TTT game (board/turn/winner).
type State = protocols.TicTacToeState;

// Default number of games to play within ONE tunnel before settling once.
const DEFAULT_MAX_GAMES = 5;
const MIN_MAX_GAMES = 1;
const MAX_MAX_GAMES = 100;

// "perfect" = both bots minimax (always draws); "even" = both heuristic (varied);
// "uneven" = botX (party A) minimax vs botO (party B) heuristic (X wins more).
export type Difficulty = "perfect" | "even" | "uneven";

export type BotPhase =
  | "idle"
  | "funding"
  | "opening"
  | "playing"
  | "settling"
  | "done"
  | "error";

export interface BotDigests {
  /** The single open+fund+activate tx (create_and_fund), signed by bot X. */
  create?: string;
  /** Checkpoint of the final co-signed state (update_state), submitted before close. */
  update?: string;
  close?: string;
  /** Hex of the transcript Merkle root anchored on-chain at close (0x-prefixed). */
  root?: string;
}

export interface BotScore {
  x: number;
  o: number;
  draws: number;
}

export interface BotGameView {
  board: number[];
  turn: "A" | "B";
  winner: number;
  phase: BotPhase;
  error: string | null;
  digests: BotDigests;
  balances: { x: bigint; o: bigint };
  score: BotScore;
  auto: boolean;
  rebalancing: boolean;
  /** Games to play within one tunnel before the single settle. */
  maxGames: number;
  /** 1-based index of the game currently being played in this tunnel. */
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

const SCORE_KEY = "ttt_bot_score.v1";
const EMPTY_BOARD = Array(9).fill(0) as number[];
const STEP_MS = 600;
// A bot must hold at least this much (gas for its txs + the 1-MIST deposit) to safely play
// another game; below it, auto-play stops rather than risk a mid-game tx running out of gas
// and leaving a tunnel open. ~0.02 SUI (a game costs the busier bot ~0.01 SUI of gas).
const MIN_PLAY_MIST = 20_000_000n;
// Pause between auto-played games.
const NEXT_GAME_MS = 1200;

function loadScore(): BotScore {
  try {
    const s = localStorage.getItem(SCORE_KEY);
    if (s) return JSON.parse(s) as BotScore;
  } catch {
    /* ignore */
  }
  return { x: 0, o: 0, draws: 0 };
}

// Perfect play via full-depth minimax (from @ttt/shared). Maps protocol marks (1=A, 2=B) into
// @ttt/shared's CELL_SERVER (= side to move) / CELL_PLAYER (= opponent) convention.
function minimaxCell(state: State, party: "A" | "B"): number {
  const mark = party === "A" ? 1 : 2;
  const board = state.board.map((v) =>
    v === 0 ? CELL_EMPTY : v === mark ? CELL_SERVER : CELL_PLAYER,
  );
  return optimalMoves(board, CELL_SERVER)[0];
}

// "competent but imperfect": take a winning move, else block the opponent, else random empty.
function heuristicCell(state: State, party: "A" | "B"): number {
  const me = party === "A" ? 1 : 2;
  const opp = me === 1 ? 2 : 1;
  const empties = state.board
    .map((v, i) => (v === 0 ? i : -1))
    .filter((i) => i >= 0);
  const LINES = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];
  const findFinish = (who: number) => {
    for (const [a, b, c] of LINES) {
      const line = [a, b, c];
      const empt = line.find((i) => state.board[i] === 0);
      const mine = line.filter((i) => state.board[i] === who).length;
      if (mine === 2 && empt !== undefined) return empt;
    }
    return -1;
  };
  const win = findFinish(me);
  if (win >= 0) return win;
  const block = findFinish(opp);
  if (block >= 0) return block;
  return empties[Math.floor(Math.random() * empties.length)];
}

// Pick a move for the side to move, per chosen difficulty.
function pickCell(state: State, by: "A" | "B", difficulty: Difficulty): number {
  if (difficulty === "perfect") return minimaxCell(state, by);
  if (difficulty === "uneven") {
    // botX (party A) plays perfectly; botO (party B) plays the heuristic.
    return by === "A" ? minimaxCell(state, by) : heuristicCell(state, by);
  }
  return heuristicCell(state, by); // "even"
}

export function useBotGame(difficulty: Difficulty = "even"): BotGameView {
  const bots = useMemo(() => loadOrCreateBots(), []);
  const client = useMemo(() => getSuiClient(), []);

  const [board, setBoard] = useState<number[]>(EMPTY_BOARD);
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
  const [auto, setAuto] = useState(false);
  const [rebalancing, setRebalancing] = useState(false);
  const [maxGames, setMaxGamesState] = useState<number>(DEFAULT_MAX_GAMES);
  const [currentGame, setCurrentGame] = useState<number>(1);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRef = useRef(false); // mirror of `auto` readable inside async flows
  const balancesRef = useRef<{ x: bigint; o: bigint }>({ x: 0n, o: 0n });
  const runRef = useRef<() => void>(() => {});
  const difficultyRef = useRef<Difficulty>(difficulty);
  difficultyRef.current = difficulty; // always reflects the latest chosen difficulty
  const maxGamesRef = useRef<number>(DEFAULT_MAX_GAMES);
  maxGamesRef.current = maxGames; // read the latest count inside async self-play

  // Clamp the games-per-tunnel control to a sane range.
  const setMaxGames = useCallback((n: number) => {
    const clamped = Math.max(
      MIN_MAX_GAMES,
      Math.min(MAX_MAX_GAMES, Math.floor(Number.isFinite(n) ? n : DEFAULT_MAX_GAMES)),
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

  // Load balances on mount.
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

  // Run ONE tunnel that plays `maxGames` TTT games back-to-back and settles ONCE:
  // open+fund (one tx) -> animated multi-game self-play -> a single cooperative
  // close carrying the net balances. Per-game results update the running score as
  // each game finishes inside the tunnel. When auto-play is on, schedules the next
  // *tunnel* (or stops if a bot is low on gas).
  const runGame = useCallback(() => {
    stopTimer();
    if (balancesRef.current.x < MIN_PLAY_MIST || balancesRef.current.o < MIN_PLAY_MIST) {
      autoRef.current = false;
      setAuto(false);
      setError("Fund the bots first");
      setPhase("error");
      return;
    }
    setError(null);
    setBoard(EMPTY_BOARD);
    setTurn("A");
    setWinner(0);
    setDigests({});
    setCurrentGame(1);

    // One multi-game protocol instance per tunnel, sized by the current control.
    const proto = new MultiGameTicTacToeProtocol(maxGamesRef.current, 0n);

    void (async () => {
      try {
        const partyX = { address: bots.x.address, publicKey: bots.x.publicKey };
        const partyO = { address: bots.o.address, publicKey: bots.o.publicKey };

        // 1) open + fund (both 1-MIST stakes) + activate in ONE tx: bot X signs a single
        // create_and_fund that funds both parties from its own gas coin. Bot O signs nothing
        // on-chain; the tunnel is active the moment this lands.
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
        const createdAt = BigInt((fields?.created_at as string | undefined) ?? 0);

        // 3) off-chain self-play tunnel (both keys held locally), driving the
        //    multi-game protocol so ALL games share this single tunnel.
        const tunnel = core.OffchainTunnel.selfPlay<
          MultiGameTicTacToeState,
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

        // Accumulate every co-signed update into a transcript; its Merkle root is anchored
        // on-chain at close. Wire the observer BEFORE any step so no update is missed.
        const transcript = new proof.Transcript(tunnelId);
        tunnel.onUpdate = (u) => transcript.append(u);

        // 4) animate moves across all N games; each .step co-signs AND verifies both
        //    sigs (mode "full"). A move either advances the live inner game or, when
        //    the inner game has just finished, resets to the next game's board. We
        //    record each finished game's winner exactly once into the running score.
        setPhase("playing");
        // Track the inner game we last counted so we score each game once. -1 = none.
        let lastScoredGame = -1;
        const recordGame = (gameIndex: number, gameWinner: number) => {
          if (gameIndex === lastScoredGame) return;
          lastScoredGame = gameIndex;
          setScore((prev) => {
            const next: BotScore = {
              x: prev.x + (gameWinner === 1 ? 1 : 0),
              o: prev.o + (gameWinner === 2 ? 1 : 0),
              draws: prev.draws + (gameWinner === 3 ? 1 : 0),
            };
            try {
              localStorage.setItem(SCORE_KEY, JSON.stringify(next));
            } catch {
              /* ignore */
            }
            return next;
          });
        };

        await new Promise<void>((resolve, reject) => {
          timerRef.current = setInterval(() => {
            try {
              if (proto.isTerminal(tunnel.state)) {
                stopTimer();
                resolve();
                return;
              }
              const inner = tunnel.state.inner;
              // Pick the next move: a real cell mid-game, or any cell to advance
              // past a finished game (the protocol ignores the cell on reset).
              const isAdvance = inner.winner !== 0;
              const by = isAdvance ? "A" : (inner.turn as "A" | "B");
              const cell = isAdvance
                ? 0
                : pickCell(inner, by, difficultyRef.current);
              // Sign each update with the on-chain created_at (a validator timestamp,
              // always >= created_at and <= now) so the final co-signed state passes
              // update_state's timestamp check regardless of local clock skew.
              const r = tunnel.step({ cell }, by, {
                mode: "full",
                timestamp: createdAt,
              });
              if (!r.verified)
                throw new Error(`state ${r.nonce} failed dual-verify`);

              const next = tunnel.state;
              setBoard([...next.inner.board]);
              setTurn(next.inner.turn as "A" | "B");
              setWinner(next.inner.winner);
              setCurrentGame(next.gamesPlayed + 1);

              // A finished inner game (winner set) is game number gamesPlayed+1.
              if (next.inner.winner !== 0) {
                recordGame(next.gamesPlayed, next.inner.winner);
              }

              if (proto.isTerminal(next)) {
                stopTimer();
                resolve();
              }
            } catch (err) {
              stopTimer();
              reject(err);
            }
          }, STEP_MS);
        });

        // Reflect the final game's board/winner.
        const finalInner = tunnel.state.inner;
        setBoard([...finalInner.board]);
        setWinner(finalInner.winner);

        // 5) checkpoint the FINAL co-signed state on-chain (update_state) so the tunnel
        // object's state field shows the played-out state_hash + balances + nonce, then
        // close with the transcript root. Steps are signed with created_at, so the latest
        // update passes the timestamp check.
        setPhase("settling");
        const latest = tunnel.latest;
        if (latest) {
          const ures = await submit(
            buildUpdateStateTx(tunnelId, latest),
            bots.x.keypair,
          );
          setDigests((d) => ({ ...d, update: ures.digest }));
        }

        // 6) settle: anchor the transcript root AND distribute funds in one cooperative close.
        // The root commits to EVERY co-signed update. After update_state the on-chain
        // state.nonce is latest.nonce (N), so close_cooperative_with_root derives finalNonce
        // = N + 1 — pass onchainNonce N so the signed settlement matches.
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

        const b = await refreshBalances();
        setPhase("done");

        // 7) auto-play: continue with the next tunnel until a bot is low on gas.
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
        autoRef.current = false; // never loop on errors
        setAuto(false);
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [bots, client, submit, refreshBalances, stopTimer]);

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
    if (balancesRef.current.x < MIN_PLAY_MIST || balancesRef.current.o < MIN_PLAY_MIST) {
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
  }, []);

  // Move half the balance difference from the richer bot to the poorer one (richer bot signs).
  const rebalance = useCallback(() => {
    void (async () => {
      setError(null);
      const b = balancesRef.current;
      const fromX = b.x >= b.o;
      const from = fromX ? bots.x : bots.o;
      const to = fromX ? bots.o : bots.x;
      const diff = (fromX ? b.x - b.o : b.o - b.x);
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
    turn,
    winner,
    phase,
    error,
    digests,
    balances,
    score,
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
