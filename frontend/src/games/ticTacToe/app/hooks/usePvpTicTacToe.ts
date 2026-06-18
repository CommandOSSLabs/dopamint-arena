// frontend/src/games/ticTacToe/packages/client/src/hooks/usePvpTicTacToe.ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, bytesToHex, hexToBytes, type protocols } from "sui-tunnel-ts";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { getControlPlaneClient, type RegisterSessionResult } from "@/backend/controlPlane";
import {
  MultiGameTicTacToeProtocol,
  MultiGameCaroProtocol,
  optimalMoves,
  CELL_EMPTY,
  CELL_SERVER,
  CELL_PLAYER,
  pickCaroMove,
} from "@ttt/shared";
import { getSuiClient } from "@/games/ticTacToe/app/lib/bots";
import {
  getOrCreateEphemeral,
  balanceOf,
  type PvpEphemeral,
} from "@/games/ticTacToe/app/lib/pvpIdentity";
import { useCustomWallet } from "@/games/ticTacToe/app/contexts/CustomWallet";
import {
  buildCreateAndShareTx,
  buildDepositTx,
  buildCloseTx,
  parseTunnelId,
} from "@/games/ticTacToe/app/lib/pvpOnchain";
import { RelayClient } from "@/games/ticTacToe/app/lib/pvpRelay";

export type Variant = "ttt" | "caro";

const MP_URL = import.meta.env.VITE_MP_URL ?? "ws://127.0.0.1:8080";
const STAKE = 1n; // MIST per game; caro's protocol forces 0 regardless
const BANKROLL = 1000n; // MIST deposited per seat
const MAX_GAMES = 1000; // high cap → play until a side stops or busts
const MOVE_MS = 600; // auto move cadence
const NEXT_MS = 800; // pause before auto-advancing to the next game

export type PvpPhase =
  | "idle"
  | "connecting"
  | "queuing"
  | "opening"
  | "funding"
  | "playing"
  | "settling"
  | "done"
  | "error";

export interface GameResult {
  game: number;
  winner: 1 | 2 | 3;
} // 1 X, 2 O, 3 draw

// Minimal shared shape of both multi-game states (caro adds size/lastMove).
type InnerState = {
  board: number[];
  turn: "A" | "B";
  winner: number;
  balanceA: bigint;
  balanceB: bigint;
  size?: number;
  lastMove?: number;
};
type AnyState = { inner: InnerState; gamesPlayed: number; maxGames: number };
type CellMove = { cell: number };

export interface PvpTttView {
  phase: PvpPhase;
  error: string | null;
  role: "A" | "B" | null; // A = X (opener), B = O
  variant: Variant;
  board: number[];
  size: number;
  lastMove: number;
  turn: "A" | "B" | null;
  winner: number; // current game: 0 none | 1 X | 2 O | 3 draw
  myMark: 0 | 1 | 2; // 1 if I'm X, 2 if I'm O
  isMyTurn: boolean;
  innerOver: boolean; // current game finished (between games)
  terminal: boolean; // session terminal → auto-settle
  score: { x: number; o: number; draws: number };
  games: GameResult[];
  currentGame: number; // gamesPlayed + 1
  auto: boolean;
  address: string; // the connected zkLogin wallet (this seat's on-chain party)
  balance: bigint; // the connected wallet's SUI balance (MIST)
  digests: { create?: string; deposit?: string; close?: string };
  queue: () => void;
  play: (cell: number) => void;
  next: () => void;
  stop: () => void;
  setAuto: (on: boolean) => void;
  leave: () => void;
}

// Perfect 3×3 move via @ttt/shared minimax (maps protocol marks 1/2 to CELL_SERVER/CELL_PLAYER).
function tttBestCell(inner: InnerState, by: "A" | "B"): number {
  const mark = by === "A" ? 1 : 2;
  const board = inner.board.map((v) =>
    v === 0 ? CELL_EMPTY : v === mark ? CELL_SERVER : CELL_PLAYER,
  );
  return optimalMoves(board, CELL_SERVER)[0];
}

export function usePvpTicTacToe(
  variant: Variant,
  boardSize: number,
): PvpTttView {
  const client = useMemo<SuiJsonRpcClient>(() => getSuiClient(), []);
  const eph = useMemo<PvpEphemeral>(() => getOrCreateEphemeral(), []);
  const wallet = useCustomWallet();
  const walletRef = useRef(wallet);
  walletRef.current = wallet; // read the latest wallet inside stable callbacks without re-creating them
  const proto = useMemo(
    () =>
      (variant === "caro"
        ? new MultiGameCaroProtocol(MAX_GAMES, boardSize)
        : new MultiGameTicTacToeProtocol(
            MAX_GAMES,
            STAKE,
          )) as unknown as protocols.Protocol<AnyState, CellMove>,
    [variant, boardSize],
  );

  const [phase, setPhase] = useState<PvpPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"A" | "B" | null>(null);
  const [state, setState] = useState<AnyState | null>(null);
  const [games, setGames] = useState<GameResult[]>([]);
  // `score` is the authoritative cumulative tally; `games` below is capped at the last 50 entries
  // for display, so after 50 games the two intentionally diverge — do NOT re-derive score from games.
  const [score, setScore] = useState({ x: 0, o: 0, draws: 0 });
  const [auto, setAutoState] = useState(false);
  const [balance, setBalance] = useState<bigint>(0n);
  const [digests, setDigests] = useState<{
    create?: string;
    deposit?: string;
    close?: string;
  }>({});

  const relayRef = useRef<RelayClient | null>(null);
  const tunnelRef = useRef<core.DistributedTunnel<AnyState, CellMove> | null>(
    null,
  );
  const roleRef = useRef<"A" | "B" | null>(null);
  const autoRef = useRef(false);
  const createdAtRef = useRef<bigint>(0n);
  const matchIdRef = useRef<string>("");
  const settledRef = useRef(false);
  const stoppingRef = useRef(false);
  const onMatchRef = useRef<
    | ((
        relay: RelayClient,
        m: { matchId: string; role: "A" | "B"; opponentWallet: string },
      ) => Promise<void>)
    | undefined
  >(undefined);
  const openedResolveRef = useRef<((id: string) => void) | null>(null);
  const settleResolveRef = useRef<((sig: Uint8Array) => void) | null>(null);
  const bufferedSettleRef = useRef<Uint8Array | null>(null);
  const helloResolveRef = useRef<((pub: string) => void) | null>(null);
  const bufferedHelloRef = useRef<string | null>(null);

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
      .catch((e) => console.error("[tictactoe pvp] heartbeat failed:", e));
  }, []);

  const refreshBalance = useCallback(async () => {
    const addr = walletRef.current.address;
    setBalance(addr ? await balanceOf(client, addr) : 0n);
  }, [client]);
  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance, wallet.address]);

  // The connected zkLogin wallet signs + pays gas (sender-pays, no Enoki sponsorship) so the
  // deposit splits from the wallet's own coin. We then fetch the tx for objectChanges/effects.
  const submit = useCallback(
    async (tx: any) => {
      const digest = await walletRef.current.executeTransaction({ tx });
      const res = await client.getTransactionBlock({
        digest,
        options: { showObjectChanges: true, showEffects: true },
      });
      if (res.effects?.status?.status !== "success")
        throw new Error(res.effects?.status?.error ?? "tx failed");
      return res;
    },
    [client],
  );

  const finishSettle = useCallback(
    async (
      t: core.DistributedTunnel<AnyState, CellMove>,
      relay: RelayClient,
      matchId: string,
    ) => {
      if (settledRef.current) return;
      settledRef.current = true;
      setPhase("settling");
      flushHeartbeat(t.tunnelId, true);
      const half = t.buildSettlementHalf(createdAtRef.current);
      relay.sendApp(matchId, { t: "settle", sig: bytesToHex(half.sigSelf) });
      const otherSig =
        bufferedSettleRef.current ??
        (await new Promise<Uint8Array>((res) => {
          settleResolveRef.current = res;
        }));
      const coSigned = t.combineSettlement(
        half.settlement,
        half.sigSelf,
        otherSig,
      );
      if (roleRef.current === "A") {
        // X (the opener) submits the cooperative close
        const res = await submit(buildCloseTx(t.tunnelId, coSigned));
        setDigests((d) => ({ ...d, close: res.digest }));
        relay.sendApp(matchId, { t: "closed", digest: res.digest });
      }
      await refreshBalance();
      setPhase("done");
    },
    [submit, refreshBalance, flushHeartbeat],
  );

  const queue = useCallback(() => {
    void (async () => {
      const w = walletRef.current;
      if (!w.isConnected || !w.address) {
        setError("Connect your wallet on the main menu first");
        setPhase("error");
        return;
      }
      setError(null);
      setPhase("connecting");
      settledRef.current = false;
      stoppingRef.current = false;
      setGames([]);
      setScore({ x: 0, o: 0, draws: 0 });
      autoRef.current = false;
      setAutoState(false); // fresh game (incl. rematch) starts in manual mode
      bufferedSettleRef.current = null;
      bufferedHelloRef.current = null;
      openedResolveRef.current = null;
      settleResolveRef.current = null;
      helloResolveRef.current = null;
      try {
        const relay = new RelayClient(MP_URL, w.address, eph.coreKey);
        relayRef.current = relay;
        await relay.ready;
        setPhase("queuing");
        relay.on("error", (m) => {
          setError(`${m.code}: ${m.message}`);
          setPhase("error");
        });
        relay.on("match.found", (m) => {
          void onMatchRef.current?.(relay, m as any);
        });
        // The queue key encodes the variant (+ board size for caro) so only players who chose the
        // SAME setup match — otherwise the two seats would run incompatible protocols and diverge.
        relay.queueJoin(
          variant === "caro" ? `tictactoe:caro:${boardSize}` : "tictactoe:ttt",
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [eph, variant, boardSize]);

  const onMatch = useCallback(
    async (
      relay: RelayClient,
      m: { matchId: string; role: "A" | "B"; opponentWallet: string },
    ) => {
      try {
        const w = walletRef.current;
        if (!w.address) throw new Error("wallet disconnected");
        matchIdRef.current = m.matchId;
        roleRef.current = m.role;
        setRole(m.role);
        // App-channel dispatcher: opened tunnelId, settle half, closed digest, stop request.
        relay.onApp(m.matchId, (mm) => {
          if (mm.t === "opened")
            openedResolveRef.current?.(String(mm.tunnelId));
          else if (mm.t === "settle") {
            const sig = hexToBytes(String(mm.sig));
            if (settleResolveRef.current) settleResolveRef.current(sig);
            else bufferedSettleRef.current = sig;
          } else if (mm.t === "closed")
            setDigests((d) => ({ ...d, close: String(mm.digest) }));
          else if (mm.t === "stop") {
            stoppingRef.current = true;
            if (tunnelRef.current)
              void finishSettle(tunnelRef.current, relay, m.matchId);
          }
        });
        // party.hello carries the single pubkey (no attestation): capture synchronously, buffer races.
        relay.on("party.hello", (h) => {
          if (h.matchId !== m.matchId) return;
          const pub = String(h.ephemeralPubkey);
          if (helloResolveRef.current) helloResolveRef.current(pub);
          else bufferedHelloRef.current = pub;
        });
        relay.partyHello(m.matchId, eph.pubkeyHex, ""); // ephemeral move-signer pubkey; walletSig unused in v1

        const oppPubHex =
          bufferedHelloRef.current ??
          (await new Promise<string>((res) => {
            helloResolveRef.current = res;
          }));
        // Opponent's move-signer pubkey. Their on-chain party is m.opponentWallet (matchmaker-reported,
        // self-asserted in v1); the two are deliberately unrelated keys, so there's no address derivation.
        const oppPubkey = hexToBytes(oppPubHex);

        // Roles: A = X (opener), B = O. X opens the tunnel registering partyA = self, partyB = opponent.
        // Party address = the zkLogin wallet (receives funds); party public_key = the ephemeral signer.
        let tunnelId: string;
        if (m.role === "A") {
          setPhase("opening");
          const res = await submit(
            buildCreateAndShareTx(
              { walletAddress: w.address, publicKey: eph.coreKey.publicKey }, // partyA = X (self)
              { walletAddress: m.opponentWallet, publicKey: oppPubkey }, // partyB = O (opponent)
              0n,
            ),
          );
          const id = parseTunnelId(res.objectChanges);
          if (!id) throw new Error("no tunnelId");
          tunnelId = id;
          setDigests((d) => ({ ...d, create: res.digest }));
          relay.tunnelOpened(m.matchId, tunnelId);
          relay.sendApp(m.matchId, { t: "opened", tunnelId });
        } else {
          setPhase("opening");
          tunnelId = await new Promise<string>((resolve) => {
            openedResolveRef.current = resolve;
          });
        }

        const obj = await client.getObject({
          id: tunnelId,
          options: { showContent: true },
        });
        const fields = (
          obj.data?.content as { fields?: Record<string, unknown> } | undefined
        )?.fields;
        createdAtRef.current = BigInt(
          (fields?.created_at as string | undefined) ?? 0,
        );

        setPhase("funding");
        const dep = await submit(buildDepositTx(tunnelId, BANKROLL));
        setDigests((d) => ({ ...d, deposit: dep.digest }));
        let activated = false;
        for (let i = 0; i < 40; i++) {
          const o = await client.getObject({
            id: tunnelId,
            options: { showContent: true },
          });
          const f = (
            o.data?.content as { fields?: Record<string, unknown> } | undefined
          )?.fields;
          if (
            Number(f?.status ?? 0) >= 1 &&
            BigInt((f?.party_a_deposit as string) ?? 0) > 0n &&
            BigInt((f?.party_b_deposit as string) ?? 0) > 0n
          ) {
            activated = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (!activated)
          throw new Error(
            "tunnel did not activate (opponent may not have funded)",
          );

        const backend = core.defaultBackend();
        const t = new core.DistributedTunnel<AnyState, CellMove>(
          proto,
          {
            tunnelId,
            self: core.makeEndpoint(
              backend,
              w.address,
              {
                publicKey: eph.coreKey.publicKey,
                scheme: 0,
                secretKey: eph.coreKey.secretKey,
              },
              true,
            ),
            opponent: core.makeEndpoint(
              backend,
              m.opponentWallet,
              { publicKey: oppPubkey, scheme: 0 },
              false,
            ),
            selfParty: m.role,
          },
          relay.transport(m.matchId),
          { a: BANKROLL, b: BANKROLL },
        );
        tunnelRef.current = t;

        // Register the (real, on-chain) tunnel for stats tracking. Best-effort.
        sessionRef.current = null;
        moveCountRef.current = 0;
        actionsRef.current = 0;
        lastHeartbeatRef.current = Date.now();
        getControlPlaneClient()
          .registerSession({
            userAddress: w.address,
            game: "tictactoe",
            tunnels: [
              {
                tunnelId,
                partyA: m.role === "A" ? w.address : m.opponentWallet,
                partyB: m.role === "B" ? w.address : m.opponentWallet,
              },
            ],
          })
          .then((s) => {
            sessionRef.current = s;
          })
          .catch((e) => console.error("[tictactoe pvp] registerSession failed:", e));

        let lastLoggedGame = 0;
        const onAdvance = () => {
          const st = t.state;
          setState({ ...st, inner: { ...st.inner } });
          // Log each completed game once (winner is set on the inner game just before the advance).
          const gameNo = st.gamesPlayed + 1;
          if (st.inner.winner !== 0 && gameNo > lastLoggedGame) {
            const w = st.inner.winner as 1 | 2 | 3;
            setGames((prev) =>
              [...prev, { game: gameNo, winner: w }].slice(-50),
            );
            setScore((prev) => ({
              x: prev.x + (w === 1 ? 1 : 0),
              o: prev.o + (w === 2 ? 1 : 0),
              draws: prev.draws + (w === 3 ? 1 : 0),
            }));
            lastLoggedGame = gameNo;
          }
          if (stoppingRef.current) return;
          if (proto.isTerminal(st)) {
            void finishSettle(t, relay, m.matchId);
            return;
          }
          if (st.inner.winner !== 0) {
            // Between games: only X (A) drives the advance (avoids a double-advance race).
            if (m.role === "A" && autoRef.current)
              setTimeout(() => {
                try {
                  t.propose({ cell: 0 }, BigInt(Date.now()));
                } catch {
                  /* raced */
                }
              }, NEXT_MS);
          } else if (st.inner.turn === m.role && autoRef.current) {
            const cell =
              variant === "caro"
                ? pickCaroMove(st.inner as any, m.role, Math.random, "strong")
                : tttBestCell(st.inner, m.role);
            setTimeout(() => {
              try {
                t.propose({ cell }, BigInt(Date.now()));
              } catch {
                /* not my turn / in flight */
              }
            }, MOVE_MS);
          }
        };
        t.onConfirmed = () => {
          moveCountRef.current += 1;
          actionsRef.current += 1;
          onAdvance();
          flushHeartbeat(tunnelId, false);
        };
        setPhase("playing");
        setState({ ...t.state, inner: { ...t.state.inner } });
        onAdvance();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    },
    [client, proto, submit, eph, variant, finishSettle, flushHeartbeat],
  );
  onMatchRef.current = onMatch;

  const play = useCallback((cell: number) => {
    const t = tunnelRef.current;
    if (!t) return;
    const st = t.state;
    if (st.inner.winner !== 0 || st.inner.turn !== roleRef.current) return; // not my turn / between games
    try {
      t.propose({ cell }, BigInt(Date.now()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const next = useCallback(() => {
    const t = tunnelRef.current;
    if (!t) return;
    if (
      roleRef.current !== "A" ||
      t.state.inner.winner === 0 ||
      proto.isTerminal(t.state)
    )
      return; // X advances between games
    try {
      t.propose({ cell: 0 }, BigInt(Date.now()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [proto]);

  const stop = useCallback(() => {
    const t = tunnelRef.current;
    const relay = relayRef.current;
    if (!t || !relay) return;
    if (t.state.inner.winner === 0) return; // settle cleanly between games
    stoppingRef.current = true;
    relay.sendApp(matchIdRef.current, { t: "stop" });
    void finishSettle(t, relay, matchIdRef.current);
  }, [finishSettle]);

  const setAuto = useCallback(
    (on: boolean) => {
      autoRef.current = on;
      setAutoState(on);
      const t = tunnelRef.current;
      if (!on || !t || stoppingRef.current || proto.isTerminal(t.state)) return;
      const st = t.state;
      if (st.inner.winner !== 0) {
        if (roleRef.current === "A")
          setTimeout(() => {
            try {
              t.propose({ cell: 0 }, BigInt(Date.now()));
            } catch {
              /* ignore */
            }
          }, NEXT_MS);
      } else if (st.inner.turn === roleRef.current) {
        const cell =
          variant === "caro"
            ? pickCaroMove(
                st.inner as any,
                roleRef.current,
                Math.random,
                "strong",
              )
            : tttBestCell(st.inner, roleRef.current);
        setTimeout(() => {
          try {
            t.propose({ cell }, BigInt(Date.now()));
          } catch {
            /* ignore */
          }
        }, MOVE_MS);
      }
    },
    [proto, variant],
  );

  const leave = useCallback(() => {
    relayRef.current?.close();
    relayRef.current = null;
    tunnelRef.current = null;
    setPhase("idle");
    setState(null);
    setRole(null);
    setDigests({});
    setGames([]);
    setScore({ x: 0, o: 0, draws: 0 });
    settledRef.current = false;
    stoppingRef.current = false;
    autoRef.current = false;
    setAutoState(false);
    openedResolveRef.current = null;
    settleResolveRef.current = null;
    bufferedSettleRef.current = null;
    helloResolveRef.current = null;
    bufferedHelloRef.current = null;
    sessionRef.current = null;
    moveCountRef.current = 0;
    actionsRef.current = 0;
  }, []);

  useEffect(() => () => relayRef.current?.close(), []);

  const s = state;
  const inner = s?.inner ?? null;
  const winner = inner ? inner.winner : 0;
  const myMark: 0 | 1 | 2 =
    roleRef.current === "A" ? 1 : roleRef.current === "B" ? 2 : 0;
  const isMyTurn =
    !!inner &&
    inner.winner === 0 &&
    inner.turn === roleRef.current &&
    phase === "playing";
  return {
    phase,
    error,
    role: roleRef.current,
    variant,
    board: inner ? inner.board : [],
    size: inner ? (inner.size ?? 3) : variant === "caro" ? boardSize : 3,
    lastMove: inner ? (inner.lastMove ?? -1) : -1,
    turn: inner ? inner.turn : null,
    winner,
    myMark,
    isMyTurn,
    innerOver: !!inner && inner.winner !== 0,
    terminal: s ? proto.isTerminal(s) : false,
    score,
    games,
    currentGame: s ? s.gamesPlayed + 1 : 0,
    auto,
    address: wallet.address ?? "",
    balance,
    digests,
    queue,
    play,
    next,
    stop,
    setAuto,
    leave,
  };
}
