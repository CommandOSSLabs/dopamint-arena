import { useCallback, useRef, useState } from "react";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { TicTacToeProtocol, type TicTacToeState, type Winner } from "sui-tunnel-ts/protocol/ticTacToe";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { MpClient, resolveMpWsUrl, type PvpChannel, type Role } from "../../pvp/mpClient";
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
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const { report } = useTelemetry();
  const moveIdRef = useRef(0);

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
  const transcriptRef = useRef<Transcript | null>(null);
  const sessionRef = useRef<RegisterSessionResult | null>(null);

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
    transcriptRef.current = null;
    sessionRef.current = null;
    setStatus("idle");
    setRole(null);
    setBoard(Array(9).fill(0));
    setTurn(null);
    setWinner(0);
    setOpponentWallet(null);
    setError(null);
  }, []);

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

        // Register the funded tunnel under a control-plane session so seat A can authorize the
        // backend /settle close (bearer = statsToken). Best-effort — failure falls back to a
        // wallet-submitted close at settle time. Only seat A registers (it submits the close).
        if (match.role === "A") {
          getControlPlaneClient()
            .registerSession({
              userAddress: wallet,
              game: "tictactoe",
              tunnels: [{ tunnelId, partyA: wallet, partyB: match.opponentWallet }],
            })
            .then((s) => {
              sessionRef.current = s;
            })
            .catch((e) => console.error("[tictactoe] registerSession failed:", e));
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
        const transcript = new Transcript(tunnelId);
        transcriptRef.current = transcript;

        let settling = false;
        dt.onConfirmed = (u) => {
          transcript.append(u);
          sync();
          report.pushLocalTxn({
            id: moveIdRef.current++,
            game: "tic-tac-toe",
            time: new Date().toLocaleTimeString("en-GB"),
            bot: "You",
            type: dt.displayState.winner !== 0 ? "Win/Loss" : "Move",
            status: "Success",
            amount: "",
          });
          if (proto.isTerminal(dt.state) && !settling) {
            settling = true;
            void settle(dt, match.role, channel, waitPeer, reads, signExec, tunnelId).then(
              () => setStatus("settled"),
              (e) => {
                setError(String(e?.message ?? e));
                setStatus("error");
              },
            );
            setStatus("settling");
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
