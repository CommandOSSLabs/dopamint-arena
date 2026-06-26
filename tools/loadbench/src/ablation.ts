import { PerformanceObserver } from "node:perf_hooks";
import type { Transport } from "../../../sui-tunnel-ts/src/core/distributedTunnel";
import {
  setDefaultBackend,
  nativeBackend,
  nativeBackendSupported,
} from "../../../sui-tunnel-ts/src/core/crypto-native";
import {
  nobleBackend,
  type CryptoBackend,
  type SignFn,
  type VerifyFn,
} from "../../../sui-tunnel-ts/src/core/crypto";
import { makeSeats, playMatch } from "./match";
import { kitFor, gameStake } from "./games";
import { pairLocalChannel } from "./channels/localChannel";

/** Median per-call nanoseconds: `trials` batches of `iters` calls, median of batch means. */
export function medianNs(fn: () => void, iters: number, trials: number): number {
  const means: number[] = [];
  // warmup
  for (let i = 0; i < iters; i++) fn();
  for (let t = 0; t < trials; t++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn();
    const end = process.hrtime.bigint();
    means.push(Number(end - start) / iters);
  }
  means.sort((x, y) => x - y);
  return means[Math.floor(means.length / 2)];
}

export interface AblationCapture {
  game: string;
  moves: number;
  frames: Uint8Array[];
  cryptoSecret: Uint8Array;
  cryptoPublic: Uint8Array;
  signMessage: Uint8Array;
  signSignature: Uint8Array;
  signCount: number;
  verifyCount: number;
  perMoveBudgetNs: number;
  gcPauseNsPerMove: number | null;
}

function recordingTransport(t: Transport, sink: Uint8Array[]): Transport {
  return {
    send: (f) => {
      sink.push(f.slice());
      t.send(f);
    },
    onFrame: (cb) => t.onFrame(cb),
  };
}

interface CryptoRec {
  secret: Uint8Array | null;
  pub: Uint8Array | null;
  signMessage: Uint8Array | null;
  signSignature: Uint8Array | null;
  signCount: number;
  verifyCount: number;
}

function capturingBackend(base: CryptoBackend, rec: CryptoRec): CryptoBackend {
  return {
    name: "capturing",
    makeSigner(secret: Uint8Array): SignFn {
      if (!rec.secret) rec.secret = secret.slice();
      const fn = base.makeSigner(secret);
      return (message) => {
        const sig = fn(message);
        rec.signCount++;
        if (!rec.signMessage) {
          rec.signMessage = message.slice();
          rec.signSignature = sig.slice();
        }
        return sig;
      };
    },
    makeVerifier(pub: Uint8Array): VerifyFn {
      if (!rec.pub) rec.pub = pub.slice();
      const fn = base.makeVerifier(pub);
      return (message, signature) => {
        rec.verifyCount++;
        return fn(message, signature);
      };
    },
  };
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export async function captureMatch(game: string): Promise<AblationCapture> {
  const stake = gameStake(game);
  const baseBackend = nativeBackendSupported() ? nativeBackend : nobleBackend;

  // --- Clean match: per-move wall budget + aggregate GC (no recording overhead). ---
  let gcNs = 0;
  let gcObserved = false;
  let obs: PerformanceObserver | null = null;
  try {
    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        gcObserved = true;
        gcNs += e.duration * 1e6; // ms -> ns
      }
    });
    obs.observe({ entryTypes: ["gc"] });
  } catch {
    obs = null;
  }
  const cleanSeats = makeSeats(`ablate-clean`, { a: stake, b: stake }, 0n);
  const clean = await playMatch(kitFor(game), cleanSeats, pairLocalChannel(), {
    maxMoves: 1000,
  });
  obs?.disconnect();
  const moves = clean.moves;
  const perMoveBudgetNs = mean(clean.latenciesMs) * 1e6;
  const gcPauseNsPerMove = obs && gcObserved ? gcNs / moves : null;

  // --- Recording match: harvest real artifacts. ---
  const frames: Uint8Array[] = [];
  const rec: CryptoRec = {
    secret: null,
    pub: null,
    signMessage: null,
    signSignature: null,
    signCount: 0,
    verifyCount: 0,
  };
  setDefaultBackend(capturingBackend(baseBackend, rec));
  try {
    const [ta, tb] = pairLocalChannel();
    const seats = makeSeats(`ablate-rec`, { a: stake, b: stake }, 0n);
    await playMatch(
      kitFor(game),
      seats,
      [recordingTransport(ta, frames), recordingTransport(tb, frames)],
      { maxMoves: 1000 },
    );
  } finally {
    setDefaultBackend(null);
  }

  if (!rec.secret || !rec.pub || !rec.signMessage || !rec.signSignature) {
    throw new Error("ablation capture: crypto artifacts missing (no sign/verify observed)");
  }

  return {
    game,
    moves,
    frames,
    cryptoSecret: rec.secret,
    cryptoPublic: rec.pub,
    signMessage: rec.signMessage,
    signSignature: rec.signSignature,
    signCount: rec.signCount,
    verifyCount: rec.verifyCount,
    perMoveBudgetNs,
    gcPauseNsPerMove,
  };
}
