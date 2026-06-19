import { useCallback, useEffect, useRef, useState } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { BlackjackProtocol, WAGER } from "sui-tunnel-ts/protocol/blackjack";
import type {
  BlackjackState,
  BlackjackMove,
} from "sui-tunnel-ts/protocol/blackjack";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "../../backend/controlPlane";
import {
  closeCooperative,
  openAndFundSelfPlay,
  readCreatedAt,
} from "../../onchain/tunnelTx";
import {
  deriveView,
  sessionResult,
  stepSession,
  type BlackjackView,
  type SessionResult,
} from "./session-core";

/** Milliseconds between bot moves (animation pacing). */
const STEP_MS = 900;

export type SessionStatus =
  | "idle"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

export interface BlackjackSession {
  status: SessionStatus;
  view: BlackjackView | null;
  result: SessionResult | null;
  stake: number;
  error: string | null;
  start: (stake: number) => void;
  reset: () => void;
}

export function useBlackjackSession(): BlackjackSession {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [status, setStatus] = useState<SessionStatus>("idle");
  const [view, setView] = useState<BlackjackView | null>(null);
  const [result, setResult] = useState<SessionResult | null>(null);
  const [stake, setStake] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const protocolRef = useRef<BlackjackProtocol | null>(null);
  const tunnelRef = useRef<OffchainTunnel<
    BlackjackState,
    BlackjackMove
  > | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stakeRef = useRef<bigint>(0n);

  // Control-plane session (ADR-0002): registered on start, heartbeated ~1/s. The backend is
  // off the per-move loop, so every call here is best-effort — failures are logged, not fatal.
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
    setView(null);
    setResult(null);
    setStake(0);
    setError(null);
  }, [report, stopTimer]);

  const start = useCallback(
    (nextStake: number) => {
      stopTimer();
      // Stake must cover at least one wager; clamp to a whole, fundable amount. Guard NaN/Inf.
      const floored = Math.floor(nextStake);
      const stakeBig = BigInt(
        Math.max(Number(WAGER), Number.isFinite(floored) ? floored : 0),
      );
      stakeRef.current = stakeBig;
      setStake(Number(stakeBig));
      setResult(null);
      setError(null);

      if (!account) {
        setError("connect a wallet to stake the tunnel");
        setStatus("error");
        return;
      }
      const signExec = async (
        tx: Parameters<typeof signAndExecute>[0]["transaction"],
      ) => {
        const r = await signAndExecute({ transaction: tx });
        return { digest: r.digest };
      };
      const reads = client as unknown as Parameters<
        typeof openAndFundSelfPlay
      >[0]["reads"];

      (async () => {
        try {
          const a = createParticipant("player-bot");
          const b = createParticipant("dealer-bot");
          const protocol = new BlackjackProtocol();

          // Open + fund BOTH bot seats on-chain in ONE wallet signature (create_and_fund);
          // play then runs off-chain and settles back on-chain at the end.
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
            report.bumpCounters({
              updates: 1,
              signatures: 2,
              verifications: 2,
              bytes,
            });

          protocolRef.current = protocol;
          tunnelRef.current = tunnel;
          report.bumpCounters({ tunnelsOpened: 1 });
          report.setActive(2);
          setView(deriveView(tunnel.state));
          setStatus("playing");

          // Register the (real, on-chain) tunnel for stats tracking. Best-effort.
          sessionRef.current = null;
          moveCountRef.current = 0;
          actionsRef.current = 0;
          lastHeartbeatRef.current = Date.now();
          const cp = getControlPlaneClient();
          cp.registerSession({
            userAddress: account.address,
            game: "blackjack",
            tunnels: [{ tunnelId, partyA: a.address, partyB: b.address }],
          })
            .then((s) => {
              sessionRef.current = s;
            })
            .catch((e) =>
              console.error("[blackjack] registerSession failed:", e),
            );

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
            }).catch((e) => console.error("[blackjack] heartbeat failed:", e));
          };

          // Cooperative close on-chain: both bot keys co-sign the final balances; the wallet
          // submits. finalNonce = 1 (no on-chain update_state). Coins move to the bot seats.
          const settleOnChain = async () => {
            setStatus("settling");
            report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
            report.setActive(0);
            setResult(sessionResult(tunnel.state, stakeRef.current));
            try {
              const settlement = tunnel.buildSettlement(createdAt);
              await closeCooperative({ signExec, tunnelId, settlement });
              setStatus("settled");
            } catch (e) {
              console.error("[blackjack] on-chain close failed:", e);
              setError(String((e as Error)?.message ?? e));
              setStatus("error");
            }
          };

          timerRef.current = setInterval(() => {
            const p = protocolRef.current;
            const t = tunnelRef.current;
            if (!p || !t) return;
            const prevBalanceA = t.state.balanceA;
            const moved = stepSession(p, t, Math.random);
            if (moved) {
              moveCountRef.current += 1;
              actionsRef.current += 1;
            }
            setView(deriveView(t.state));

            // A settled round (round_over with a balance change) => a panel txn.
            if (
              moved &&
              t.state.phase === "round_over" &&
              t.state.balanceA !== prevBalanceA
            ) {
              const delta = t.state.balanceA - prevBalanceA;
              report.pushTxn({
                id: actionsRef.current,
                game: "blackjack",
                time: new Date().toLocaleTimeString("en-GB"),
                bot: "Player Bot",
                type: delta > 0n ? "Blackjack Win" : "Blackjack Loss",
                status: "Success",
                amount: `${delta > 0n ? "+" : "-"}$${Math.abs(Number(delta)).toFixed(2)}`,
              });
            }

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
    },
    [account, client, signAndExecute, report, stopTimer],
  );

  // Clean up the timer if the component unmounts mid-session.
  useEffect(() => stopTimer, [stopTimer]);

  return { status, view, result, stake, error, start, reset };
}
