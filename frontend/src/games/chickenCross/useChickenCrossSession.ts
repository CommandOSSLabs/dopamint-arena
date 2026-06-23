import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { CrossProtocol, MIN_STAKE } from "sui-tunnel-ts/protocol/cross";
import type { CrossState, CrossMove, CrossDir } from "sui-tunnel-ts/protocol/cross";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import { getControlPlaneClient, type RegisterSessionResult } from "../../backend/controlPlane";
import { settleViaBackend } from "../../backend/settle";
import { closeCooperativeWithRoot, openAndFundSelfPlay, readCreatedAt } from "../../onchain/tunnelTx";
import { useSponsoredSignExec } from "../../onchain/useSponsoredSignExec";
import { withSponsorFallback } from "../../onchain/sponsor";
import { DOPAMINT_COIN_TYPE, isDopamintConfigured } from "../../onchain/dopamint";
import {
  deriveView,
  sessionResult,
  stepSession,
  type CrossView,
  type SessionResult,
} from "./session-core";

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

export interface ChickenCrossSession {
  status: SessionStatus;
  view: CrossView | null;
  result: SessionResult | null;
  stake: number;
  error: string | null;
  /** Auto mode: when on (default), a bot autopilots your chicken; off = you steer it yourself. */
  auto: boolean;
  start: (stake: number) => void;
  reset: () => void;
  setDir: (dir: CrossDir) => void;
  toggleAuto: () => void;
}

/** You always steer chicken A in a solo race; chicken B is the bot opponent. */
const HUMAN_SEAT = "A" as const;

export function useChickenCrossSession(): ChickenCrossSession {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();

  const [status, setStatus] = useState<SessionStatus>("idle");
  const [view, setView] = useState<CrossView | null>(null);
  const [result, setResult] = useState<SessionResult | null>(null);
  const [stake, setStake] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAutoState] = useState(true);
  const autoRef = useRef(true);
  const myDirRef = useRef<CrossDir>("north");

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
    autoRef.current = true;
    myDirRef.current = "north";
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
          const coinType = isDopamintConfigured ? DOPAMINT_COIN_TYPE : undefined;
          const partyA = { address: a.address, publicKey: a.keyPair.publicKey };
          const partyB = { address: b.address, publicKey: b.keyPair.publicKey };
          // DOPAMINT (ADR-0010): faucet both seats' stake invisibly (gas-sponsored) and
          // stake DOPAMINT — free for a 0-SUI player. SUI path (DOPAMINT env unset):
          // sponsored SUI stake with a sender-pays fallback (ADR-0009).
          const tunnelId = isDopamintConfigured
            ? await openAndFundSelfPlay({
                reads,
                signExec: sponsored.signExec as never,
                partyA,
                partyB,
                aAmount: stakeBig,
                bAmount: stakeBig,
                coinType,
                stakeCoinId: await sponsored.prepareStake(2n * stakeBig),
              })
            : await withSponsorFallback(
                async () =>
                  openAndFundSelfPlay({
                    reads,
                    signExec: sponsored.signExec as never,
                    partyA,
                    partyB,
                    aAmount: stakeBig,
                    bAmount: stakeBig,
                    stakeCoinId: await sponsored.selectStakeCoin(2n * stakeBig),
                  }),
                () =>
                  openAndFundSelfPlay({
                    reads,
                    signExec: signExec as never,
                    partyA,
                    partyB,
                    aAmount: stakeBig,
                    bAmount: stakeBig,
                  }),
                "chickenCross open/fund",
              );
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
          // Record every co-signed update so the close can anchor the transcript root on-chain
          // (close_cooperative_with_root) and the backend can archive the proof to Walrus.
          const transcript = new Transcript(tunnelId);
          tunnel.onUpdate = (u, bytes) => {
            transcript.append(u);
            report.bumpCounters({ updates: 1, signatures: 2, verifications: 2, bytes });
          };

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
              // Settle through the backend /settle API: the server submits the close AND archives
              // the transcript to Walrus (ADR-0002/0005). Fall back to a wallet close if it's down.
              const settlement = tunnel.buildSettlementWithRoot(createdAt, transcript.root(), 0n);
              const coinType = isDopamintConfigured ? DOPAMINT_COIN_TYPE : undefined;
              await settleViaBackend({
                tunnelId,
                settlement,
                transcript: transcript.toRecord().entries,
                label: "chickenCross",
                fallbackClose: () =>
                  closeCooperativeWithRoot({
                    signExec: (isDopamintConfigured ? sponsored.signExec : signExec) as never,
                    tunnelId,
                    settlement,
                    coinType,
                  }),
              });
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
            // Co-sign ticks only until the per-frame time budget is spent, then yield: this is
            // what keeps TPS high yet the CPU cool (the rest of the frame stays idle).
            const deadline = performance.now() + FRAME_BUDGET_MS;
            // Auto on → both chickens are bot-driven (your chicken autopilots). Auto off → your
            // steered direction drives chicken A (auto-forward after each hop); the bot drives B.
            const human = autoRef.current
              ? null
              : {
                  seat: HUMAN_SEAT,
                  getDir: () => {
                    const d = myDirRef.current;
                    myDirRef.current = "north";
                    return d;
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

            // On the deciding frame, push a panel txn for the winner (push has no winner).
            if (ended && t.state.winner) {
              report.pushTxn({
                id: moveCountRef.current,
                game: "chicken-cross",
                time: new Date().toLocaleTimeString("en-GB"),
                bot: t.state.winner === "A" ? "Chicken A" : "Chicken B",
                type: "Chicken Cross Win",
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

  const setDir = useCallback((dir: CrossDir) => {
    myDirRef.current = dir;
  }, []);
  const toggleAuto = useCallback(() => {
    autoRef.current = !autoRef.current;
    myDirRef.current = "north";
    setAutoState(autoRef.current);
  }, []);

  useEffect(() => stopTimer, [stopTimer]);

  return { status, view, result, stake, error, auto, start, reset, setDir, toggleAuto };
}
