import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, proof, protocols, bytesToHex } from "sui-tunnel-ts";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "@/backend/controlPlane";
import { useTelemetry } from "@/telemetry/TelemetryProvider";
import { settleViaBackend } from "@/backend/settle";
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
import { makeKeypairSponsoredSignExec } from "@/onchain/sponsor";
import {
  DOPAMINT_COIN_TYPE,
  ensureDopamintStakeCoin,
  isDopamintConfigured,
} from "@/onchain/dopamint";

// The move pickers reason over a single inner TTT game (board/turn/winner).
type State = protocols.TicTacToeState;

// Default number of games to play within ONE tunnel before settling once.
const DEFAULT_MAX_GAMES = 5;
const MIN_MAX_GAMES = 1;
const MAX_MAX_GAMES = 100;

// "perfect" = both bots minimax (always draws); "even" = both heuristic (varied);
// "uneven" = botX (party A) minimax vs botO (party B) heuristic (X wins more).
export type Difficulty = "perfect" | "even" | "uneven" | "fast";

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

// One settled tunnel in the session history: the per-tunnel X/O/draw tally plus the on-chain
// close digest + transcript root. Recorded at close (newest first); cleared on a full stop.
// Shared by both arenas (TicTacToe and Caro).
export interface TunnelRecord {
  tunnelId: string;
  closeDigest?: string;
  rootHex?: string;
  games: number;
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
  /** Settled tunnels this session, newest first (one per on-chain close). */
  tunnels: TunnelRecord[];
  /** When true both sides auto-play (watch); when false you play X and the bot plays O. */
  auto: boolean;
  /** Toggle auto-play. Off hands X's turn to you; the bot keeps playing O automatically. */
  setAuto: (on: boolean) => void;
  /** True when auto is off and it's your turn (X) to place a mark. */
  myTurn: boolean;
  /** Place your (X) mark at this cell — manual mode only, on your turn, on an empty cell. */
  playCell: (cell: number) => void;
  rebalancing: boolean;
  /** Games to play within one tunnel before the single settle. */
  maxGames: number;
  /** 1-based index of the game currently being played in this tunnel. */
  currentGame: number;
  balancesLoaded: boolean;
  setMaxGames: (n: number) => void;
  fund: () => void;
  rebalance: () => void;
  refresh: () => Promise<{ x: bigint; o: bigint } | null>;
  resetScore: () => void;
  newGame: () => void;
  /** Begin a session. autoOn = start in watch (both bots); false = start in manual (you play X). */
  startAuto: (autoOn?: boolean) => void;
  stopAuto: () => void;
}

const SCORE_KEY = "ttt_bot_score.v1";
const EMPTY_BOARD = Array(9).fill(0) as number[];
// Cap the in-session settle history so a long auto-play run can't grow it without bound.
const MAX_TUNNELS_LOGGED = 30;
const STEP_MS = 600;
// A bot must hold at least this much (gas for its txs + the 1-MIST deposit) to safely play
// another game; below it, auto-play stops rather than risk a mid-game tx running out of gas
// and leaving a tunnel open. ~0.02 SUI (a game costs the busier bot ~0.01 SUI of gas).
const MIN_PLAY_MIST = 20_000_000n;
// DOPAMINT mode: per-seat stake (1 DOPAMINT, 9 decimals). Both seats are funded from one coin.
const DOPAMINT_PER_SEAT = 1_000_000_000n;
// SUI-fallback per-seat stake (MIST), when the DOPAMINT env is unset.
const SUI_PER_SEAT = 1n;
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
  if (difficulty === "fast") {
    const empties = state.board
      .map((v, i) => (v === 0 ? i : -1))
      .filter((i) => i >= 0);
    return empties[Math.floor(Math.random() * empties.length)];
  }
  if (difficulty === "perfect") return minimaxCell(state, by);
  if (difficulty === "uneven") {
    // botX (party A) plays perfectly; botO (party B) plays the heuristic.
    return by === "A" ? minimaxCell(state, by) : heuristicCell(state, by);
  }
  return heuristicCell(state, by); // "even"
}

export function useBotGame(difficulty: Difficulty = "fast"): BotGameView {
  const { report } = useTelemetry();
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
  const [tunnels, setTunnels] = useState<TunnelRecord[]>([]);
  const [auto, setAutoState] = useState(true);
  const [rebalancing, setRebalancing] = useState(false);
  const [maxGames, setMaxGamesState] = useState<number>(DEFAULT_MAX_GAMES);
  const [currentGame, setCurrentGame] = useState<number>(1);
  const [balancesLoaded, setBalancesLoaded] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRef = useRef(true); // mirror of `auto` (auto-play) readable inside async flows
  // A play session is live (drives tunnel-after-tunnel continuation), decoupled from `auto` so
  // unticking auto switches X to manual without ending the session.
  const playingRef = useRef(false);
  // A user-queued cell (X) the running interval applies on its next tick, so the manual move
  // reuses the loop's single step/telemetry/score site.
  const pendingCellRef = useRef<number | null>(null);
  const balancesRef = useRef<{ x: bigint; o: bigint }>({ x: 0n, o: 0n });
  const runRef = useRef<() => void>(() => {});
  const difficultyRef = useRef<Difficulty>(difficulty);
  difficultyRef.current = difficulty; // always reflects the latest chosen difficulty
  const maxGamesRef = useRef<number>(DEFAULT_MAX_GAMES);
  maxGamesRef.current = maxGames; // read the latest count inside async self-play

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
      .catch((e) => console.error("[ttt bot] heartbeat failed:", e));
  }, []);

  // Clamp the games-per-tunnel control to a sane range.
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
    } finally {
      setBalancesLoaded(true);
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

  // DOPAMINT mode (ADR-0010): a gas-sponsored signer for a bot keypair. The settler pays gas, so
  // the bot needs zero SUI — it only signs the open/close. Faucet-minted DOPAMINT is the stake.
  const botSponsoredSignExec = useCallback(
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
    // DOPAMINT mode: gas is sponsored and the stake is faucet-minted, so the bots need no SUI —
    // skip the gas gate. SUI fallback still requires a real gas balance per bot.
    if (
      !isDopamintConfigured &&
      (balancesRef.current.x < MIN_PLAY_MIST ||
        balancesRef.current.o < MIN_PLAY_MIST)
    ) {
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
    // The scoreboard shows the CURRENT tunnel's tally and resets each tunnel; the settled tally
    // is preserved in the tunnel history.
    setScore({ x: 0, o: 0, draws: 0 });

    // One multi-game protocol instance per tunnel, sized by the current control.
    const proto = new MultiGameTicTacToeProtocol(maxGamesRef.current, 0n);

    void (async () => {
      try {
        const partyX = { address: bots.x.address, publicKey: bots.x.publicKey };
        const partyO = { address: bots.o.address, publicKey: bots.o.publicKey };

        // DOPAMINT mode (ADR-0010): stake faucet-minted DOPAMINT and sponsor bot X's open/close
        // gas (no SUI). SUI fallback (env unset): bot X funds the stakes from its own gas coin.
        const dopamintOn = isDopamintConfigured;
        const coinType = dopamintOn ? DOPAMINT_COIN_TYPE : undefined;
        const stakePerSeat = dopamintOn ? DOPAMINT_PER_SEAT : SUI_PER_SEAT;
        // Bot X (party A) signs every on-chain tx; in DOPAMINT mode that's the sponsored signer.
        const xSignExec = dopamintOn ? botSponsoredSignExec(bots.x) : null;

        // 1) open + fund (both stakes) + activate in ONE tx: bot X signs a single create_and_fund
        // that funds both parties. Bot O signs nothing on-chain; the tunnel is active the moment
        // this lands. In DOPAMINT mode, both stakes split off one faucet-minted coin (sponsored
        // gas has no gas coin to split); in SUI mode, off bot X's gas coin.
        setPhase("opening");
        let tunnelId: string;
        let createDigest: string;
        if (dopamintOn && xSignExec) {
          // Self-play funds BOTH seats from one coin, so faucet/select for the 2-seat total.
          const stakeCoinId = await ensureDopamintStakeCoin({
            client: client as never,
            signExec: xSignExec,
            owner: bots.x.address,
            need: 2n * stakePerSeat,
          });
          const { digest } = await xSignExec(
            buildCreateAndFundTx(partyX, partyO, stakePerSeat, {
              coinType,
              stakeCoinId,
            }),
          );
          await client.waitForTransaction({ digest });
          const txb = await client.getTransactionBlock({
            digest,
            options: { showObjectChanges: true },
          });
          const id = parseTunnelId(txb.objectChanges);
          if (!id) throw new Error("could not find created Tunnel id");
          tunnelId = id;
          createDigest = digest;
        } else {
          const createRes = await submit(
            buildCreateAndFundTx(partyX, partyO, stakePerSeat),
            bots.x.keypair,
          );
          const id = parseTunnelId(createRes.objectChanges);
          if (!id) throw new Error("could not find created Tunnel id");
          tunnelId = id;
          createDigest = createRes.digest;
        }
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
          { a: stakePerSeat, b: stakePerSeat },
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
            userAddress: bots.x.address,
            game: "tictactoe",
            tunnels: [
              { tunnelId, partyA: bots.x.address, partyB: bots.o.address },
            ],
          })
          .then((s) => {
            sessionRef.current = s;
          })
          .catch((e) => console.error("[ttt bot] registerSession failed:", e));

        // 4) animate moves across all N games; each .step co-signs AND verifies both
        //    sigs (mode "full"). A move either advances the live inner game or, when
        //    the inner game has just finished, resets to the next game's board. We
        //    record each finished game's winner exactly once into the running score.
        setPhase("playing");
        // This tunnel's running tally. Tracked locally (not via the score state) so the close
        // handler can read the final tally without a stale-state read; mirrored into `score`
        // for the live scoreboard. Track the inner game we last counted so we score each once.
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

        pendingCellRef.current = null; // drop any cell queued during the inter-tunnel gap
        await new Promise<void>((resolve, reject) => {
          const delay = difficultyRef.current === "fast" ? 50 : STEP_MS;
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
              // Manual play (auto off): pause on X's turn (party A) and apply only a user-queued
              // cell; the bot still plays O and finished games still auto-advance.
              let cell: number;
              if (!isAdvance && !autoRef.current && by === "A") {
                if (pendingCellRef.current === null) {
                  flushHeartbeat(tunnelId, false);
                  return; // wait for the user's move
                }
                cell = pendingCellRef.current;
                pendingCellRef.current = null;
              } else {
                cell = isAdvance
                  ? 0
                  : pickCell(inner, by, difficultyRef.current);
              }
              // Sign each update with the on-chain created_at (a validator timestamp,
              // always >= created_at and <= now) so the final co-signed state passes
              // update_state's timestamp check regardless of local clock skew.
              const r = tunnel.step({ cell }, by, {
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

              const next = tunnel.state;
              setBoard([...next.inner.board]);
              setTurn(next.inner.turn as "A" | "B");
              setWinner(next.inner.winner);
              setCurrentGame(next.gamesPlayed + 1);

              // A finished inner game (winner set) is game number gamesPlayed+1.
              if (next.inner.winner !== 0) {
                recordGame(next.gamesPlayed, next.inner.winner);
                const w = next.inner.winner;
                const row = {
                  id: moveCountRef.current,
                  game: "tic-tac-toe",
                  time: new Date().toLocaleTimeString("en-GB"),
                  bot: bots.x.address,
                  type: w === 1 ? "X win" : w === 2 ? "O win" : "Draw",
                  status: "Success" as const,
                  amount: "",
                };
                // Live Transactions is backend-sourced (on-chain indexer); only My Activity is local.
                report.pushLocalTxn(row);
              }

              if (proto.isTerminal(next)) {
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

        // Reflect the final game's board/winner.
        const finalInner = tunnel.state.inner;
        setBoard([...finalInner.board]);
        setWinner(finalInner.winner);

        // 5) checkpoint the FINAL co-signed state on-chain (update_state) so the tunnel
        // object's state field shows the played-out state_hash + balances + nonce, then
        // close with the transcript root. Steps are signed with created_at, so the latest
        // update passes the timestamp check.
        setPhase("settling");
        flushHeartbeat(tunnelId, true);

        const root = transcript.root();
        const s = tunnel.buildSettlementWithRoot(createdAt, root, 0n);

        let closeDigest = "";
        const backendDigest = await settleViaBackend({
          tunnelId,
          settlement: s,
          transcript: transcript.toRecord().entries,
          label: "tictactoe",
          fallbackClose: async () => {
            // DOPAMINT mode: close via the sponsored signer (no SUI); else bot X's keypair.
            if (dopamintOn && xSignExec) {
              const { digest } = await xSignExec(
                buildSettleWithRootTx(tunnelId, s, coinType),
              );
              await client.waitForTransaction({ digest });
              closeDigest = digest;
            } else {
              const closeRes = await submit(
                buildSettleWithRootTx(tunnelId, s),
                bots.x.keypair,
              );
              closeDigest = closeRes.digest;
            }
          },
        });
        // Backend /settle returns its close digest; the fallback assigns its own (above).
        if (backendDigest) closeDigest = backendDigest;

        setDigests((d) => ({
          ...d,
          close: closeDigest,
          root: `0x${bytesToHex(root)}`,
        }));
        report.pushTxn({
          id: actionsRef.current,
          game: "tic-tac-toe",
          digest: closeDigest,
          address: bots.x.address,
          time: new Date().toLocaleTimeString("en-GB"),
          bot: bots.x.address,
          type: "Settle",
          status: "Success",
          amount: "",
        });
        report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
        report.setActive(0);

        // Record the settled tunnel into the history (newest first), then reset the running
        // score so the next tunnel starts fresh — each settle resets the player tally.
        const record: TunnelRecord = {
          tunnelId,
          closeDigest,
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

        // 7) continue tunnel-after-tunnel while the session is live (auto or manual). DOPAMINT
        // mode: gas is sponsored + the stake is faucet-minted, so bots can't run out — skip the
        // SUI gate; SUI fallback still stops when a bot is low on gas.
        if (playingRef.current) {
          if (
            dopamintOn ||
            (b && b.x >= MIN_PLAY_MIST && b.o >= MIN_PLAY_MIST)
          ) {
            nextRef.current = setTimeout(() => {
              if (playingRef.current) runRef.current();
            }, NEXT_GAME_MS);
          } else {
            playingRef.current = false;
            setError(
              "A bot is low on gas — play stopped. Fund the bots to continue.",
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
  }, [bots, client, submit, botSponsoredSignExec, refreshBalances, stopTimer]);

  // keep a ref to the latest runGame so the auto-play timeout always calls the current one.
  useEffect(() => {
    runRef.current = runGame;
  }, [runGame]);

  // Auto-play toggle. The running interval reads autoRef live: off makes it wait for a queued
  // cell on X's turn, on resumes auto-playing both sides.
  const setAuto = useCallback((on: boolean) => {
    autoRef.current = on;
    setAutoState(on);
  }, []);

  // Queue your (X) move for the running interval to apply. No-op unless it's actually your turn
  // in manual mode on an empty cell.
  const playCell = useCallback(
    (cell: number) => {
      if (autoRef.current || phase !== "playing" || winner !== 0) return;
      if (turn !== "A") return;
      if (cell < 0 || cell >= board.length || board[cell] !== 0) return;
      pendingCellRef.current = cell;
    },
    [phase, winner, turn, board],
  );

  // Your turn = auto off, a game is in progress, and it's X (party A) to move.
  const myTurn = !auto && phase === "playing" && winner === 0 && turn === "A";

  const newGame = useCallback(() => {
    setAuto(false);
    playingRef.current = false; // single game: don't auto-continue
    runGame();
  }, [runGame, setAuto]);

  // autoOn picks the starting mode: a fresh window starts in watch (auto on); entering from the
  // main menu starts in manual (auto off) so you play X yourself.
  const startAuto = useCallback(
    (autoOn: boolean = true) => {
      // DOPAMINT mode: bots play free (sponsored gas + faucet stake), so skip the SUI gate.
      if (
        !isDopamintConfigured &&
        (balancesRef.current.x < MIN_PLAY_MIST ||
          balancesRef.current.o < MIN_PLAY_MIST)
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
    playingRef.current = false;
    pendingCellRef.current = null;
    stopTimer();
    if (nextRef.current !== null) {
      clearTimeout(nextRef.current);
      nextRef.current = null;
    }
    // Keep the settle history visible after stopping — it's the record of what was played.
  }, [stopTimer]);

  // Move half the balance difference from the richer bot to the poorer one (richer bot signs).
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
    turn,
    winner,
    phase,
    error,
    digests,
    balances,
    score,
    tunnels,
    auto,
    setAuto,
    myTurn,
    playCell,
    rebalancing,
    maxGames,
    currentGame,
    balancesLoaded,
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
