import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { TicTacToeProtocol, type TicTacToeState, type Winner } from "sui-tunnel-ts/protocol/ticTacToe";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "../../backend/controlPlane";
import { closeCooperative, openAndFundSelfPlay, readCreatedAt } from "../../onchain/tunnelTx";

type Move = { cell: number };

const STAKE_BALANCE = 500n; // locked per bot seat (MIST)
const STAKE_SHIFT = 100n; // moves loser→winner on a decisive result
const STEP_MS = 700; // pacing between bot moves

export type TttBotStatus = "idle" | "funding" | "playing" | "settling" | "settled" | "error";

export interface TttBotSession {
  status: TttBotStatus;
  board: number[];
  winner: Winner;
  error: string | null;
  start: () => void;
  reset: () => void;
}

/** Bot-vs-bot Tic-Tac-Toe over a REAL Sui tunnel: the wallet opens+funds both seats in one
 *  signature, the two bots co-sign random-legal moves off-chain, and the result settles back
 *  on-chain. Reports activity to the control-plane (register + heartbeat) and the live panels. */
export function useTttBotSession(): TttBotSession {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [status, setStatus] = useState<TttBotStatus>("idle");
  const [board, setBoard] = useState<number[]>(Array(9).fill(0));
  const [winner, setWinner] = useState<Winner>(0);
  const [error, setError] = useState<string | null>(null);

  const protocolRef = useRef<TicTacToeProtocol | null>(null);
  const tunnelRef = useRef<OffchainTunnel<TicTacToeState, Move> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Control-plane session (ADR-0002): one self-play client owns both seats, so it registers once
  // and heartbeats ~1/s. Best-effort — the backend is never in the per-move loop.
  const sessionRef = useRef<RegisterSessionResult | null>(null);
  const moveCountRef = useRef(0); // cumulative co-signed updates (= off-chain nonce)
  const actionsRef = useRef(0); // moves accrued since the last heartbeat
  const lastHeartbeatRef = useRef(0);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stopTimer();
    protocolRef.current = null;
    tunnelRef.current = null;
    sessionRef.current = null;
    moveCountRef.current = 0;
    actionsRef.current = 0;
    lastHeartbeatRef.current = 0;
    report.setActive(0);
    setStatus("idle");
    setBoard(Array(9).fill(0));
    setWinner(0);
    setError(null);
  }, [report, stopTimer]);

  const start = useCallback(() => {
    stopTimer();
    setError(null);
    setWinner(0);
    setBoard(Array(9).fill(0));

    if (!account) {
      setError("connect a wallet to stake the tunnel");
      setStatus("error");
      return;
    }
    const signExec = async (tx: Parameters<typeof signAndExecute>[0]["transaction"]) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    };
    const reads = client as unknown as Parameters<typeof openAndFundSelfPlay>[0]["reads"];

    (async () => {
      try {
        const a = createParticipant("ttt-bot-x");
        const b = createParticipant("ttt-bot-o");
        const protocol = new TicTacToeProtocol(STAKE_SHIFT);

        // Open + fund BOTH bot seats on-chain in ONE wallet signature (create_and_fund).
        setStatus("funding");
        const tunnelId = await openAndFundSelfPlay({
          reads,
          signExec,
          partyA: { address: a.address, publicKey: a.keyPair.publicKey },
          partyB: { address: b.address, publicKey: b.keyPair.publicKey },
          aAmount: STAKE_BALANCE,
          bAmount: STAKE_BALANCE,
        });
        const createdAt = await readCreatedAt(reads, tunnelId);

        const tunnel = OffchainTunnel.selfPlay(
          protocol,
          tunnelId,
          a.keyPair,
          b.keyPair,
          a.address,
          b.address,
          { a: STAKE_BALANCE, b: STAKE_BALANCE },
        );
        tunnel.onUpdate = (_u, bytes) =>
          report.bumpCounters({ updates: 1, signatures: 2, verifications: 2, bytes });

        protocolRef.current = protocol;
        tunnelRef.current = tunnel;
        report.bumpCounters({ tunnelsOpened: 1 });
        report.setActive(2);
        setBoard([...tunnel.state.board]);
        setStatus("playing");

        // Register the (real, on-chain) tunnel for stats tracking. Best-effort.
        sessionRef.current = null;
        moveCountRef.current = 0;
        actionsRef.current = 0;
        lastHeartbeatRef.current = Date.now();
        const cp = getControlPlaneClient();
        cp.registerSession({
          userAddress: account.address,
          game: "tic-tac-toe",
          tunnels: [{ tunnelId, partyA: a.address, partyB: b.address }],
        })
          .then((s) => {
            sessionRef.current = s;
          })
          .catch((e) => console.error("[ttt-bots] registerSession failed:", e));

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
            nonce: String(moveCountRef.current),
            actionsDelta,
            windowMs: Math.max(1, windowMs),
          }).catch((e) => console.error("[ttt-bots] heartbeat failed:", e));
        };

        const settleOnChain = async () => {
          setStatus("settling");
          report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
          report.setActive(0);
          // Panel txn row from bot X's (party A) perspective.
          const w = tunnel.state.winner;
          const draw = w === 3;
          const xWon = w === 1;
          report.pushTxn({
            time: new Date().toLocaleTimeString("en-GB"),
            bot: "Bot X",
            type: draw ? "Tic-Tac-Toe Draw" : xWon ? "Tic-Tac-Toe Win" : "Tic-Tac-Toe Loss",
            status: "Success",
            amount: draw ? "$0.00" : `${xWon ? "+" : "-"}$${Number(STAKE_SHIFT).toFixed(2)}`,
          });
          try {
            const settlement = tunnel.buildSettlement(createdAt);
            await closeCooperative({ signExec, tunnelId, settlement });
            setStatus("settled");
          } catch (e) {
            console.error("[ttt-bots] on-chain close failed:", e);
            setError(String((e as Error)?.message ?? e));
            setStatus("error");
          }
        };

        timerRef.current = setInterval(() => {
          const p = protocolRef.current;
          const t = tunnelRef.current;
          if (!p || !t) return;
          const s = t.state;
          let moved = false;
          if (!p.isTerminal(s)) {
            const move = p.randomMove(s, s.turn, Math.random);
            if (move) {
              t.step(move, s.turn);
              moved = true;
              moveCountRef.current += 1;
              actionsRef.current += 1;
            }
          }
          setBoard([...t.state.board]);
          setWinner(t.state.winner);

          flushHeartbeat(false);

          if (!moved || p.isTerminal(t.state)) {
            stopTimer();
            flushHeartbeat(true); // report the tail before settling
            void settleOnChain();
          }
        }, STEP_MS);
      } catch (e) {
        stopTimer();
        report.setActive(0);
        setError(String((e as Error)?.message ?? e));
        setStatus("error");
      }
    })();
  }, [account, client, signAndExecute, report, stopTimer]);

  useEffect(() => stopTimer, [stopTimer]);

  return { status, board, winner, error, start, reset };
}
