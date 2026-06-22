import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { BombItProtocol, BOMB_IT_MIN_STAKE } from "sui-tunnel-ts/protocol/bombIt";
import type { BombItState, BombItMove, BombItAction } from "sui-tunnel-ts/protocol/bombIt";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import { getControlPlaneClient, type RegisterSessionResult } from "../../backend/controlPlane";
import { closeCooperative, openAndFundSelfPlay, readCreatedAt } from "../../onchain/tunnelTx";
import { deriveView, sessionResult, stepSession, type BombItView, type BombItResult } from "./session-core";

/**
 * Throughput pacing. Co-signing is synchronous crypto (2 sigs + 2 verifies per tick), so an
 * unbounded loop pegs the main thread → the Mac heats up and the UI stalls. Instead we cap the
 * crypto to FRAME_BUDGET_MS per FRAME_MS frame: a fixed ~20% CPU duty cycle that leaves the rest
 * of every frame idle (cool + responsive), while TPS auto-adapts to how many ticks fit the budget
 * (fast machines get more, same thermals). MAX_STEPS_PER_FRAME caps the top end. Tune
 * FRAME_BUDGET_MS up for more TPS/heat, down for a cooler run.
 */
const FRAME_MS = 50;
const FRAME_BUDGET_MS = 10;
const MAX_STEPS_PER_FRAME = 8;

export type SessionStatus = "idle" | "funding" | "playing" | "settling" | "settled" | "error";

export interface BombItSession {
  status: SessionStatus;
  view: BombItView | null;
  result: BombItResult | null;
  stake: number;
  error: string | null;
  /** Auto mode: when on (default), a bot autopilots your seat; off = you play it yourself. */
  auto: boolean;
  start: (stake: number) => void;
  reset: () => void;
  queueAction: (a: BombItAction) => void;
  toggleAuto: () => void;
}

/** You always sit in seat A for a solo match; seat B is the bot opponent. */
const HUMAN_SEAT = "A" as const;

/**
 * Self-play (bot-vs-bot) Bomb It over a REAL Sui tunnel — the canonical solo on-ramp so a
 * player can try the game with one wallet and no opponent. One signature funds BOTH seats
 * (openAndFundSelfPlay); a timer drives RNG moves through the protocol until a kill or the
 * tick cap, then it settles cooperatively on-chain. Mirrors useChickenCrossSession.
 */
export function useBombItSession(): BombItSession {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [status, setStatus] = useState<SessionStatus>("idle");
  const [view, setView] = useState<BombItView | null>(null);
  const [result, setResult] = useState<BombItResult | null>(null);
  const [stake, setStake] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAutoState] = useState(true);
  const autoRef = useRef(true);
  const nextActionRef = useRef<BombItAction>("stay");

  const protocolRef = useRef<BombItProtocol | null>(null);
  const tunnelRef = useRef<OffchainTunnel<BombItState, BombItMove> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Control-plane session (ADR-0002): best-effort, off the per-move loop.
  const sessionRef = useRef<RegisterSessionResult | null>(null);
  const moveCountRef = useRef(0);
  const actionsRef = useRef(0);
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
    autoRef.current = true;
    nextActionRef.current = "stay";
    setAutoState(true);
    setStatus("idle");
    setView(null);
    setResult(null);
    setStake(0);
    setError(null);
  }, [report, stopTimer]);

  const start = useCallback(
    (nextStake: number) => {
      stopTimer();
      const floored = Math.floor(nextStake);
      const stakeBig = BigInt(
        Math.max(Number(BOMB_IT_MIN_STAKE), Number.isFinite(floored) ? floored : 0),
      );
      setStake(Number(stakeBig));
      setResult(null);
      setError(null);

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
          const a = createParticipant("bomber-a");
          const b = createParticipant("bomber-b");
          const protocol = new BombItProtocol();

          // Open + fund BOTH bot seats in ONE wallet signature (create_and_fund).
          setStatus("funding");
          const tunnelId = await openAndFundSelfPlay({
            reads,
            signExec,
            partyA: { address: a.address, publicKey: a.keyPair.publicKey },
            partyB: { address: b.address, publicKey: b.keyPair.publicKey },
            aAmount: stakeBig,
            bAmount: stakeBig,
          });
          const createdAt = await readCreatedAt(reads, tunnelId);

          const tunnel = OffchainTunnel.selfPlay(
            protocol,
            tunnelId,
            a.keyPair,
            b.keyPair,
            a.address,
            b.address,
            { a: stakeBig, b: stakeBig },
          );
          tunnel.onUpdate = (_u, bytes) =>
            report.bumpCounters({ updates: 1, signatures: 2, verifications: 2, bytes });

          protocolRef.current = protocol;
          tunnelRef.current = tunnel;
          report.bumpCounters({ tunnelsOpened: 1 });
          report.setActive(2);
          setView(deriveView(tunnel.state));
          setStatus("playing");

          sessionRef.current = null;
          moveCountRef.current = 0;
          actionsRef.current = 0;
          lastHeartbeatRef.current = Date.now();
          const cp = getControlPlaneClient();
          cp.registerSession({
            userAddress: account.address,
            game: "bomb-it",
            tunnels: [{ tunnelId, partyA: a.address, partyB: b.address }],
          })
            .then((s) => {
              sessionRef.current = s;
            })
            .catch((e) => console.error("[bomb-it] registerSession failed:", e));

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
            }).catch((e) => console.error("[bomb-it] heartbeat failed:", e));
          };

          const settleOnChain = async () => {
            setStatus("settling");
            report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
            report.setActive(0);
            const r = sessionResult(tunnel.state);
            setResult(r);
            try {
              const settlement = tunnel.buildSettlement(createdAt);
              await closeCooperative({ signExec, tunnelId, settlement });
              setStatus("settled");
            } catch (e) {
              console.error("[bomb-it] on-chain close failed:", e);
              setError(String((e as Error)?.message ?? e));
              setStatus("error");
            }
          };

          timerRef.current = setInterval(() => {
            const p = protocolRef.current;
            const t = tunnelRef.current;
            if (!p || !t) return;
            // Co-sign ticks only until the per-frame time budget is spent, then yield: this is
            // what keeps TPS high yet the CPU cool (the rest of the frame stays idle).
            const deadline = performance.now() + FRAME_BUDGET_MS;
            // Auto on → both seats are bot-driven (your seat autopilots). Auto off → your queued
            // action drives seat A; the bot still drives B.
            const human = autoRef.current
              ? null
              : {
                  seat: HUMAN_SEAT,
                  getAction: () => {
                    const a = nextActionRef.current;
                    nextActionRef.current = "stay";
                    return a;
                  },
                };
            let ended = p.isTerminal(t.state);
            let n = 0;
            while (!ended && n < MAX_STEPS_PER_FRAME) {
              const moved = stepSession(p, t, Math.random, human);
              if (moved) {
                moveCountRef.current += 1;
                actionsRef.current += 1;
              }
              n++;
              if (!moved || p.isTerminal(t.state)) {
                ended = true;
                break;
              }
              if (performance.now() >= deadline) break;
            }
            setView(deriveView(t.state));

            // On the deciding frame, push a panel txn for the winner (skip draws/pushes).
            const w = t.state.winner;
            if (ended && (w === "A" || w === "B")) {
              report.pushTxn({
                id: moveCountRef.current,
                game: "bomb-it",
                time: new Date().toLocaleTimeString("en-GB"),
                bot: w === "A" ? "Bomber A" : "Bomber B",
                type: "Bomb It Win",
                status: "Success",
                amount: `+$${Number(t.state.total).toFixed(2)}`,
              });
            }

            flushHeartbeat(false);

            if (ended) {
              stopTimer();
              flushHeartbeat(true);
              void settleOnChain();
            }
          }, FRAME_MS);
        } catch (e) {
          stopTimer();
          report.setActive(0);
          setError(String((e as Error)?.message ?? e));
          setStatus("error");
        }
      })();
    },
    [account, client, signAndExecute, report, stopTimer],
  );

  const queueAction = useCallback((a: BombItAction) => {
    nextActionRef.current = a;
  }, []);
  const toggleAuto = useCallback(() => {
    autoRef.current = !autoRef.current;
    nextActionRef.current = "stay";
    setAutoState(autoRef.current);
  }, []);

  useEffect(() => stopTimer, [stopTimer]);

  return { status, view, result, stake, error, auto, start, reset, queueAction, toggleAuto };
}
