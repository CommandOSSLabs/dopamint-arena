import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { CrossProtocol, MIN_STAKE } from "sui-tunnel-ts/protocol/cross";
import type { CrossState, CrossMove } from "sui-tunnel-ts/protocol/cross";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import { getControlPlaneClient, type RegisterSessionResult } from "../../backend/controlPlane";
import { closeCooperative, openAndFundSelfPlay, readCreatedAt } from "../../onchain/tunnelTx";
import {
  deriveView,
  sessionResult,
  stepSession,
  type CrossView,
  type SessionResult,
} from "./session-core";

/** Milliseconds between world ticks (animation pacing). Faster than blackjack — hops are quick. */
const STEP_MS = 300;

export type SessionStatus = "idle" | "funding" | "playing" | "settling" | "settled" | "error";

export interface ChickenCrossSession {
  status: SessionStatus;
  view: CrossView | null;
  result: SessionResult | null;
  stake: number;
  error: string | null;
  start: (stake: number) => void;
  reset: () => void;
}

export function useChickenCrossSession(): ChickenCrossSession {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [status, setStatus] = useState<SessionStatus>("idle");
  const [view, setView] = useState<CrossView | null>(null);
  const [result, setResult] = useState<SessionResult | null>(null);
  const [stake, setStake] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const protocolRef = useRef<CrossProtocol | null>(null);
  const tunnelRef = useRef<OffchainTunnel<CrossState, CrossMove> | null>(null);
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
      const stakeBig = BigInt(Math.max(Number(MIN_STAKE), Number.isFinite(floored) ? floored : 0));
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
          const a = createParticipant("chicken-a");
          const b = createParticipant("chicken-b");
          const protocol = new CrossProtocol();

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
            game: "chicken-cross",
            tunnels: [{ tunnelId, partyA: a.address, partyB: b.address }],
          })
            .then((s) => {
              sessionRef.current = s;
            })
            .catch((e) => console.error("[chicken-cross] registerSession failed:", e));

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
            }).catch((e) => console.error("[chicken-cross] heartbeat failed:", e));
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
              console.error("[chicken-cross] on-chain close failed:", e);
              setError(String((e as Error)?.message ?? e));
              setStatus("error");
            }
          };

          timerRef.current = setInterval(() => {
            const p = protocolRef.current;
            const t = tunnelRef.current;
            if (!p || !t) return;
            const wasTerminal = p.isTerminal(t.state);
            const moved = stepSession(p, t, Math.random);
            if (moved) {
              moveCountRef.current += 1;
              actionsRef.current += 1;
            }
            setView(deriveView(t.state));

            // On the deciding tick, push a panel txn for the winner.
            if (moved && !wasTerminal && p.isTerminal(t.state) && t.state.winner) {
              report.pushTxn({
                time: new Date().toLocaleTimeString("en-GB"),
                bot: t.state.winner === "A" ? "Chicken A" : "Chicken B",
                type: "Chicken Cross Win",
                status: "Success",
                amount: `+$${Number(t.state.total).toFixed(2)}`,
              });
            }

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
    },
    [account, client, signAndExecute, report, stopTimer],
  );

  useEffect(() => stopTimer, [stopTimer]);

  return { status, view, result, stake, error, start, reset };
}
