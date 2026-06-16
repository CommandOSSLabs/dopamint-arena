import { useCallback, useEffect, useRef, useState } from "react";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { BlackjackProtocol, WAGER } from "sui-tunnel-ts/protocol/blackjack";
import type { BlackjackState, BlackjackMove } from "sui-tunnel-ts/protocol/blackjack";
import { blake2b256 } from "sui-tunnel-ts/core/crypto";
import { toHex } from "sui-tunnel-ts/core/bytes";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import {
  deriveView,
  sessionResult,
  stepSession,
  type BlackjackView,
  type SessionResult,
} from "./session-core";

/** Milliseconds between bot moves (animation pacing). */
const STEP_MS = 600;

export type SessionStatus = "idle" | "playing" | "settled";

export interface BlackjackSession {
  status: SessionStatus;
  view: BlackjackView | null;
  result: SessionResult | null;
  stake: number;
  start: (stake: number) => void;
  reset: () => void;
}

const enc = new TextEncoder();

export function useBlackjackSession(): BlackjackSession {
  const { report } = useTelemetry();
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [view, setView] = useState<BlackjackView | null>(null);
  const [result, setResult] = useState<SessionResult | null>(null);
  const [stake, setStake] = useState<number>(0);

  const protocolRef = useRef<BlackjackProtocol | null>(null);
  const tunnelRef = useRef<OffchainTunnel<BlackjackState, BlackjackMove> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stakeRef = useRef<bigint>(0n);

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
    report.setActive(0);
    setStatus("idle");
    setView(null);
    setResult(null);
    setStake(0);
  }, [report, stopTimer]);

  const start = useCallback(
    (nextStake: number) => {
      stopTimer();
      // Stake must cover at least one wager; clamp to a whole, fundable amount.
      const stakeBig = BigInt(Math.max(Number(WAGER), Math.floor(nextStake)));
      stakeRef.current = stakeBig;
      setStake(Number(stakeBig));

      const a = createParticipant("player-bot");
      const b = createParticipant("dealer-bot");
      const protocol = new BlackjackProtocol();
      const tunnelId =
        "0x" + toHex(blake2b256(enc.encode(`dopamint::blackjack::${a.address}:${b.address}:${Date.now()}`)));
      const tunnel = OffchainTunnel.selfPlay(
        protocol,
        tunnelId,
        a.keyPair,
        b.keyPair,
        a.address,
        b.address,
        { a: stakeBig, b: stakeBig },
      );
      // Feed each co-signed update into the live panels.
      tunnel.onUpdate = (_u, bytes) =>
        report.bumpCounters({ updates: 1, signatures: 2, verifications: 2, bytes });

      protocolRef.current = protocol;
      tunnelRef.current = tunnel;
      report.bumpCounters({ tunnelsOpened: 1 });
      report.setActive(2);
      setResult(null);
      setStatus("playing");
      setView(deriveView(tunnel.state));

      timerRef.current = setInterval(() => {
        const p = protocolRef.current;
        const t = tunnelRef.current;
        if (!p || !t) return;
        const prevBalanceA = t.state.balanceA;
        const moved = stepSession(p, t, Math.random);
        setView(deriveView(t.state));

        // A settled round (now round_over with a balance change) => a panel txn.
        if (moved && t.state.phase === "round_over" && t.state.balanceA !== prevBalanceA) {
          const delta = t.state.balanceA - prevBalanceA;
          report.pushTxn({
            time: new Date().toLocaleTimeString("en-GB"),
            bot: "Player Bot",
            type: delta > 0n ? "Blackjack Win" : "Blackjack Loss",
            status: "Success",
            amount: `${delta > 0n ? "+" : "-"}$${Math.abs(Number(delta)).toFixed(2)}`,
          });
        }

        if (!moved || p.isTerminal(t.state)) {
          stopTimer();
          t.buildSettlement(0n); // co-signed cooperative settlement artifact
          report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
          report.setActive(0);
          setResult(sessionResult(t.state, stakeRef.current));
          setStatus("settled");
        }
      }, STEP_MS);
    },
    [report, stopTimer],
  );

  // Clean up the timer if the component unmounts mid-session.
  useEffect(() => stopTimer, [stopTimer]);

  return { status, view, result, stake, start, reset };
}
