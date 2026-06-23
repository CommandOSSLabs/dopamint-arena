// frontend/src/games/ticTacToe/packages/client/src/hooks/usePvpTicTacToe.ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  core,
  proof,
  bytesToHex,
  hexToBytes,
  type protocols,
} from "sui-tunnel-ts";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { getControlPlaneClient } from "@/backend/controlPlane";
import { coSignedToSettleRequest } from "@/backend/settleRequest";
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
import {
  MpClient,
  resolveMpWsUrl,
  type MatchInfo,
  type PeerMessage,
  type PvpChannel,
} from "@/pvp/mpClient";
import { attachResume, resumeActiveTunnels } from "@/pvp/resumeSession";
import { raiseDisputeUnilateral } from "@/onchain/tunnelTx";
import {
  installResumePersistence,
  evictExpiredRecords,
  readResumeRecord,
  clearResumeRecord,
} from "@/pvp/resume";
import { makeTttResumeAdapter } from "@/games/ticTacToe/app/lib/tttResumeAdapter";

export type Variant = "ttt" | "caro";

// MP relay base (resolveMpWsUrl appends /v1/mp). Prefer an explicit VITE_MP_URL; otherwise derive
// from the backend base, and when that's empty (same-origin production build) from the page
// origin. Never hardcode localhost — a deployed https site would try ws://127.0.0.1 and fail.
const MP_URL =
  import.meta.env.VITE_MP_URL ||
  (
    import.meta.env.VITE_BACKEND_URL ||
    (typeof location !== "undefined"
      ? location.origin
      : "http://127.0.0.1:8080")
  ).replace(/^http/, "ws");
const STAKE = 1n; // MIST per game; caro's protocol forces 0 regardless
const BANKROLL = 1000n; // MIST deposited per seat
// One game per tunnel: the match settles on-chain as soon as the game is decided (the winner
// submits the close — see finishSettle), then players re-queue for the next game. A higher cap
// would batch many games into a single end-of-session settle instead.
const MAX_GAMES = 1;
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
  /** After a per-game settle: clear the closed match + resume record and find a new match. */
  requeue: () => void;
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
  // Default OFF: PvP is human-vs-human, so you make your own moves; tick Auto to let the bot
  // play for you.
  const [auto, setAutoState] = useState(false);
  const [balance, setBalance] = useState<bigint>(0n);
  const [digests, setDigests] = useState<{
    create?: string;
    deposit?: string;
    close?: string;
  }>({});

  const mpRef = useRef<MpClient | null>(null);
  const channelRef = useRef<PvpChannel | null>(null);
  const tunnelRef = useRef<core.DistributedTunnel<AnyState, CellMove> | null>(
    null,
  );
  const roleRef = useRef<"A" | "B" | null>(null);
  const autoRef = useRef(false);
  const autoKickedRef = useRef(false);
  const detachResumeRef = useRef<(() => void) | null>(null);
  const createdAtRef = useRef<bigint>(0n);
  const matchIdRef = useRef<string>("");
  const settledRef = useRef(false);
  const stoppingRef = useRef(false);
  const onMatchRef = useRef<
    ((mp: MpClient, m: MatchInfo) => Promise<void>) | undefined
  >(undefined);
  const openedResolveRef = useRef<((id: string) => void) | null>(null);
  const settleResolveRef = useRef<
    ((val: { sig: Uint8Array; root: Uint8Array }) => void) | null
  >(null);
  const bufferedSettleRef = useRef<{
    sig: Uint8Array;
    root: Uint8Array;
  } | null>(null);
  const helloResolveRef = useRef<((pub: string) => void) | null>(null);
  const bufferedHelloRef = useRef<string | null>(null);
  const transcriptRef = useRef<proof.Transcript | null>(null);

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
      channel: PvpChannel,
      _matchId: string,
    ) => {
      if (settledRef.current) return;
      settledRef.current = true;
      setPhase("settling");
      const root = transcriptRef.current
        ? transcriptRef.current.root()
        : new Uint8Array(32);
      const half = t.buildSettlementHalfWithRoot(
        createdAtRef.current,
        root,
        0n,
      );
      channel.sendPeer({
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
      // The game's winner submits the cooperative close (X-win or draw → A; O-win → B). The
      // payout is fixed by the co-signed balances regardless of who submits; this just decides
      // which seat sends the backend tx so the winner closes out their own game.
      const decided = t.state.inner.winner; // 1 = X (A) won, 2 = O (B) won, 3/0 = draw/none
      const submitter: "A" | "B" = decided === 2 ? "B" : "A";
      if (roleRef.current === submitter) {
        try {
          const result = await getControlPlaneClient().settle(
            t.tunnelId,
            coSignedToSettleRequest(
              coSigned as any,
              transcriptRef.current
                ? transcriptRef.current.toRecord().entries
                : [],
            ),
          );
          setDigests((d) => ({ ...d, close: result.txDigest }));
          channel.sendPeer({ t: "closed", digest: result.txDigest });
        } catch (e) {
          console.warn(
            "[settle] Server-side settle failed, falling back to wallet submission:",
            e,
          );
          const res = await submit(buildCloseWithRootTx(t.tunnelId, coSigned));
          setDigests((d) => ({ ...d, close: res.digest }));
          channel.sendPeer({ t: "closed", digest: res.digest });
        }
      }
      await refreshBalance();
      // The tunnel is now closed on-chain (per-game match). Drop its resume record so it can't be
      // restored and hijack the next match (the auto-requeue / Find New Match both re-queue).
      clearResumeRecord(t.tunnelId);
      setPhase("done");
    },
    [submit, refreshBalance],
  );

  // Wire the per-move loop + resume onto a freshly built/rebuilt tunnel. Shared by the live
  // (onMatch) and cold-load (queue) paths so both get identical onConfirmed + attachResume wiring.
  const activateTttSession = useCallback(
    (
      mp: MpClient,
      channel: PvpChannel,
      t: core.DistributedTunnel<AnyState, CellMove>,
      info: {
        matchId: string;
        role: "A" | "B";
        opponentWallet: string;
        opponentPubkeyHex: string;
        selfEphemeralSecretHex: string;
      },
    ) => {
      tunnelRef.current = t;
      channelRef.current = channel;
      // Single source of the seat role for BOTH the match and resume paths. The resume path
      // (reconnect / reload of an active match) skips onMatch, so without setting it here roleRef
      // stays null → myMark 0 → the view shows "◯ (O)" for both seats. A = X, B = O.
      roleRef.current = info.role;
      setRole(info.role);
      let lastLoggedGame = 0;
      const onAdvance = () => {
        const st = t.state;
        setState({ ...st, inner: { ...st.inner } });
        // Log each completed game once (winner is set on the inner game just before the advance).
        const gameNo = st.gamesPlayed + 1;
        if (st.inner.winner !== 0 && gameNo > lastLoggedGame) {
          const w = st.inner.winner as 1 | 2 | 3;
          setGames((prev) => [...prev, { game: gameNo, winner: w }].slice(-50));
          setScore((prev) => ({
            x: prev.x + (w === 1 ? 1 : 0),
            o: prev.o + (w === 2 ? 1 : 0),
            draws: prev.draws + (w === 3 ? 1 : 0),
          }));
          lastLoggedGame = gameNo;
        }
        if (stoppingRef.current) return;
        if (proto.isTerminal(st)) {
          void finishSettle(t, channel, info.matchId);
          return;
        }
        if (st.inner.winner !== 0) {
          // Between games: only X (A) drives the advance (avoids a double-advance race).
          if (info.role === "A" && autoRef.current)
            setTimeout(() => {
              try {
                t.propose({ cell: 0 }, BigInt(Date.now()));
              } catch {
                /* raced */
              }
            }, 100);
        } else if (st.inner.turn === info.role && autoRef.current) {
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
        transcriptRef.current?.append(u);
        onAdvance();
      };
      // Resume wiring: persist on confirm + run the resync handshake on reconnect.
      detachResumeRef.current?.();
      detachResumeRef.current = attachResume({
        mp,
        channel,
        tunnel: t,
        adapter: makeTttResumeAdapter<AnyState, CellMove>(() => onAdvance()),
        identity: {
          matchId: info.matchId,
          tunnelId: t.tunnelId,
          role: info.role,
          game: variant,
          opponentWallet: info.opponentWallet,
          opponentPubkeyHex: info.opponentPubkeyHex,
          selfEphemeralSecretHex: info.selfEphemeralSecretHex,
        },
        // Settlement floor: after the 1h grace, settle from the held checkpoint.
        onGraceExpired: (latest) => {
          if (latest)
            void raiseDisputeUnilateral({
              signExec: submit,
              tunnelId: t.tunnelId,
              update: latest,
              role: info.role,
            });
        },
      });
      setPhase("playing");
      setState({ ...t.state, inner: { ...t.state.inner } });
      onAdvance();
    },
    [proto, submit, variant, finishSettle],
  );

  const queue = useCallback(
    (opts?: { keepAuto?: boolean }) => {
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
        autoKickedRef.current = false;
        // Default-off on a fresh queue; auto-requeue passes keepAuto so the Auto loop survives
        // across per-game matches.
        if (!opts?.keepAuto) {
          autoRef.current = false;
          setAutoState(false);
        }
        bufferedSettleRef.current = null;
        bufferedHelloRef.current = null;
        openedResolveRef.current = null;
        settleResolveRef.current = null;
        helloResolveRef.current = null;
        try {
          const mp = new MpClient(
            resolveMpWsUrl(MP_URL),
            w.address,
            eph.coreKey,
          );
          mpRef.current = mp;
          // Cold-load: before joining a queue, rebuild any persisted in-flight match for this
          // variant and re-attach to it. The opening handshake then carries resume{matchId}.
          installResumePersistence();
          const restored = resumeActiveTunnels<AnyState, CellMove>(
            mp,
            variant,
            {
              proto,
              adapter: makeTttResumeAdapter<AnyState, CellMove>(() => {}),
            },
            { selfWallet: w.address },
          );
          if (restored.length > 0) {
            const { tunnel, channel } = restored[0]; // one active match per game in practice
            const rec = readResumeRecord(tunnel.tunnelId)!;
            activateTttSession(mp, channel, tunnel, {
              matchId: rec.matchId,
              role: rec.role,
              opponentWallet: rec.opponentWallet,
              opponentPubkeyHex: rec.opponentPubkeyHex,
              selfEphemeralSecretHex: rec.selfEphemeralSecretHex!,
            });
            await mp.connect();
            return; // skip quickMatch — we are continuing an in-flight match
          }
          await mp.connect();
          setPhase("queuing");
          // The queue key encodes the variant (+ board size for caro) so only players who chose the
          // SAME setup match — otherwise the two seats would run incompatible protocols and diverge.
          const m = await mp.quickMatch(
            variant === "caro"
              ? `tictactoe:caro:${boardSize}`
              : "tictactoe:ttt",
          );
          await onMatchRef.current?.(mp, m);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
      })();
    },
    [eph, variant, boardSize, proto, activateTttSession],
  );

  const onMatch = useCallback(
    async (mp: MpClient, m: MatchInfo) => {
      try {
        const w = walletRef.current;
        if (!w.address) throw new Error("wallet disconnected");
        matchIdRef.current = m.matchId;
        roleRef.current = m.role;
        setRole(m.role);
        // One channel per match: both the engine transport and the peer side-channel come from it.
        const channel = mp.channel(m.matchId);
        channelRef.current = channel;
        // Peer-channel dispatcher: hello pubkey, opened tunnelId, settle half, closed digest, stop.
        channel.onPeer((mm: Exclude<PeerMessage, { t: "frame" }>) => {
          if (mm.t === "hello") {
            const pub = String(mm.ephemeralPubkey);
            if (helloResolveRef.current) helloResolveRef.current(pub);
            else bufferedHelloRef.current = pub;
          } else if (mm.t === "opened")
            openedResolveRef.current?.(String(mm.tunnelId));
          else if (mm.t === "settle") {
            const sig = hexToBytes(String(mm.sig));
            const rt = hexToBytes(String(mm.root));
            if (settleResolveRef.current)
              settleResolveRef.current({ sig, root: rt });
            else bufferedSettleRef.current = { sig, root: rt };
          } else if (mm.t === "closed")
            setDigests((d) => ({ ...d, close: String(mm.digest) }));
          else if (mm.t === "stop") {
            stoppingRef.current = true;
            if (tunnelRef.current)
              void finishSettle(tunnelRef.current, channel, m.matchId);
          }
        });
        // hello carries the single pubkey (no attestation): capture synchronously, buffer races.
        channel.sendPeer({ t: "hello", ephemeralPubkey: eph.pubkeyHex });

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
          mp.announceTunnel(m.matchId, tunnelId);
          channel.sendPeer({ t: "opened", tunnelId });
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
          channel.transport,
          { a: BANKROLL, b: BANKROLL },
        );
        transcriptRef.current = new proof.Transcript(tunnelId);

        activateTttSession(mp, channel, t, {
          matchId: m.matchId,
          role: m.role,
          opponentWallet: m.opponentWallet,
          opponentPubkeyHex: oppPubHex,
          selfEphemeralSecretHex: bytesToHex(eph.coreKey.secretKey),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    },
    [client, proto, submit, eph, variant, finishSettle, activateTttSession],
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
    const channel = channelRef.current;
    if (!t || !channel) return;
    if (t.state.inner.winner === 0) return; // settle cleanly between games
    stoppingRef.current = true;
    channel.sendPeer({ t: "stop" });
    void finishSettle(t, channel, matchIdRef.current);
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

  // If Auto is enabled when the match becomes playable, kick the resume once (the move loop
  // otherwise only schedules auto AFTER a confirmed move, so the first move needs this). Auto
  // defaults OFF now, so this no-ops on entry; it matters if the user ticks Auto pre-play.
  useEffect(() => {
    if (autoKickedRef.current) return;
    if (phase === "playing" && tunnelRef.current && autoRef.current) {
      autoKickedRef.current = true;
      setAuto(true);
    }
  }, [phase, setAuto]);

  // Tear down the current match: detach resume, drop its resume record (a closed/abandoned tunnel
  // must never be restored — it would hijack the next match), close the transport, and clear
  // match state. keepAuto preserves the Auto toggle so an auto loop survives a per-game requeue;
  // a full leave clears it.
  const teardownMatch = useCallback((keepAuto: boolean) => {
    detachResumeRef.current?.();
    detachResumeRef.current = null;
    const tid = tunnelRef.current?.tunnelId;
    if (tid) clearResumeRecord(tid);
    mpRef.current?.close();
    mpRef.current = null;
    channelRef.current = null;
    tunnelRef.current = null;
    setState(null);
    setRole(null);
    setDigests({});
    setGames([]);
    setScore({ x: 0, o: 0, draws: 0 });
    settledRef.current = false;
    stoppingRef.current = false;
    autoKickedRef.current = false;
    if (!keepAuto) {
      autoRef.current = false;
      setAutoState(false);
    }
    openedResolveRef.current = null;
    settleResolveRef.current = null;
    bufferedSettleRef.current = null;
    helloResolveRef.current = null;
    bufferedHelloRef.current = null;
  }, []);

  const leave = useCallback(() => {
    teardownMatch(false);
    setPhase("idle");
  }, [teardownMatch]);

  // Find a new match after a per-game settle. Reuse the SAME socket (the relay runs many matches
  // per connection): release the settled match and re-quickMatch in place. Tearing the socket
  // down and reconnecting (a 2nd socket for the same wallet) raced the relay's routing and left
  // the next match's moves un-ACKed. Falls back to a full queue() if the socket is gone.
  const requeue = useCallback(() => {
    const mp = mpRef.current;
    if (!mp) {
      queue({ keepAuto: true });
      return;
    }
    detachResumeRef.current?.();
    detachResumeRef.current = null;
    const tid = tunnelRef.current?.tunnelId;
    if (tid) clearResumeRecord(tid); // closed tunnel: never restore it
    if (matchIdRef.current) mp.releaseMatch(matchIdRef.current);
    channelRef.current = null;
    tunnelRef.current = null;
    setState(null);
    setRole(null);
    setDigests({});
    setGames([]);
    setScore({ x: 0, o: 0, draws: 0 });
    settledRef.current = false;
    stoppingRef.current = false;
    autoKickedRef.current = false;
    openedResolveRef.current = null;
    settleResolveRef.current = null;
    bufferedSettleRef.current = null;
    helloResolveRef.current = null;
    bufferedHelloRef.current = null;
    setError(null);
    // Keep Auto + the open socket; just join the queue again.
    setPhase("queuing");
    void (async () => {
      try {
        const m = await mp.quickMatch(
          variant === "caro" ? `tictactoe:caro:${boardSize}` : "tictactoe:ttt",
        );
        await onMatchRef.current?.(mp, m);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [queue, variant, boardSize]);

  // After a per-game match settles ("done"), auto-find the next match when Auto is on. A short
  // pause lets the result show before re-queuing.
  useEffect(() => {
    if (phase !== "done" || !autoRef.current) return;
    const id = setTimeout(() => {
      if (autoRef.current) requeue();
    }, NEXT_MS);
    return () => clearTimeout(id);
  }, [phase, requeue]);

  // Register the pagehide/visibility flush and evict stale records once, on mount.
  useEffect(() => {
    installResumePersistence();
    evictExpiredRecords();
  }, []);

  useEffect(
    () => () => {
      detachResumeRef.current?.();
      mpRef.current?.close();
    },
    [],
  );

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
    requeue,
  };
}
