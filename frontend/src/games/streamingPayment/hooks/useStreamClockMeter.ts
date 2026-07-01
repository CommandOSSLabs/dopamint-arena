import { useEffect, useState } from "react";

import {
  computeAvailable,
  computeLocked,
  computeUnlocked,
  type StreamFields,
} from "@/onchain/streamingPayment";

import { CLOCK_METER_INTERVAL_MS } from "../utils/constants";
import { StreamStatus } from "sui-tunnel-ts";

/** Clock-driven meter for an active PaymentStream (mirrors on-chain unlock). */
export function useStreamClockMeter(stream: StreamFields | null) {
  const [nowMs, setNowMs] = useState(() => BigInt(Date.now()));

  useEffect(() => {
    if (!stream) return;

    const id = setInterval(() => {
      if (stream.status === StreamStatus.CANCELLED) {
        clearInterval(id);
      }

      setNowMs(BigInt(Date.now()));
    }, CLOCK_METER_INTERVAL_MS);

    return () => clearInterval(id);
  }, [stream]);

  if (!stream) {
    return {
      clockUnlocked: 0n,
      available: 0n,
      locked: 0n,
      fillPct: 0,
    };
  }

  const clockUnlocked = computeUnlocked(stream, nowMs);
  const available = computeAvailable(stream, nowMs);
  const locked = computeLocked(stream, nowMs);
  const total = stream.totalAmount > 0n ? stream.totalAmount : 1n;
  const fillPct = Math.min(100, Number((clockUnlocked * 100n) / total));

  return { clockUnlocked, available, locked, fillPct };
}
