import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
// Deterministic seeded RNG (mulberry32) used in TRIVIAL_BOT_CTX so we never
// leak Math.random into a path that is supposed to be deterministic.
function mulberry32(seed: number): () => number {
  let s = seed;
  return (): number => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
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
import { MpClient, resolveMpWsUrl } from "@/pvp/mpClient";
import type { MatchInfo, Role, PvpChannel } from "@/pvp/mpClient";
import { PvpGameSession } from "@/agent/session/pvpGameSession";
import type { SessionSnapshot } from "@/agent/session/pvpGameSession";
import { createTicTacToeKit } from "@/agent/games/ticTacToe/kit";
import { mapSnapshotToView } from "@/games/ticTacToe/agent/mapSnapshotToView";
import type { SnapshotExtras } from "@/games/ticTacToe/agent/mapSnapshotToView";
import type { MultiGameTicTacToeState } from "@ttt/shared/ttt/multiGameProtocol";
import type { GameKit, BotContext } from "@/agent/gameKit";

export type Variant = "ttt" | "caro";

// MP relay base (RelayClient appends /v1/mp). Prefer an explicit VITE_MP_URL; otherwise derive
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

// Bot context for the session — auto-play in the hook is driven by the
// existing setTimeout loop; session.drive() must NOT propose moves here (session
// is never put in auto mode).  We supply a seeded deterministic RNG so the
// context is reproducible even though the bot is inactive in PvP.
const TRIVIAL_BOT_CTX: BotContext = { rngForSeat: () => mulberry32(0xcafe) };

function makeKit(): GameKit<AnyState, CellMove> {
  return createTicTacToeKit(1000, STAKE) as unknown as GameKit<
    AnyState,
    CellMove
  >;
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
        ? new MultiGameCaroProtocol(1000, boardSize)
        : new MultiGameTicTacToeProtocol(
            1000,
            STAKE,
          )) as unknown as protocols.Protocol<AnyState, CellMove>,
    [variant, boardSize],
  );

  // Session: one instance per match, replaced on each queue() call.
  // The ref holds the current session so imperative callbacks (play/stop/leave)
  // always address the right instance without closing over a stale value.
  const sessionRef = useRef<PvpGameSession<AnyState, CellMove>>(
    new PvpGameSession(makeKit(), "A", TRIVIAL_BOT_CTX),
  );

  // Epoch counter — incremented each time sessionRef.current is replaced (queue,
  // onMatch, leave).  Because useSyncExternalStore caches the subscribe function
  // by identity and unsubscribes/resubscribes only when it changes, we must
  // change the identity of stableSubscribe and stableGetSnapshot whenever the
  // underlying session instance changes — otherwise the React listener stays
  // registered on the OLD SnapshotStore and the new session's confirmed moves
  // never trigger a re-render.  Depending on `sessionEpoch` in the two callbacks
  // forces React to re-subscribe to the current session after every replacement.
  const [sessionEpoch, setSessionEpoch] = useState(0);

  // Each time the session is replaced, call this to bump the epoch and force
  // useSyncExternalStore to re-subscribe to the new session's store.
  const bumpEpoch = useCallback(() => setSessionEpoch((e) => e + 1), []);

  const stableSubscribe = useCallback(
    (cb: () => void): (() => void) => sessionRef.current.subscribe(cb),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionEpoch],
  );
  const stableGetSnapshot = useCallback(
    (): Readonly<SessionSnapshot<AnyState>> =>
      sessionRef.current.getSnapshot() as Readonly<SessionSnapshot<AnyState>>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionEpoch],
  );

  // useSyncExternalStore drives re-renders whenever the session's snapshot changes.
  const snapshot = useSyncExternalStore(stableSubscribe, stableGetSnapshot);

  // ── React-local state (not owned by PvpGameSession) ──────────────────────────

  // role: set when match.found fires, reset on leave.
  const [role, setRole] = useState<"A" | "B" | null>(null);

  // score/games: cumulative tallies accumulated per completed inner game.
  // `score` is authoritative; `games` is capped at 50 for display only.
  const [games, setGames] = useState<GameResult[]>([]);
  const [score, setScore] = useState({ x: 0, o: 0, draws: 0 });

  const [auto, setAutoState] = useState(true);
  const [balance, setBalance] = useState<bigint>(0n);

  // On-chain tx digests from open/deposit steps (create/deposit come from the
  // wallet execution; close comes from either the session settle path or the
  // relay app channel for seat B).
  const [digests, setDigests] = useState<{
    create?: string;
    deposit?: string;
    close?: string;
  }>({});

  // Phase and error overrides for pre-tunnel phases (connecting/queuing/opening/
  // funding/settling/done) and pre-session errors.  These overlay the session's
  // snapshot phase so the view reflects the full lifecycle without needing the
  // session to own wallet/relay concerns.
  const [phaseOverride, setPhaseOverride] = useState<PvpPhase | null>(null);
  const [errorOverride, setErrorOverride] = useState<string | null>(null);

  const relayRef = useRef<MpClient | null>(null);
  const channelRef = useRef<PvpChannel | null>(null);
  const tunnelRef = useRef<core.DistributedTunnel<AnyState, CellMove> | null>(
    null,
  );
  const roleRef = useRef<"A" | "B" | null>(null);
  const autoRef = useRef(true);
  const autoKickedRef = useRef(false);
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

  // ── Helpers ──────────────────────────────────────────────────────────────────

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

  // finishSettle: cooperative close — builds and exchanges settlement halves,
  // submits the combined settlement on-chain (role A only).
  // Phase transitions (settling/done/error) are driven via phaseOverride/errorOverride
  // rather than through the session, since the session's settle() method requires a
  // MatchChannel abstraction that is not yet wired here.
  const finishSettle = useCallback(
    async (
      t: core.DistributedTunnel<AnyState, CellMove>,
      mp: MpClient,
      matchId: string,
    ) => {
      if (settledRef.current) return;
      settledRef.current = true;
      setPhaseOverride("settling");
      const root = transcriptRef.current
        ? transcriptRef.current.root()
        : new Uint8Array(32);
      const half = t.buildSettlementHalfWithRoot(
        createdAtRef.current,
        root,
        0n,
      );
      channelRef.current?.sendPeer({
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
          channelRef.current?.sendPeer({ t: "closed", digest: result.txDigest });
        } catch (e) {
          console.warn(
            "[settle] Server-side settle failed, falling back to wallet submission:",
            e,
          );
          const res = await submit(buildCloseWithRootTx(t.tunnelId, coSigned));
          setDigests((d) => ({ ...d, close: res.digest }));
          channelRef.current?.sendPeer({ t: "closed", digest: res.digest });
        }
      }
      await refreshBalance();
      setPhaseOverride("done");
    },
    [submit, refreshBalance],
  );

  // ── queue ────────────────────────────────────────────────────────────────────

  const queue = useCallback(() => {
    void (async () => {
      const w = walletRef.current;
      if (!w.isConnected || !w.address) {
        setErrorOverride("Connect your wallet on the main menu first");
        setPhaseOverride("error");
        return;
      }
      setErrorOverride(null);
      setPhaseOverride("connecting");
      settledRef.current = false;
      stoppingRef.current = false;
      setGames([]);
      setScore({ x: 0, o: 0, draws: 0 });
      autoRef.current = true;
      autoKickedRef.current = false;
      setAutoState(true); // default on; the kick effect drives the first move once playing
      bufferedSettleRef.current = null;
      bufferedHelloRef.current = null;
      openedResolveRef.current = null;
      settleResolveRef.current = null;
      helloResolveRef.current = null;
      setRole(null);
      roleRef.current = null;
      setDigests({});

      // Replace the session for this match so snapshot resets to idle.
      // Dispose the previous instance to prevent timer leaks.  Bump the epoch
      // so useSyncExternalStore re-subscribes to the new session's store.
      sessionRef.current.dispose();
      sessionRef.current = new PvpGameSession(makeKit(), "A", TRIVIAL_BOT_CTX);
      bumpEpoch();

      try {
        const mp = new MpClient(resolveMpWsUrl(MP_URL), w.address, eph.coreKey);
        relayRef.current = mp;
        await mp.connect();
        setPhaseOverride("queuing");
        const queueKey =
          variant === "caro" ? `tictactoe:caro:${boardSize}` : "tictactoe:ttt";
        const match = await mp.quickMatch(queueKey);
        void onMatchRef.current?.(mp, match);
      } catch (e) {
        setErrorOverride(e instanceof Error ? e.message : String(e));
        setPhaseOverride("error");
      }
    })();
  }, [eph, variant, boardSize, bumpEpoch]);

  // ── onMatch ──────────────────────────────────────────────────────────────────

  const onMatch = useCallback(
    async (
      relay: MpClient,
      m: MatchInfo,
    ) => {
      try {
        const w = walletRef.current;
        if (!w.address) throw new Error("wallet disconnected");
        matchIdRef.current = m.matchId;
        roleRef.current = m.role;
        setRole(m.role);

        // Rebuild the session for the matched role so the bot's seat is correct.
        // Bump epoch so useSyncExternalStore re-subscribes to the new session's store.
        sessionRef.current.dispose();
        sessionRef.current = new PvpGameSession(
          makeKit(),
          m.role,
          TRIVIAL_BOT_CTX,
        );
        bumpEpoch();

        const channel = relay.channel(m.matchId);
        channelRef.current = channel;

        // App-channel dispatcher: opened tunnelId, settle half, closed digest, stop request.
        channel.onPeer((mm) => {
          if (mm.t === "opened")
            openedResolveRef.current?.(String(mm.tunnelId));
          else if (mm.t === "settle") {
            const sig = hexToBytes(String(mm.sig));
            const rt = hexToBytes(String(mm.root));
            if (settleResolveRef.current)
              settleResolveRef.current({ sig, root: rt });
            else bufferedSettleRef.current = { sig, root: rt };
          } else if (mm.t === "closed") {
            // Seat B receives the close digest from seat A via the app channel.
            setDigests((d) => ({ ...d, close: String(mm.digest) }));
            setPhaseOverride("done");
          } else if (mm.t === "stop") {
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
          setPhaseOverride("opening");
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
          channel.sendPeer({ t: "opened", tunnelId });
        } else {
          setPhaseOverride("opening");
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

        setPhaseOverride("funding");
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
        tunnelRef.current = t;
        transcriptRef.current = new proof.Transcript(tunnelId);

        // Attach the tunnel to the session — wires t.onConfirmed → session.onConfirmed,
        // publishes the initial "playing" snapshot, and clears phaseOverride so the
        // session's snapshot drives subsequent phase display.
        sessionRef.current.attachTunnel({
          tunnel: t as unknown as Parameters<
            typeof sessionRef.current.attachTunnel
          >[0]["tunnel"],
          initialState: { ...t.state, inner: { ...t.state.inner } },
        });
        // From here the session drives phase via snapshot; clear the override.
        setPhaseOverride(null);
        setErrorOverride(null);

        // Layer stats/transcript/score-accumulation on top of the session's
        // t.onConfirmed.  The session already set t.onConfirmed via attachTunnel;
        // we chain after it so both the session's internal bookkeeping and our
        // stats/settle logic both run.
        const sessionOnConfirmed = t.onConfirmed;
        t.onConfirmed = (u) => {
          // Session-core bookkeeping first (transcript append + state publish + drive).
          sessionOnConfirmed?.(u);

          transcriptRef.current?.append(u);

          // Score accumulation: log each completed inner game once.
          const st = t.state;
          const gameNo = st.gamesPlayed + 1;
          if (st.inner.winner !== 0) {
            setGames((prev) => {
              const lastEntry = prev[prev.length - 1];
              if (lastEntry && lastEntry.game === gameNo) return prev; // already logged
              const w = st.inner.winner as 1 | 2 | 3;
              setScore((s) => ({
                x: s.x + (w === 1 ? 1 : 0),
                o: s.o + (w === 2 ? 1 : 0),
                draws: s.draws + (w === 3 ? 1 : 0),
              }));
              return [...prev, { game: gameNo, winner: w }].slice(-50);
            });
          }

          // Settle trigger: when the session reaches terminal or a stop is requested.
          if (stoppingRef.current) {
            void finishSettle(t, relay, m.matchId);
            return;
          }
          if (proto.isTerminal(st)) {
            void finishSettle(t, relay, m.matchId);
            return;
          }

          // Between-games auto-advance and in-game auto-play (matches old behavior).
          if (st.inner.winner !== 0) {
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

        // If auto is already on (rematch case), drive the initial move.
        if (autoRef.current) {
          const st = t.state;
          if (st.inner.turn === m.role) {
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
        }
      } catch (e) {
        setErrorOverride(e instanceof Error ? e.message : String(e));
        setPhaseOverride("error");
      }
    },
    [
      client,
      proto,
      submit,
      eph,
      variant,
      finishSettle,
      bumpEpoch,
    ],
  );
  onMatchRef.current = onMatch;

  // ── Imperative move controls ─────────────────────────────────────────────────

  const play = useCallback((cell: number) => {
    const t = tunnelRef.current;
    if (!t) return;
    const st = t.state;
    if (st.inner.winner !== 0 || st.inner.turn !== roleRef.current) return; // not my turn / between games
    try {
      t.propose({ cell }, BigInt(Date.now()));
    } catch (e) {
      setErrorOverride(e instanceof Error ? e.message : String(e));
      setPhaseOverride("error");
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
      setErrorOverride(e instanceof Error ? e.message : String(e));
      setPhaseOverride("error");
    }
  }, [proto]);

  const stop = useCallback(() => {
    const t = tunnelRef.current;
    const relay = relayRef.current;
    if (!t || !relay) return;
    if (t.state.inner.winner === 0) return; // settle cleanly between games
    stoppingRef.current = true;
    channelRef.current?.sendPeer({ t: "stop" });
    void finishSettle(t, relay, matchIdRef.current);
  }, [finishSettle]);

  const setAuto = useCallback(
    (on: boolean) => {
      autoRef.current = on;
      setAutoState(on);
      // Do NOT call session.setAuto() — the hook's setTimeout loop is the sole
      // auto-play driver.  Enabling session auto mode would cause session.drive()
      // to propose an extra move on each onConfirmed callback, resulting in a
      // double-propose ("not my turn") on every auto move.
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
    setRole(null);
    roleRef.current = null;
    setDigests({});
    setGames([]);
    setScore({ x: 0, o: 0, draws: 0 });
    settledRef.current = false;
    stoppingRef.current = false;
    autoRef.current = true;
    autoKickedRef.current = false;
    setAutoState(true);
    openedResolveRef.current = null;
    settleResolveRef.current = null;
    bufferedSettleRef.current = null;
    helloResolveRef.current = null;
    bufferedHelloRef.current = null;
    setPhaseOverride(null);
    setErrorOverride(null);
    // Replace with a fresh idle session so snapshot resets to "idle".
    // Bump epoch so useSyncExternalStore re-subscribes to the new session's store.
    sessionRef.current.dispose();
    sessionRef.current = new PvpGameSession(makeKit(), "A", TRIVIAL_BOT_CTX);
    bumpEpoch();
  }, [bumpEpoch]);

  useEffect(() => () => relayRef.current?.close(), []);

  // Kick the first auto move once the match transitions into "playing".
  // autoKickedRef resets on leave/queue so a rematch gets a fresh kick.
  // We use snapshot.phase (driven by attachTunnel) as the ready signal.
  useEffect(() => {
    if (autoKickedRef.current) return;
    if (snapshot.phase === "playing" && tunnelRef.current && autoRef.current) {
      autoKickedRef.current = true;
      setAuto(true);
    }
  }, [snapshot.phase, setAuto]);

  // ── View projection ──────────────────────────────────────────────────────────
  //
  // Pre-tunnel phases and errors are carried in phaseOverride/errorOverride rather
  // than the session (which only knows "idle" until attachTunnel is called).
  // Once the tunnel attaches, phaseOverride is cleared and the session drives phase.
  // During settling/done the phase comes from finishSettle via phaseOverride again
  // since finishSettle still owns the cooperative close (not session.settle()).

  const effectiveSnapshot: Readonly<SessionSnapshot<MultiGameTicTacToeState>> =
    phaseOverride !== null || errorOverride !== null
      ? ({
          ...snapshot,
          phase: phaseOverride ?? snapshot.phase,
          error: errorOverride ?? snapshot.error,
        } as Readonly<SessionSnapshot<MultiGameTicTacToeState>>)
      : (snapshot as Readonly<SessionSnapshot<MultiGameTicTacToeState>>);

  const extras: SnapshotExtras = {
    address: wallet.address ?? "",
    balance,
    role,
    score,
    games,
    digests: { create: digests.create, deposit: digests.deposit },
    auto,
    variant,
    boardSize,
    queue,
    play,
    next,
    stop,
    setAuto,
    leave,
  };

  // The close digest may come from either the session (seat A, via finishSettle →
  // setDigests) or from the relay app channel (seat B, mm.t === "closed"). Both
  // paths write into `digests.close` via setDigests, so we forward it here.
  const view = mapSnapshotToView(effectiveSnapshot, extras);
  // Override digests.close from local state (both seats write to setDigests).
  if (digests.close && !view.digests.close) {
    return { ...view, digests: { ...view.digests, close: digests.close } };
  }
  return view;
}
