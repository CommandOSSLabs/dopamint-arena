import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { newCounters, rateReport } from "sui-tunnel-ts/telemetry/metrics";
import type { Counters } from "sui-tunnel-ts/telemetry/metrics";
import type { TelemetrySnapshot, TxnRow } from "../panels/types";
import { PLACEHOLDER_SNAPSHOT } from "../placeholders";
import { useBackendStats } from "../backend/useBackendStats";
import { liveOnchainTxns, displayUpdatesPerSec } from "../backend/liveMerge";

const MAX_TXNS = 12;
const MAX_SERIES = 20;

/** Writer API games call to push their off-chain activity into the live panels. */
export interface TelemetryWriter {
  /** Prepend a transaction row (capped to the most recent MAX_TXNS). */
  pushTxn: (row: TxnRow) => void;
  /** Prepend a My-Activity row (local off-chain move, capped to MAX_TXNS). */
  pushLocalTxn: (row: TxnRow) => void;
  /** Accumulate engine counters from one or more co-signed updates. */
  bumpCounters: (delta: Partial<Counters>) => void;
  /** Set the number of bots currently running. */
  setActive: (n: number) => void;
}

interface TelemetryContextValue {
  snapshot: TelemetrySnapshot;
  report: TelemetryWriter;
}

const TelemetryContext = createContext<TelemetryContextValue | null>(null);

export function TelemetryProvider({ children }: { children: ReactNode }) {
  // Seed from the placeholder so the shell looks populated before any play.
  const [txns, setTxns] = useState<TxnRow[]>(PLACEHOLDER_SNAPSHOT.txns);
  const [localTxns, setLocalTxns] = useState<TxnRow[]>(PLACEHOLDER_SNAPSHOT.localTxns);
  const [tpsSeries, setTpsSeries] = useState<number[]>(PLACEHOLDER_SNAPSHOT.tpsSeries);
  const [botsRunning, setBotsRunning] = useState<number>(PLACEHOLDER_SNAPSHOT.botsRunning);
  const [hasActivity, setHasActivity] = useState(false);
  const backend = useBackendStats();

  const counters = useRef<Counters>(newCounters());
  const startMs = useRef<number>(Date.now());

  const pushTxn = useCallback((row: TxnRow) => {
    setHasActivity(true);
    setTxns((cur) => [row, ...cur].slice(0, MAX_TXNS));
  }, []);

  const pushLocalTxn = useCallback((row: TxnRow) => {
    setHasActivity(true);
    setLocalTxns((cur) => [row, ...cur].slice(0, MAX_TXNS));
  }, []);

  const bumpCounters = useCallback((delta: Partial<Counters>) => {
    setHasActivity(true);
    const c = counters.current;
    c.updates += delta.updates ?? 0;
    c.signatures += delta.signatures ?? 0;
    c.verifications += delta.verifications ?? 0;
    c.bytes += delta.bytes ?? 0;
    c.tunnelsOpened += delta.tunnelsOpened ?? 0;
    c.tunnelsClosed += delta.tunnelsClosed ?? 0;
    c.disputes += delta.disputes ?? 0;
    c.settlements += delta.settlements ?? 0;
    c.errors += delta.errors ?? 0;
    const elapsed = Math.max(1, Date.now() - startMs.current);
    const ups = rateReport(c, elapsed).updatesPerSec;
    setTpsSeries((cur) => [...cur, Math.round(ups)].slice(-MAX_SERIES));
  }, []);

  const setActive = useCallback((n: number) => setBotsRunning(n), []);

  const snapshot = useMemo<TelemetrySnapshot>(() => {
    const elapsed = Math.max(1, Date.now() - startMs.current);
    const localRate = hasActivity ? rateReport(counters.current, elapsed) : PLACEHOLDER_SNAPSHOT.rate;
    if (!hasActivity && !backend) return PLACEHOLDER_SNAPSHOT;
    return {
      rate: { ...localRate, updatesPerSec: displayUpdatesPerSec(backend, localRate.updatesPerSec) },
      txns: liveOnchainTxns(backend, hasActivity ? txns : PLACEHOLDER_SNAPSHOT.txns),
      localTxns: hasActivity ? localTxns : PLACEHOLDER_SNAPSHOT.localTxns,
      deposits: PLACEHOLDER_SNAPSHOT.deposits,
      tpsSeries,
      botsRunning,
      totalBalance: PLACEHOLDER_SNAPSHOT.totalBalance,
      successRate: localRate.errors === 0 ? 100 : (localRate.updates / (localRate.updates + localRate.errors)) * 100,
    };
  }, [hasActivity, txns, localTxns, tpsSeries, botsRunning, backend]);

  // Keep `report` stable across snapshot updates so consumers' callbacks that
  // depend on it (e.g. a game's start/reset) don't churn on every counter bump.
  const report = useMemo<TelemetryWriter>(
    () => ({ pushTxn, pushLocalTxn, bumpCounters, setActive }),
    [pushTxn, pushLocalTxn, bumpCounters, setActive],
  );
  const value = useMemo<TelemetryContextValue>(
    () => ({ snapshot, report }),
    [snapshot, report],
  );

  return <TelemetryContext.Provider value={value}>{children}</TelemetryContext.Provider>;
}

export function useTelemetry(): TelemetryContextValue {
  const ctx = useContext(TelemetryContext);
  if (!ctx) throw new Error("useTelemetry must be used within a TelemetryProvider");
  return ctx;
}
