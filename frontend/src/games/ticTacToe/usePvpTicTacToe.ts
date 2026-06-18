import { useCallback, useRef, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { TicTacToeProtocol, type TicTacToeState, type Winner } from "sui-tunnel-ts/protocol/ticTacToe";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { MpClient, resolveMpWsUrl, type PvpChannel, type Role } from "../../pvp/mpClient";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import {
  getControlPlaneClient,
  resolveBackendUrl,
  type RegisterSessionResult,
} from "../../backend/controlPlane";
import {
  closeCooperative,
  depositStake,
  openAndFundSharedTunnel,
  readCreatedAt,
} from "../../onchain/tunnelTx";

const STAKE_BALANCE = 500n; // locked per seat (MIST)
const STAKE_SHIFT = 100n; // moves loser→winner on a decisive result
// Estimate for the bytes counter: the engine's onConfirmed hands us the update, not its wire size,
// so we approximate one co-signed state-update for the activity panel's bytes/sec metric.
const EST_MOVE_BYTES = 128;

export type PvpStatus =
  | "idle"
  | "matching"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

export interface PvpTicTacToe {
  status: PvpStatus;
  role: Role | null;
  /** This seat's mark: A=X, B=O. */
  mark: "X" | "O" | null;
  board: number[];
  myTurn: boolean;
  winner: Winner;
  opponentWallet: string | null;
  error: string | null;
  findMatch: () => void;
  play: (cell: number) => void;
  reset: () => void;
}

/** Buffer peer messages so a waiter never misses one that arrived early. */
function makeInbox(channel: PvpChannel) {
  const buf = new Map<string, unknown>();
  const waiters = new Map<string, (m: unknown) => void>();
  channel.onPeer((m) => {
    const w = waiters.get(m.t);
    if (w) {
      waiters.delete(m.t);
      w(m);
    } else {
      buf.set(m.t, m);
    }
  });
  return <T = unknown>(t: string): Promise<T> =>
    new Promise((res) => {
      const b = buf.get(t);
      if (b) {
        buf.delete(t);
        res(b as T);
      } else {
        waiters.set(t, res as (m: unknown) => void);
      }
    });
}

export function usePvpTicTacToe(): PvpTicTacToe {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [status, setStatus] = useState<PvpStatus>("idle");
  const [role, setRole] = useState<Role | null>(null);
  const [board, setBoard] = useState<number[]>(Array(9).fill(0));
  const [turn, setTurn] = useState<Party | null>(null);
  const [winner, setWinner] = useState<Winner>(0);
  const [opponentWallet, setOpponentWallet] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mpRef = useRef<MpClient | null>(null);
  const dtRef = useRef<DistributedTunnel<TicTacToeState, { cell: number }> | null>(null);
  const roleRef = useRef<Role | null>(null);

  // Control-plane stats (ADR-0002): seat A registers + heartbeats (~1/s, best-effort, off the
  // per-move loop); seat B never registers, so exactly one client reports per tunnel.
  const sessionRef = useRef<RegisterSessionResult | null>(null);
  const actionsRef = useRef(0); // moves accrued since the last heartbeat
  const lastHeartbeatRef = useRef(0);

  // Render the engine's display state: the proposer's own move shows immediately
  // (pending, locally-signed) and reconciles to the confirmed state on co-sign.
  const sync = useCallback(() => {
    const dt = dtRef.current;
    if (!dt) return;
    setBoard([...dt.displayState.board]);
    setTurn(dt.displayState.turn);
    setWinner(dt.displayState.winner);
  }, []);

  const reset = useCallback(() => {
    mpRef.current?.close();
    mpRef.current = null;
    dtRef.current = null;
    roleRef.current = null;
    sessionRef.current = null;
    actionsRef.current = 0;
    lastHeartbeatRef.current = 0;
    report.setActive(0);
    setStatus("idle");
    setRole(null);
    setBoard(Array(9).fill(0));
    setTurn(null);
    setWinner(0);
    setOpponentWallet(null);
    setError(null);
  }, [report]);

  const findMatch = useCallback(() => {
    if (!account) {
      setError("connect a wallet first");
      return;
    }
    const wallet = account.address;
    const signExec = async (tx: Parameters<typeof signAndExecute>[0]["transaction"]) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    };
    const reads = client as unknown as Parameters<typeof openAndFundSharedTunnel>[0]["reads"];

    (async () => {
      try {
        setError(null);
        setStatus("matching");
        const ephemeral: KeyPair = generateKeyPair();
        const mp = new MpClient(resolveMpWsUrl(resolveBackendUrl()), wallet, ephemeral);
        mpRef.current = mp;
        await mp.connect();
        const match = await mp.quickMatch("tictactoe");
        roleRef.current = match.role;
        setRole(match.role);
        setOpponentWallet(match.opponentWallet);

        const channel = mp.channel(match.matchId);
        const waitPeer = makeInbox(channel);

        // 1) exchange ephemeral pubkeys (wallet is the matchmaking label).
        channel.sendPeer({ t: "hello", ephemeralPubkey: toHex(ephemeral.publicKey) });
        const hello = await waitPeer<{ ephemeralPubkey: string }>("hello");
        const oppPub = fromHex(hello.ephemeralPubkey);

        // 2) fund on-chain: seat A opens + funds its seat in ONE tx (one popup) + announces;
        // seat B gated-deposits its own stake.
        setStatus("funding");
        let tunnelId: string;
        if (match.role === "A") {
          tunnelId = await openAndFundSharedTunnel({
            reads,
            signExec,
            partyA: { address: wallet, publicKey: ephemeral.publicKey },
            partyB: { address: match.opponentWallet, publicKey: oppPub },
            amount: STAKE_BALANCE,
          });
          mp.announceTunnel(match.matchId, tunnelId);
          channel.sendPeer({ t: "open", tunnelId });
        } else {
          const open = await waitPeer<{ tunnelId: string }>("open");
          tunnelId = open.tunnelId;
          await depositStake({ signExec, tunnelId, amount: STAKE_BALANCE });
        }

        // 3) build the distributed engine over the relay transport.
        const proto = new TicTacToeProtocol(STAKE_SHIFT);
        const backend = defaultBackend();
        const self = makeEndpoint(backend, wallet, ephemeral, true);
        const opp = makeEndpoint(
          backend,
          match.opponentWallet,
          { publicKey: oppPub, scheme: ephemeral.scheme },
          false,
        );
        const dt = new DistributedTunnel<TicTacToeState, { cell: number }>(
          proto,
          { tunnelId, self, opponent: opp, selfParty: match.role },
          channel.transport,
          { a: STAKE_BALANCE, b: STAKE_BALANCE },
        );
        dtRef.current = dt;

        // Stats spine (ADR-0002): seat A owns the control-plane session + heartbeats; seat B reports
        // nothing to the server (one reporter per tunnel). Both seats still feed their own local panels.
        const cp = getControlPlaneClient();
        report.bumpCounters({ tunnelsOpened: 1 });
        report.setActive(1);
        sessionRef.current = null;
        actionsRef.current = 0;
        lastHeartbeatRef.current = Date.now();
        if (match.role === "A") {
          cp.registerSession({
            userAddress: wallet,
            game: "tic-tac-toe",
            tunnels: [{ tunnelId, partyA: wallet, partyB: match.opponentWallet }],
          })
            .then((s) => {
              sessionRef.current = s;
            })
            .catch((e) => console.error("[ttt] registerSession failed:", e));
        }

        // Coarse, aggregated throughput report (~1/s) — never one call per move (ADR-0002).
        const flushHeartbeat = (force: boolean) => {
          const s = sessionRef.current;
          if (!s || actionsRef.current === 0) return;
          const now = Date.now();
          const windowMs = now - lastHeartbeatRef.current;
          if (!force && windowMs < 1000) return;
          const actionsDelta = actionsRef.current;
          actionsRef.current = 0;
          lastHeartbeatRef.current = now;
          cp.sendHeartbeat(s.sessionId, s.statsToken, {
            tunnelId,
            nonce: String(dt.nonce),
            actionsDelta,
            windowMs: Math.max(1, windowMs),
          }).catch((e) => console.error("[ttt] heartbeat failed:", e));
        };

        let settling = false;
        dt.onConfirmed = () => {
          sync();
          // Local activity panels (per-browser): each confirmed co-sign is one update (2 sigs/verifs).
          report.bumpCounters({ updates: 1, signatures: 2, verifications: 2, bytes: EST_MOVE_BYTES });
          // Server stats: only seat A accrues + heartbeats (coarse window).
          if (match.role === "A") {
            actionsRef.current += 1;
            flushHeartbeat(false);
          }
          if (proto.isTerminal(dt.state) && !settling) {
            settling = true;
            setStatus("settling");
            report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
            report.setActive(0);
            // Panel txn row, from this seat's perspective (winner mark 1=X/2=O, 3=draw).
            const myMark = match.role === "A" ? 1 : 2;
            const w = dt.state.winner;
            const won = w === myMark;
            const draw = w === 3;
            report.pushTxn({
              time: new Date().toLocaleTimeString("en-GB"),
              bot: match.role === "A" ? "You (X)" : "You (O)",
              type: draw ? "Tic-Tac-Toe Draw" : won ? "Tic-Tac-Toe Win" : "Tic-Tac-Toe Loss",
              status: "Success",
              amount: draw ? "$0.00" : `${won ? "+" : "-"}$${Number(STAKE_SHIFT).toFixed(2)}`,
            });
            if (match.role === "A") flushHeartbeat(true);
            void settle(dt, match.role, channel, waitPeer, reads, signExec, tunnelId).then(
              () => setStatus("settled"),
              (e) => {
                setError(String(e?.message ?? e));
                setStatus("error");
              },
            );
          }
        };

        // 4) readiness handshake — only AFTER the engine is live, so seat A's first move
        // (X) can never reach seat B before B has wired its frame handler.
        sync();
        setStatus("playing");
        if (match.role === "A") await waitPeer("ready");
        else channel.sendPeer({ t: "ready" });
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
        setStatus("error");
      }
    })();
  }, [account, client, signAndExecute, sync, report]);

  const play = useCallback((cell: number) => {
    const dt = dtRef.current;
    if (!dt || dt.state.turn !== roleRef.current) return;
    if (dt.state.board[cell] !== 0 || dt.state.winner !== 0) return;
    try {
      dt.propose({ cell }, 0n);
      sync(); // show our mark + turn flip now; onConfirmed reconciles on co-sign
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, [sync]);

  const mark: "X" | "O" | null = role === "A" ? "X" : role === "B" ? "O" : null;
  const myTurn = !!role && turn === role && winner === 0 && status === "playing";

  return {
    status,
    role,
    mark,
    board,
    myTurn,
    winner,
    opponentWallet,
    error,
    findMatch,
    play,
    reset,
  };
}

/** Exchange settlement halves over the relay; seat A submits the cooperative close. */
async function settle(
  dt: DistributedTunnel<TicTacToeState, { cell: number }>,
  role: Role,
  channel: PvpChannel,
  waitPeer: <T>(t: string) => Promise<T>,
  reads: Parameters<typeof readCreatedAt>[0],
  signExec: Parameters<typeof closeCooperative>[0]["signExec"],
  tunnelId: string,
): Promise<void> {
  const createdAt = await readCreatedAt(reads, tunnelId);
  const half = dt.buildSettlementHalf(createdAt, 0n);
  channel.sendPeer({
    t: "settleHalf",
    partyABalance: half.settlement.partyABalance.toString(),
    partyBBalance: half.settlement.partyBBalance.toString(),
    finalNonce: half.settlement.finalNonce.toString(),
    timestamp: half.settlement.timestamp.toString(),
    sig: toHex(half.sigSelf),
  });
  const other = await waitPeer<{ sig: string }>("settleHalf");
  const co = dt.combineSettlement(half.settlement, half.sigSelf, fromHex(other.sig));
  if (role === "A") {
    await closeCooperative({ signExec, tunnelId, settlement: co });
  }
}
