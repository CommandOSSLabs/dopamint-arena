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
  // Feeds start empty (honest "no activity yet") and fill from real play / backend events;
  // the placeholder is only used as the offline-demo fallback (see the snapshot memo below).
  const [txns, setTxns] = useState<TxnRow[]>([]);
  const [localTxns, setLocalTxns] = useState<TxnRow[]>([]);
  const [tpsSeries, setTpsSeries] = useState<number[]>(
    PLACEHOLDER_SNAPSHOT.tpsSeries,
  );
  const [botsRunning, setBotsRunning] = useState<number>(
    PLACEHOLDER_SNAPSHOT.botsRunning,
  );
  const [hasActivity, setHasActivity] = useState(false);
  const { snapshot: backend, status } = useBackendStats();

  const counters = useRef<Counters>(newCounters());
  const startMs = useRef<number>(Date.now());
  // Monotonic feed-row id owned HERE, not by callers: a game's own counter resets per tunnel,
  // and the feeds are shared across games — caller ids collide and React drops rows by key.
  // Assigning the id on push keeps every row key globally unique. Computed outside the state
  // updater (which must stay pure / may run twice under StrictMode).
  const txnId = useRef(0);

  const pushTxn = useCallback((row: TxnRow) => {
    setHasActivity(true);
    const id = txnId.current++;
    setTxns((cur) => [{ ...row, id }, ...cur].slice(0, MAX_TXNS));
  }, []);

  const pushLocalTxn = useCallback((row: TxnRow) => {
    setHasActivity(true);
    const id = txnId.current++;
    setLocalTxns((cur) => [{ ...row, id }, ...cur].slice(0, MAX_TXNS));
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
    // Reserve the demo placeholder for a genuinely-offline backend with no local play. While
    // connecting or live, show real-or-empty so a refresh never flashes fake data first.
    if (status === "offline" && !hasActivity) return PLACEHOLDER_SNAPSHOT;

    const elapsed = Math.max(1, Date.now() - startMs.current);
    const localRate = rateReport(
      hasActivity ? counters.current : newCounters(),
      elapsed,
    );
    return {
      rate: {
        ...localRate,
        updatesPerSec: displayUpdatesPerSec(backend, localRate.updatesPerSec),
      },
      txns: liveOnchainTxns(backend, hasActivity ? txns : []),
      localTxns: hasActivity ? localTxns : [],
      deposits: PLACEHOLDER_SNAPSHOT.deposits,
      tpsSeries,
      botsRunning,
      totalBalance: PLACEHOLDER_SNAPSHOT.totalBalance,
      successRate:
        localRate.errors === 0
          ? 100
          : (localRate.updates / (localRate.updates + localRate.errors)) * 100,
    };
  }, [hasActivity, txns, localTxns, tpsSeries, botsRunning, backend, status]);

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

  return (
    <TelemetryContext.Provider value={value}>
      {children}
    </TelemetryContext.Provider>
  );
}

export function useTelemetry(): TelemetryContextValue {
  const ctx = useContext(TelemetryContext);
  if (!ctx)
    throw new Error("useTelemetry must be used within a TelemetryProvider");
  return ctx;
}
