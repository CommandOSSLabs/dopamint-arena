import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { BombItProtocol } from "sui-tunnel-ts/protocol/bombIt";
import type { BombItState, BombItMove } from "sui-tunnel-ts/protocol/bombIt";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import { closeCooperativeWithRoot, openAndFundSelfPlay, readCreatedAt } from "../../onchain/tunnelTx";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { getControlPlaneClient } from "../../backend/controlPlane";
import { coSignedToSettleRequest } from "../../backend/settleRequest";
import { useSponsoredSignExec } from "../../onchain/useSponsoredSignExec";
import { withSponsorFallback } from "../../onchain/sponsor";
import { DOPAMINT_COIN_TYPE, isDopamintConfigured } from "../../onchain/dopamint";
import { deriveView, sessionResult, stepSession, type BombItResult, type BombItView } from "./session-core";

/**
 * Bomb It TPS benchmark: a bot-vs-bot self-play loop whose purpose is to GENERATE throughput.
 * Both seats run in-process via OffchainTunnel.selfPlay (co-signing is local — no relay, no RTT
 * ceiling), so the per-game rate is a pacing knob, not a network limit. A rate-controlled stepper
 * advances `targetTps` dual-signed ticks/sec (each = one effective-TPS unit, fed to the live
 * telemetry panel); render is throttled to the frame cadence so 50-100 TPS doesn't melt React.
 * Every game is a real on-chain create_and_fund -> cooperative close (one wallet signature each),
 * so the throughput it reports is settleable, not synthetic. Twin of useChickenCrossSession.
 */

/** Per-seat locked stake (MIST). The smallest fundable stake — this is an exhibition bench that
 *  loops many games, so keep the per-game SUI footprint minimal (spec §3 testnet-SUI long-pole). */
const STAKE = 1_000_000_000n; // per-seat: 1 DOPAMINT (9 decimals)
/** Render/measure cadence. Ticks are batched per frame to hit targetTps regardless of this value. */
const FRAME_MS = 50;
const DEFAULT_TARGET_TPS = 75;
const MIN_TARGET_TPS = 10;
const MAX_TARGET_TPS = 200;

export type BenchStatus = "idle" | "funding" | "playing" | "settling" | "settled" | "error";

export interface BombItBenchSession {
  status: BenchStatus;
  running: boolean;
  view: BombItView | null;
  /** Requested ticks/sec for the current game (live-adjustable). */
  targetTps: number;
  /** Measured ticks/sec within the current game (the honest per-game throughput). */
  measuredTps: number;
  /** Cooperatively-settled games this run. */
  gamesSettled: number;
  /** Dual-signed updates produced this run (cumulative TPS units). */
  totalUpdates: number;
  result: BombItResult | null;
  error: string | null;
  /** Begin the continuous bench loop. No-op if already running. */
  start: () => void;
  /** Stop after the in-flight game finishes and settles. */
  stop: () => void;
  setTargetTps: (n: number) => void;
  reset: () => void;
}

const clampTps = (n: number): number =>
  Math.max(MIN_TARGET_TPS, Math.min(MAX_TARGET_TPS, Math.round(Number.isFinite(n) ? n : DEFAULT_TARGET_TPS)));

export function useBombItBenchSession(): BombItBenchSession {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();

  const [status, setStatus] = useState<BenchStatus>("idle");
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<BombItView | null>(null);
  const [targetTps, setTargetTpsState] = useState(DEFAULT_TARGET_TPS);
  const [measuredTps, setMeasuredTps] = useState(0);
  const [gamesSettled, setGamesSettled] = useState(0);
  const [totalUpdates, setTotalUpdates] = useState(0);
  const [result, setResult] = useState<BombItResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runningRef = useRef(false);
  const targetTpsRef = useRef(DEFAULT_TARGET_TPS);
  const protocolRef = useRef<BombItProtocol | null>(null);
  const tunnelRef = useRef<OffchainTunnel<BombItState, BombItMove> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const gameStartRef = useRef(0);
  const gameUpdatesRef = useRef(0);
  const totalUpdatesRef = useRef(0);
  const txnIdRef = useRef(0);
  // Per-frame telemetry accumulators: ticks fire up to MAX_TARGET_TPS/sec, so counters are
  // batched and flushed ONCE per frame (telemetry's bumpCounters does a setState per call).
  const frameUpdatesRef = useRef(0);
  const frameBytesRef = useRef(0);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const setTargetTps = useCallback((n: number) => {
    const v = clampTps(n);
    targetTpsRef.current = v;
    setTargetTpsState(v);
  }, []);

  /** Drive one game's ticks at targetTps; resolves at terminal state or when stopped. */
  const runTicks = useCallback(
    (): Promise<void> =>
      new Promise((resolve) => {
        let lastMs = performance.now();
        let carry = 0; // fractional ticks carried between frames so the rate stays exact
        timerRef.current = setInterval(() => {
          const p = protocolRef.current;
          const t = tunnelRef.current;
          if (!p || !t) {
            stopTimer();
            resolve();
            return;
          }
          const now = performance.now();
          carry += targetTpsRef.current * ((now - lastMs) / 1000);
          lastMs = now;
          let budget = Math.floor(carry);
          carry -= budget;

          let terminal = false;
          while (budget-- > 0) {
            if (!stepSession(p, t, Math.random)) {
              terminal = true;
              break;
            }
          }

          // Flush this frame's batched ticks as one telemetry bump (exact counts; ~2 sigs/update).
          if (frameUpdatesRef.current > 0) {
            const n = frameUpdatesRef.current;
            report.bumpCounters({
              updates: n,
              signatures: 2 * n,
              verifications: 2 * n,
              bytes: frameBytesRef.current,
            });
            frameUpdatesRef.current = 0;
            frameBytesRef.current = 0;
          }

          setView(deriveView(t.state));
          const elapsed = (now - gameStartRef.current) / 1000;
          if (elapsed > 0) setMeasuredTps(gameUpdatesRef.current / elapsed);

          if (terminal || p.isTerminal(t.state) || !runningRef.current) {
            stopTimer();
            resolve();
          }
        }, FRAME_MS);
      }),
    [report, stopTimer],
  );

  const reset = useCallback(() => {
    runningRef.current = false;
    stopTimer();
    protocolRef.current = null;
    tunnelRef.current = null;
    report.setActive(0);
    setRunning(false);
    setStatus("idle");
    setView(null);
    setMeasuredTps(0);
    setResult(null);
    setError(null);
  }, [report, stopTimer]);

  const start = useCallback(() => {
    if (runningRef.current) return;
    if (!account) {
      setError("connect a wallet to fund the benchmark tunnels");
      setStatus("error");
      return;
    }
    const signExec = async (tx: Parameters<typeof signAndExecute>[0]["transaction"]) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    };
    const reads = client as unknown as Parameters<typeof openAndFundSelfPlay>[0]["reads"];

    runningRef.current = true;
    setRunning(true);
    setError(null);
    setResult(null);

    (async () => {
      try {
        while (runningRef.current) {
          // --- open + fund both bot seats in ONE wallet signature (create_and_fund) ---
          const a = createParticipant("bomb-bench-a");
          const b = createParticipant("bomb-bench-b");
          const protocol = new BombItProtocol();

          setStatus("funding");
          const partyA = { address: a.address, publicKey: a.keyPair.publicKey };
          const partyB = { address: b.address, publicKey: b.keyPair.publicKey };
          const coinType = isDopamintConfigured ? DOPAMINT_COIN_TYPE : undefined;
          // DOPAMINT (ADR-0010): faucet both seats' stake invisibly (gas-sponsored) and stake
          // DOPAMINT — free for a 0-SUI player. SUI path (DOPAMINT env unset): sponsored SUI stake
          // with a sender-pays fallback (ADR-0009).
          const tunnelId = isDopamintConfigured
            ? await openAndFundSelfPlay({
                reads,
                signExec: sponsored.signExec as never,
                partyA,
                partyB,
                aAmount: STAKE,
                bAmount: STAKE,
                coinType,
                stakeCoinId: await sponsored.prepareStake(2n * STAKE),
              })
            : await withSponsorFallback(
                async () =>
                  openAndFundSelfPlay({
                    reads,
                    signExec: sponsored.signExec as never,
                    partyA,
                    partyB,
                    aAmount: STAKE,
                    bAmount: STAKE,
                    stakeCoinId: await sponsored.selectStakeCoin(2n * STAKE),
                  }),
                () =>
                  openAndFundSelfPlay({
                    reads,
                    signExec: signExec as never,
                    partyA,
                    partyB,
                    aAmount: STAKE,
                    bAmount: STAKE,
                  }),
                "bombIt bench open/fund",
              );
          if (!runningRef.current) break;
          const createdAt = await readCreatedAt(reads, tunnelId);

          const tunnel = OffchainTunnel.selfPlay(
            protocol,
            tunnelId,
            a.keyPair,
            b.keyPair,
            a.address,
            b.address,
            { a: STAKE, b: STAKE },
          );
          const transcript = new Transcript(tunnelId);
          gameUpdatesRef.current = 0;
          frameUpdatesRef.current = 0;
          frameBytesRef.current = 0;
          tunnel.onUpdate = (u, bytes) => {
            transcript.append(u);
            gameUpdatesRef.current += 1;
            totalUpdatesRef.current += 1;
            frameUpdatesRef.current += 1;
            frameBytesRef.current += bytes;
          };

          protocolRef.current = protocol;
          tunnelRef.current = tunnel;
          report.bumpCounters({ tunnelsOpened: 1 });
          report.setActive(2);
          setView(deriveView(tunnel.state));
          setStatus("playing");
          gameStartRef.current = performance.now();

          await runTicks();

          // --- cooperative close: pays the pot to the winning bot, returns the tunnel ---
          setStatus("settling");
          report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
          report.setActive(0);
          const res = sessionResult(tunnel.state);
          setResult(res);
          if (res === "A" || res === "B") {
            txnIdRef.current += 1;
            report.pushTxn({
              id: txnIdRef.current,
              game: "bomb-it",
              time: new Date().toLocaleTimeString("en-GB"),
              bot: res === "A" ? "Bomber A" : "Bomber B",
              type: "Bomb It Win",
              status: "Success",
              amount: `+$${Number(tunnel.state.total)}`,
            });
          }
          // Settle through the backend /settle API: the server submits the close AND archives the
          // transcript (ADR-0002/0005). Fall back to a wallet/sponsor close if the backend is down.
          // coinType must match the tunnel's coin; closing via the gas sponsor is free for a 0-SUI
          // player (DOPAMINT), while the SUI fallback closes sender-pays.
          const settlement = tunnel.buildSettlementWithRoot(createdAt, transcript.root(), 0n);
          try {
            await getControlPlaneClient().settle(
              tunnelId,
              coSignedToSettleRequest(settlement, transcript.toRecord().entries),
            );
          } catch (e) {
            console.warn("[bombIt] backend settle failed; falling back to wallet close:", e);
            await closeCooperativeWithRoot({
              signExec: (isDopamintConfigured ? sponsored.signExec : signExec) as never,
              tunnelId,
              settlement,
              coinType,
            });
          }

          setGamesSettled((n) => n + 1);
          setTotalUpdates(totalUpdatesRef.current);
          setStatus("settled");
        }
      } catch (e) {
        stopTimer();
        report.setActive(0);
        setError(String((e as Error)?.message ?? e));
        setStatus("error");
      } finally {
        runningRef.current = false;
        setRunning(false);
      }
    })();
  }, [account, client, signAndExecute, sponsored, report, runTicks, stopTimer]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
  }, []);

  // Tear down the timer on unmount (an in-flight on-chain tunnel is left open — same as the
  // chicken-cross self-play driver; a later cooperative close or timeout reclaims its stake).
  useEffect(() => {
    return () => {
      runningRef.current = false;
      stopTimer();
    };
  }, [stopTimer]);

  return {
    status,
    running,
    view,
    targetTps,
    measuredTps,
    gamesSettled,
    totalUpdates,
    result,
    error,
    start,
    stop,
    setTargetTps,
    reset,
  };
}
