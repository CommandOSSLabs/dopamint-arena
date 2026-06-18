import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSuiClient } from "@mysten/dapp-kit";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { TicTacToeProtocol, type TicTacToeState, type Winner } from "sui-tunnel-ts/protocol/ticTacToe";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "../../backend/controlPlane";
import { closeCooperative, openAndFundSelfPlay, readCreatedAt, type SignExec } from "../../onchain/tunnelTx";
import { ensureFunded, loadTttBots } from "./botKeys";

type Move = { cell: number };

const STAKE_BALANCE = 500n; // locked per bot seat (MIST)
const STAKE_SHIFT = 100n; // moves loser→winner on a decisive result
const STEP_MS = 50; // pacing between bot moves — low = faster play, more co-signed updates/sec
const RESTART_MS = 250; // pause between games when looping
const FUND_MIN = 50_000_000n; // seat-X floor (gas + both stakes); faucet tops up below this

export type TttBotStatus = "idle" | "funding" | "playing" | "settling" | "settled" | "error";

export interface TttBotSession {
  status: TttBotStatus;
  board: number[];
  winner: Winner;
  looping: boolean;
  error: string | null;
  start: () => void;
  reset: () => void;
}

/** Bot-vs-bot Tic-Tac-Toe over a REAL Sui tunnel. Both bot seats are LOCAL faucet-funded keys
 *  (seat X signs the open/close txs via the SuiClient — NO wallet popup), so it runs autonomously
 *  and loops game→game to pump throughput. Reports to the control-plane + the live panels. */
export function useTttBotSession(): TttBotSession {
  const { report } = useTelemetry();
  const client = useSuiClient();
  const bots = useMemo(() => loadTttBots(), []);

  const [status, setStatus] = useState<TttBotStatus>("idle");
  const [board, setBoard] = useState<number[]>(Array(9).fill(0));
  const [winner, setWinner] = useState<Winner>(0);
  const [looping, setLooping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const protocolRef = useRef<TicTacToeProtocol | null>(null);
  const tunnelRef = useRef<OffchainTunnel<TicTacToeState, Move> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loopingRef = useRef(false);
  const runGameRef = useRef<(() => void) | undefined>(undefined);

  // Control-plane session (ADR-0002): registered per tunnel, heartbeated ~1/s. Best-effort.
  const sessionRef = useRef<RegisterSessionResult | null>(null);
  const moveCountRef = useRef(0); // co-signed updates this tunnel (= off-chain nonce)
  const actionsRef = useRef(0); // moves accrued since the last heartbeat
  const lastHeartbeatRef = useRef(0);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    loopingRef.current = false;
    setLooping(false);
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

  // Play ONE tunnel (open → bots co-sign to terminal → settle), then loop if still looping.
  const runGame = useCallback(() => {
    stopTimer();
    setError(null);
    setWinner(0);
    setBoard(Array(9).fill(0));

    // Seat X signs + submits locally via the SuiClient — no wallet popup. The cast bridges the
    // SDK's Transaction type and dapp-kit's pinned one (identical bytes; type-only).
    const signExec: SignExec = async (tx) => {
      const r = await client.signAndExecuteTransaction({
        signer: bots.x.keypair,
        transaction: tx as unknown as Parameters<typeof client.signAndExecuteTransaction>[0]["transaction"],
        options: { showEffects: true },
      });
      return { digest: r.digest };
    };
    const reads = client as unknown as Parameters<typeof openAndFundSelfPlay>[0]["reads"];

    (async () => {
      try {
        const protocol = new TicTacToeProtocol(STAKE_SHIFT);

        setStatus("funding");
        await ensureFunded(client, bots.x.address, FUND_MIN); // local seat X funds the game — no popup
        const tunnelId = await openAndFundSelfPlay({
          reads,
          signExec,
          partyA: { address: bots.x.address, publicKey: bots.x.coreKey.publicKey },
          partyB: { address: bots.o.address, publicKey: bots.o.coreKey.publicKey },
          aAmount: STAKE_BALANCE,
          bAmount: STAKE_BALANCE,
        });
        const createdAt = await readCreatedAt(reads, tunnelId);

        const tunnel = OffchainTunnel.selfPlay(
          protocol,
          tunnelId,
          bots.x.coreKey,
          bots.o.coreKey,
          bots.x.address,
          bots.o.address,
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

        sessionRef.current = null;
        moveCountRef.current = 0;
        actionsRef.current = 0;
        lastHeartbeatRef.current = Date.now();
        const cp = getControlPlaneClient();
        cp.registerSession({
          userAddress: bots.x.address,
          game: "tic-tac-toe",
          tunnels: [{ tunnelId, partyA: bots.x.address, partyB: bots.o.address }],
        })
          .then((s) => {
            sessionRef.current = s;
          })
          .catch((e) => console.error("[ttt-bots] registerSession failed:", e));

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
            if (loopingRef.current) setTimeout(() => runGameRef.current?.(), RESTART_MS);
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
            flushHeartbeat(true);
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
  }, [client, bots, report, stopTimer]);
  runGameRef.current = runGame;

  const start = useCallback(() => {
    loopingRef.current = true;
    setLooping(true);
    runGameRef.current?.();
  }, []);

  useEffect(() => stopTimer, [stopTimer]);

  return { status, board, winner, looping, error, start, reset };
}
