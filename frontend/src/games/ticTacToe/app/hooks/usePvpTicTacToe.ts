// frontend/src/games/ticTacToe/packages/client/src/hooks/usePvpTicTacToe.ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, proof, bytesToHex, hexToBytes, type protocols } from "sui-tunnel-ts";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { getControlPlaneClient, type RegisterSessionResult } from "@/backend/controlPlane";
import { settleViaBackend } from "@/backend/settle";
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
  buildCloseWithRootTx,
  parseTunnelId,
} from "@/games/ticTacToe/app/lib/pvpOnchain";
import { RelayClient } from "@/games/ticTacToe/app/lib/pvpRelay";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { withSponsorFallback } from "@/onchain/sponsor";
import { DOPAMINT_COIN_TYPE, isDopamintConfigured } from "@/onchain/dopamint";

export type Variant = "ttt" | "caro";

// MP relay base (RelayClient appends /v1/mp). Prefer an explicit VITE_MP_URL; otherwise derive
// from the backend base, and when that's empty (same-origin production build) from the page
// origin. Never hardcode localhost — a deployed https site would try ws://127.0.0.1 and fail.
const MP_URL =
  import.meta.env.VITE_MP_URL ||
  (
    import.meta.env.VITE_BACKEND_URL ||
    (typeof location !== "undefined" ? location.origin : "http://127.0.0.1:8080")
  ).replace(/^http/, "ws");
const STAKE = 1n; // MIST per game; caro's protocol forces 0 regardless
const BANKROLL = 1000n; // SUI-fallback MIST deposited per seat
// DOPAMINT mode (ADR-0010): bankroll deposited per seat (1 DOPAMINT, 9 decimals).
const DOPAMINT_BANKROLL = 1_000_000_000n;
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
  // Backend gas sponsor (ADR-0009/0010): open + deposit route through the settler so a 0-SUI
  // zkLogin player stakes faucet-minted DOPAMINT and pays no gas. Read inside stable callbacks
  // via a ref. (The close stays sender-pays as a fallback to the backend /settle route.)
  const sponsored = useSponsoredSignExec();
  const sponsoredRef = useRef(sponsored);
  sponsoredRef.current = sponsored;
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
  const settleResolveRef = useRef<((val: { sig: Uint8Array; root: Uint8Array }) => void) | null>(null);
  const bufferedSettleRef = useRef<{ sig: Uint8Array; root: Uint8Array } | null>(null);
  const helloResolveRef = useRef<((pub: string) => void) | null>(null);
  const bufferedHelloRef = useRef<string | null>(null);
  const transcriptRef = useRef<proof.Transcript | null>(null);

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

  // Gas-sponsored submit (ADR-0009): the settler wraps the tx in its own SIP-58 gas, the wallet
  // co-signs, both are submitted — so a 0-SUI player pays nothing. The sponsored signExec returns
  // only a digest, so (as in the bot flows) we fetch the block separately for objectChanges.
  const submitSponsored = useCallback(
    async (tx: any) => {
      const { digest } = await sponsoredRef.current.signExec(tx);
      await client.waitForTransaction({ digest });
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
      const root = transcriptRef.current ? transcriptRef.current.root() : new Uint8Array(32);
      const half = t.buildSettlementHalfWithRoot(createdAtRef.current, root, 0n);
      relay.sendApp(matchId, {
        t: "settle",
        sig: bytesToHex(half.sigSelf),
        root: bytesToHex(root),
      });
      const other =
        bufferedSettleRef.current ??
        (await new Promise<{ sig: Uint8Array; root: Uint8Array }>((res) => {
          settleResolveRef.current = res;
        }));
      if (bytesToHex(other.root) !== bytesToHex(root)) {
        throw new Error("Transcript root mismatch between players");
      }
      const coSigned = t.combineSettlementWithRoot(
        half.settlement,
        half.sigSelf,
        other.sig,
      );
      if (roleRef.current === "A") {
        // X (the opener) submits the cooperative close
        const closeDigest = await settleViaBackend({
          tunnelId: t.tunnelId,
          settlement: coSigned as any,
          transcript: transcriptRef.current ? transcriptRef.current.toRecord().entries : [],
          label: "tictactoe",
          fallbackClose: async () => {
            // Close pays in the same coin the tunnel was funded in (DOPAMINT vs SUI). In DOPAMINT
            // mode the player holds 0 SUI (gas is sponsored), so the close must route through the gas
            // sponsor too — a wallet-signed close would throw and strand the staked DOPAMINT.
            const coinType = isDopamintConfigured ? DOPAMINT_COIN_TYPE : undefined;
            const res = await (isDopamintConfigured ? submitSponsored : submit)(
              buildCloseWithRootTx(t.tunnelId, coSigned, coinType),
            );
            return res.digest;
          },
        });
        // Record the close + signal the opponent on BOTH paths (backend digest or fallback digest).
        if (closeDigest) {
          setDigests((d) => ({ ...d, close: closeDigest }));
          relay.sendApp(matchId, { t: "closed", digest: closeDigest });
        }
      }
      await refreshBalance();
      setPhase("done");
    },
    [submit, submitSponsored, refreshBalance, flushHeartbeat],
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
        // Capture the narrowed address: the `shareTx` closure below loses control-flow narrowing.
        const walletAddress = w.address;
        matchIdRef.current = m.matchId;
        roleRef.current = m.role;
        setRole(m.role);
        // App-channel dispatcher: opened tunnelId, settle half, closed digest, stop request.
        relay.onApp(m.matchId, (mm) => {
          if (mm.t === "opened")
            openedResolveRef.current?.(String(mm.tunnelId));
          else if (mm.t === "settle") {
            const sig = hexToBytes(String(mm.sig));
            const rt = hexToBytes(String(mm.root));
            if (settleResolveRef.current) settleResolveRef.current({ sig, root: rt });
            else bufferedSettleRef.current = { sig, root: rt };
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

        // DOPAMINT mode (ADR-0010): stake faucet-minted DOPAMINT with gas sponsored — a 0-SUI
        // player plays free. SUI fallback (env unset): sender-pays SUI stake. The bankroll, coin
        // type, and the off-chain init balances all follow this choice so deposits reconcile.
        const dopamintOn = isDopamintConfigured;
        const coinType = dopamintOn ? DOPAMINT_COIN_TYPE : undefined;
        const bankroll = dopamintOn ? DOPAMINT_BANKROLL : BANKROLL;

        // Roles: A = X (opener), B = O. X opens the tunnel registering partyA = self, partyB = opponent.
        // Party address = the zkLogin wallet (receives funds); party public_key = the ephemeral signer.
        // The share tx carries no stake (each seat deposits its own), so it's gas-sponsored in
        // DOPAMINT mode (with a sender-pays fallback), or plain sender-pays in SUI mode.
        let tunnelId: string;
        if (m.role === "A") {
          setPhase("opening");
          const shareTx = () =>
            buildCreateAndShareTx(
              { walletAddress, publicKey: eph.coreKey.publicKey }, // partyA = X (self)
              { walletAddress: m.opponentWallet, publicKey: oppPubkey }, // partyB = O (opponent)
              0n,
              coinType, // open Tunnel<DOPAMINT> so the seat deposits type-match
            );
          const res = dopamintOn
            ? await withSponsorFallback(
                () => submitSponsored(shareTx()),
                () => submit(shareTx()),
                "tictactoe open",
              )
            : await submit(shareTx());
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

        // Each seat funds its own deposit. DOPAMINT: split from a faucet-minted coin via the gas
        // sponsor (with a sender-pays SUI fallback); SUI fallback: split from the wallet gas coin.
        setPhase("funding");
        const dep = dopamintOn
          ? await withSponsorFallback(
              async () =>
                submitSponsored(
                  buildDepositTx(tunnelId, bankroll, {
                    coinType,
                    stakeCoinId:
                      await sponsoredRef.current.prepareStake(bankroll),
                  }),
                ),
              async () =>
                submit(
                  buildDepositTx(tunnelId, bankroll, {
                    stakeCoinId:
                      await sponsoredRef.current.selectStakeCoin(bankroll),
                  }),
                ),
              "tictactoe deposit",
            )
          : await submit(buildDepositTx(tunnelId, bankroll));
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
          { a: bankroll, b: bankroll },
        );
        tunnelRef.current = t;
        transcriptRef.current = new proof.Transcript(tunnelId);

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
              }, 100);
          } else if (st.inner.turn === m.role && autoRef.current) {
            const cell = (() => {
              const empties = st.inner.board
                .map((v, i) => (v === 0 ? i : -1))
                .filter((i) => i >= 0);
              return empties[Math.floor(Math.random() * empties.length)];
            })();
            setTimeout(() => {
              try {
                t.propose({ cell }, BigInt(Date.now()));
              } catch {
                /* not my turn / in flight */
              }
            }, 50);
          }
        };
        t.onConfirmed = (u) => {
          moveCountRef.current += 1;
          actionsRef.current += 1;
          transcriptRef.current?.append(u);
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
    [client, proto, submit, submitSponsored, eph, variant, finishSettle, flushHeartbeat],
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
          }, 100);
      } else if (st.inner.turn === roleRef.current) {
        const cell = (() => {
          const empties = st.inner.board
            .map((v, i) => (v === 0 ? i : -1))
            .filter((i) => i >= 0);
          return empties[Math.floor(Math.random() * empties.length)];
        })();
        setTimeout(() => {
          try {
            t.propose({ cell }, BigInt(Date.now()));
          } catch {
            /* ignore */
          }
        }, 50);
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
