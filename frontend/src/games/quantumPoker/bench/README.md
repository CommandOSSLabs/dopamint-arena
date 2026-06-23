# Quantum Poker settlement benchmarks

Experiments measuring off-chain throughput (TPS) of the Quantum Poker self-play
tunnels, and two strategies for raising it. Lives on the `poker-settle-experiments`
branch only — kept off the feature PR.

All numbers below are end-to-end through a **local** `tunnel-manager` backend
(`/settle` = cooperative close on-chain **+** Walrus archive), testnet RPC,
hand_cap = hands per tunnel. One off-chain update ≈ one transcript entry ≈ ~10 KB.

## The benches

| file | what it measures |
|---|---|
| `settleBench.ts` | Off-chain play + direct Walrus PUT (no backend). Size ↔ upload-time fit, sweet spot. |
| `settleBenchE2E.ts` | Real `/settle` per tunnel, **sequential** (open → play → settle). The "increase hand_cap" method. |
| `settleBenchE2EPipelined.ts` | Real `/settle`, **backgrounded** with concurrency cap D (settle of tunnel N overlaps play of N+1). The "pipeline settle" method. |
| `benchEnv.ts` | Preload: mirrors `PACKAGE_ID`/`SUI_NETWORK` from the backend `.env` before the SDK config loads. |

Run (from `frontend/`, local backend up + settler address-balance funded):

```bash
node --import tsx src/games/quantumPoker/bench/settleBenchE2E.ts 50 200 800 1600
node --import tsx src/games/quantumPoker/bench/settleBenchE2EPipelined.ts 800 6 3   # cap N D
```

## Two strategies to raise TPS

The fixed cost per tunnel is **~14 s** = open (~3 s) + settle floor (close + Walrus
~11 s). Raising TPS means amortizing or hiding that cost.

- **Increase hand_cap (sequential):** play more hands before each settle. Amortizes
  the fixed cost over more entries, but the transcript grows (~10 KB/hand) → needs
  the 64 MB `/settle` body limit, longer tunnels, bigger Walrus proofs. TPS is
  capped by the settle floor (~1460 even as cap → ∞).
- **Pipeline settle:** keep the cap moderate; don't `await` the settle — run it in
  the background (cap D concurrent) and start the next tunnel immediately. The slow
  close+Walrus overlaps the next tunnel's play. Decouples TPS from transcript size;
  ceiling is the in-process engine (~2500 TPS).

## Head-to-head (D = 3, 6 tunnels per pipeline point)

| hand_cap | MB/tunnel | body limit | increase-cap TPS | tunnel (s) | **pipeline TPS** | speedup | closes |
|---:|---:|:--|---:|---:|---:|---:|:--|
| 50 | 0.49 | 2 MB ✓ | 63 | 14.9 | **277** | 4.4× | 6/6 ✓ |
| 200 | 2.0 | 2 MB ✓ (edge) | 231 | 16.6 | **826** | 3.6× | 6/6 ✓ |
| 800 | 8.0 | needs 64 MB | 642 | 23.8 | **1609** | 2.5× | 6/6 ✓ |
| 1600 | 15.8 | needs 64 MB | 879 | 34.5 | **1913** | 2.2× | 6/6 ✓ |
| 3200 | 31.5 | needs 64 MB | 1014 | 59.6 | — | — | — |

*increase-cap TPS = entries/(open+play+settle), sequential. pipeline TPS = entries/(open+play),
settle hidden, steady-state (tail amortized).*

### Takeaways

1. **Same throughput at 1/8 the size.** Pipeline @ cap 200 (2.0 MB, fits the default
   2 MB body, 16 s tunnel) ≈ increase-cap @ cap 1600 (15.8 MB, needs 64 MB, 34 s
   tunnel). Pipeline gets there with small transcripts and no body-limit bump.
2. **Pipeline beats the increase-cap ceiling.** Increase-cap tops out ~1460 TPS
   (settle floor). Pipeline @ 1600 is already 1913 and keeps climbing toward the
   engine ceiling (~2500).
3. **Different trade.** Increase-cap buys TPS by bloating the transcript; pipeline
   separates TPS from size.

| | increase hand_cap | pipeline settle (D=3) |
|---|---|---|
| TPS ceiling | ~1460 | ~2500 |
| transcript/tunnel for high TPS | large (16–32 MB) | small, your choice |
| needs 64 MB body | yes | no (cap ≤ 200) |
| tunnel length | long (34–60 s) | short |
| on-chain close | few, sequential | many, concurrent (SIP-58 safe) |
| code | one constant | per-tunnel ctx + concurrency + retry |
| risk | low | medium (de-risked here) |

## Concurrency safety (the load-bearing finding)

Concurrent cooperative closes are **safe** when each gas source is distinct:

- The backend closes with **SIP-58 address-balance gas** (no shared gas coin → no
  equivocation; ADR-0005). D=3 concurrent closes: **6/6 succeeded** across every cap.
- **Gotcha:** opens and closes must not draw gas from the *same* address balance.
  An early bench run signed opens with the settler too — opens and closes then
  contended on one address balance and 2/6 closes failed with
  `InsufficientFundsForWithdraw`. Isolating opens to a separate account (the app's
  model: bot A opens, settler closes) fixed it → 6/6. Under concurrency, Walrus
  upload latency rises (shared bandwidth: ~14.6 s → ~17.9 s at cap 800) but the
  overlap still wins decisively.

**Implication for the app:** the Auto lane already uses distinct accounts (bot A
opens, backend settler closes), so pipelining is safe. If the wallet-side fallback
close (`closeCooperativeWithRoot`, signed by bot A) ever runs concurrently, it must
be serialized — bot A has one gas coin.

## Recommendation

Pipeline settle at a moderate cap. Two good points:

- **cap 200 + pipeline** — 826 TPS, fits the 2 MB default body, short tunnels,
  simplest infra.
- **cap 800 + pipeline** — 1609 TPS, accepts the 64 MB body.

Implementation sketch lives in chat / the `useQuantumPokerAuto` design notes:
per-tunnel context object, background settle with cap D + backpressure, retry queue
for failed background settles, a "settling: N" badge.
