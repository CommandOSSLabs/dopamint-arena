# loadbench JS-overhead ablation — design

## Problem

`rustbench` is a Rust reimplementation of loadbench's blackjack match loop used
as a throughput *ceiling*. It already mirrors part of loadbench's harness shape
(`run_fresh_keys`, simple-vs-optimized TPS) but, by design, keeps the efficient
binary codec and native in-process crypto. The remaining structural costs that
make loadbench (the real `sui-tunnel-ts` JS engine) slower than rustbench are
not yet explained:

- `JSON.stringify`+`JSON.parse` move codec (encode and decode), every move
- a `Promise` + `await` per move (microtask scheduling)
- bigint arithmetic instead of `u64`
- GC churn (Promises, JSON strings, `Uint8Array`s per move)
- a JS→BoringSSL binding hop per sign/verify, vs in-process dalek
- JIT vs AOT-native

This work attributes loadbench's per-move cost to each of these, as a faithful
line-item breakdown measured in the real Node/V8 engine path. It is an
**attribution/ablation** tool: it explains the gap, it does not try to make the
numbers converge, and it does not optimize loadbench or change the engine.

## Non-goals

- No optimization of loadbench or edits to the upstream `sui-tunnel-ts` engine.
- No convergence of loadbench and rustbench numbers.
- No relay/onchain anchors, no multi-worker fleet (ablation is single-thread).
- JIT-vs-AOT is not a measured line — it is part of the residual.

## Approach: capture-then-replay (JS-side, real-engine-path)

Measure each overhead in the real Node/V8 environment by capturing the real
artifacts a real match produces, then timing the **real engine functions** over
those artifacts out-of-band. This avoids editing upstream engine internals and
avoids perturbing the hot loop with in-line timers.

### Real-path seams (confirmed)

The real single-thread `playMatch` move loop
(`tools/loadbench/src/match.ts`) pays, per move:

- `bigintSafeCodec.encode`/`decode` — a double-JSON move codec (loadbench-owned,
  `match.ts`).
- `encodeFrame`/`decodeFrame` — frame-level `JSON.stringify`/`parse` +
  `textEncoder`/`textDecoder` (`sui-tunnel-ts/src/core/distributedFrame.ts`).
- bigint `.toString()` / `BigInt()` conversions in encode/decode; bigint nonce,
  timestamp, balances.
- one awaited `Promise` via `proposeAndAwait` (`match.ts`).
- native `crypto.sign` / `crypto.verify` per propose+ack — the JS→BoringSSL hop
  (`nativeBackend`, `sui-tunnel-ts/src/core/crypto-native.ts`); a pure-JS
  `nobleBackend` exists as a cross-check seam.

All capture seams are loadbench-owned (transports, `bigintSafeCodec`) or public
engine seams (`setDefaultBackend`, exported `encodeFrame`/`decodeFrame`,
`nativeBackend`/`nobleBackend`). No upstream edits.

## Components

### 1. Capture — `tools/loadbench/src/ablation.ts`

Two deterministic, identical blackjack matches via the real `playMatch`
(`--channel local --offchain`, single thread, 34 moves):

- **Clean timed match** → the per-move wall budget `T_move` and aggregate GC.
  Only a passive `perf_hooks` `PerformanceObserver` on `gc` entries is attached
  (no recording wrappers), so recording overhead does not inflate the budget.
- **Recording match** → harvests real artifacts:
  - wrap the two transports to record every encoded frame `Uint8Array`.
  - wrap `bigintSafeCodec.encode`/`decode` to record real move objects and count
    calls.
  - install a capturing crypto backend via `setDefaultBackend` that delegates to
    `nativeBackend` while recording each `(message, signature)` and counting
    sign/verify ops; restored after the match.

Both matches are deterministic and identical (34 moves), so captured artifacts
correspond to the timed budget. A determinism guard (two captures yield the same
move count, observed 34) guards capture correctness.

Captured outputs: `moves[]`, `frames[]` (raw bytes), `messages[]` (signed
payloads), `keyPairs`, per-move op counts (codec/frame/sign/verify), `T_move`,
aggregate GC pause-ms and alloc-bytes.

### 2. Replay / measure — `tools/loadbench/src/ablation.ts`

Per overhead, a warmed, repeated-trial (median-of-N, `--trials`) tight loop over
the captured artifacts using the real engine functions, scaled to ns/move via
the captured per-move op counts:

| line | what is timed | over |
|---|---|---|
| JSON move codec | `bigintSafeCodec.encode` + `decode` | captured moves |
| frame JSON + text enc/dec | `encodeFrame` + `decodeFrame` | captured frames |
| bigint conversions | real `.toString()`/`BigInt()` + bigint-vs-number arithmetic delta | captured nonce/ts/balances |
| await / microtask | real `proposeAndAwait` Promise/`onConfirmed` shape, resolving synchronously | N iterations |
| crypto sign+verify (native hop) | real `nativeBackend` signer/verifier; native-vs-`nobleBackend` cross-check | captured messages |
| GC churn (aggregate) | pause-ms/move + alloc-bytes/move | from capture |

### 3. Report — `tools/loadbench/src/ablationReport.ts`

`[local/offchain]`-prefixed table: `overhead | ns/move | % of budget`, then:

- attributed subtotal,
- **unattributed residual** (engine logic + JIT/AOT + measurement context),
- measured per-move budget (100%),
- optional rustbench per-move floor reference line.

Stdout table + markdown written to `reports/ablation-<env>-<ts>.md`, matching the
existing report style (`src/report.ts`). Pure string building; the entry prints.

### 4. CLI — `tools/loadbench/src/cli.ts`

New `--ablation` mode (default `--game blackjack`, `--channel local`,
`--offchain`; `--trials N` for replay repetitions). Invoked via
`bun run bench --ablation`.

## Data flow

```
real match (clean)     → T_move, aggregate GC
real match (recording) → moves[], frames[], messages[], keyPairs, op counts
                       → per-overhead replay loops → ns/move
                       → ablationReport → stdout table + markdown
```

## Error handling

- Native backend unsupported → skip the crypto-native line with a noted reason;
  noble cross-check still runs.
- Match error during capture → abort with a clear message.
- Determinism guard failure (two captures disagree on move count) → abort;
  capture is not trustworthy.

## Honesty caveats (stated in the report)

Isolated costs are measured outside the real interleaving (cache/locality
differ), so the attributed subtotal will not exactly equal the measured budget.
The residual absorbs engine logic, JIT-vs-AOT, and measurement-context drift. The
report states this rather than implying a clean decomposition.

## Testing

- **Unit**: report rendering (golden string), ns/move→% math.
- **Integration** (real engine, no infra, offchain local):
  - blackjack capture is deterministic (two captures yield the same move count; observed 34),
  - `encodeFrame`/`decodeFrame` round-trips a captured frame,
  - per-move op counts > 0,
  - the capturing backend's delegated sign/verify count matches the expected
    per-move count,
  - both `nativeBackend` and `nobleBackend` produce a crypto measurement.
- No flaky absolute-timing assertions — assert structure, shape, and
  determinism, not nanoseconds.
</content>
</invoke>
