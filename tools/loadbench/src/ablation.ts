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
import {
  encodeFrame,
  decodeFrame,
  type Frame,
  type MoveFrame,
} from "../../../sui-tunnel-ts/src/core/distributedFrame";
import { bigintSafeCodec, proposeAndAwait, makeSeats, playMatch } from "./match";
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

export interface AblationLine {
  label: string;
  nsPerMove: number;
}

export interface AblationResult {
  game: string;
  moves: number;
  perMoveBudgetNs: number;
  buckets: AblationLine[];
  attributedNs: number;
  residualNs: number;
  subMeasures: AblationLine[];
}

export function measureAblation(cap: AblationCapture, trials = 5): AblationResult {
  const { moves } = cap;
  // Decode every captured frame once (real engine), keep the Frame objects for re-encode.
  const decoded: Frame<unknown>[] = cap.frames.map((bytes) =>
    decodeFrame(bytes, bigintSafeCodec),
  );

  // --- Bucket 1: JSON envelope + move codec (encode + decode of every frame). ---
  // Per match the engine encodes each frame (sender) and decodes it (receiver):
  // summing one encode + one decode per captured frame, divided by moves.
  const jsonTotalNs = medianNs(
    () => {
      for (let i = 0; i < cap.frames.length; i++) {
        const bytes = encodeFrame(decoded[i], bigintSafeCodec);
        decodeFrame(bytes, bigintSafeCodec);
      }
    },
    50,
    trials,
  );
  const jsonNsPerMove = jsonTotalNs / moves;

  // --- Bucket 2: crypto sign+verify via the native hop, scaled by real op counts. ---
  const baseBackend = nativeBackendSupported() ? nativeBackend : nobleBackend;
  const signNs = (backend: CryptoBackend): number => {
    const signer = backend.makeSigner(cap.cryptoSecret);
    return medianNs(() => void signer(cap.signMessage), 2000, trials);
  };
  const verifyNs = (backend: CryptoBackend): number => {
    const verifier = backend.makeVerifier(cap.cryptoPublic);
    return medianNs(() => void verifier(cap.signMessage, cap.signSignature), 2000, trials);
  };
  const nativeSign = signNs(baseBackend);
  const nativeVerify = verifyNs(baseBackend);
  const cryptoNsPerMove =
    (cap.signCount * nativeSign + cap.verifyCount * nativeVerify) / moves;

  // --- Bucket 3: Promise/await wrapper per move (synchronous-resolve stub). ---
  // Exactly one awaited proposeAndAwait per move in the real loop.
  // The stub's propose() immediately calls onConfirmed so the Promise settles
  // synchronously — medianNs works directly without a custom async harness.
  const awaitStub = {
    onConfirmed: undefined as ((u: unknown) => void) | undefined,
    propose(_m: unknown, _ts: bigint) {
      this.onConfirmed?.(undefined);
    },
  };
  const promiseNsPerMove = medianNs(
    () => {
      void proposeAndAwait(awaitStub as never, { kind: "noop" }, 1n);
    },
    2000,
    trials,
  );

  const buckets: AblationLine[] = [
    { label: "JSON envelope + move codec (encode+decode)", nsPerMove: jsonNsPerMove },
    { label: "crypto sign+verify (native hop)", nsPerMove: cryptoNsPerMove },
    { label: "Promise/await wrapper (proposeAndAwait)", nsPerMove: promiseNsPerMove },
  ];
  const attributedNs = buckets.reduce((a, b) => a + b.nsPerMove, 0);
  const residualNs = cap.perMoveBudgetNs - attributedNs;

  // --- Informational sub-measures (overlap the buckets; NOT added to the subtotal). ---
  const moveObjs = decoded
    .filter((f): f is MoveFrame<unknown> => f.kind === "move")
    .map((f) => f.move);
  const moveCodecNs =
    moveObjs.length === 0
      ? 0
      : medianNs(
          () => {
            for (const m of moveObjs) bigintSafeCodec.decode(bigintSafeCodec.encode(m));
          },
          200,
          trials,
        ) / moves;

  const bigints = decoded
    .filter((f): f is MoveFrame<unknown> => f.kind === "move")
    .map((f) => [f.nonce, f.timestamp, f.partyABalance, f.partyBBalance] as const);
  const bigintDeltaNs = bigintVsNumberDeltaNs(bigints, trials) / moves;

  const subMeasures: AblationLine[] = [
    { label: "of which move codec (encode+decode)", nsPerMove: moveCodecNs },
    { label: "bigint conversions+arithmetic vs number (isolated)", nsPerMove: bigintDeltaNs },
    {
      label: "crypto native sign+verify",
      nsPerMove: (cap.signCount * nativeSign + cap.verifyCount * nativeVerify) / moves,
    },
    {
      label: "crypto noble sign+verify",
      nsPerMove:
        (cap.signCount * signNs(nobleBackend) + cap.verifyCount * verifyNs(nobleBackend)) /
        moves,
    },
    { label: "GC pause (aggregate)", nsPerMove: cap.gcPauseNsPerMove ?? 0 },
  ];

  return {
    game: cap.game,
    moves,
    perMoveBudgetNs: cap.perMoveBudgetNs,
    buckets,
    attributedNs,
    residualNs,
    subMeasures,
  };
}

/** Isolated cost of doing the per-frame bigint work as bigint vs as number. */
function bigintVsNumberDeltaNs(
  rows: ReadonlyArray<readonly [bigint, bigint, bigint, bigint]>,
  trials: number,
): number {
  const big = medianNs(
    () => {
      let acc = 0n;
      for (const [nonce, ts, a, b] of rows) {
        acc += BigInt(nonce.toString()) + BigInt(ts.toString()) + a + b + 1n;
      }
      if (acc < 0n) throw new Error("unreachable");
    },
    200,
    trials,
  );
  const nums = rows.map(
    ([nonce, ts, a, b]) =>
      [Number(nonce), Number(ts), Number(a), Number(b)] as const,
  );
  const num = medianNs(
    () => {
      let acc = 0;
      for (const [nonce, ts, a, b] of nums) {
        acc += Number(String(nonce)) + Number(String(ts)) + a + b + 1;
      }
      if (acc < 0) throw new Error("unreachable");
    },
    200,
    trials,
  );
  return Math.max(0, big - num);
}
