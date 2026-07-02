# On-chain Benchmark Pipeline — Capacity Model & Real-tx Settlement

**Status:** Capacity model locked; the gating numbers are unmeasured (TS localnet probe +
Daniel's Rust `fleet-bench` pending). Phase 1 = testnet pipeline; the mainnet burst
choreography is Phase 2, gated behind a green testnet run.

**Audience:** CommandOSS bench + framework authors (Daniel Lam — Rust fleet; George Digkas —
upstream framework); Kostas + PE for the asks at the end.

**Author:** SolEng (Yannis, SE/consult) — owns the capacity model, the TS measurement probe,
the game-mix budget, and the review of Daniel's Rust on-chain anchor ([ADR-0020](../decisions/0020-bot-fleet-topology-shared-core.md)).

## Why this doc

The team's headline benchmark — **~237–250k sustained / "4.95M peak" tunnelops/s** — is
**100% off-chain**. Bots play sui-tunnel games against each other in worker threads on a
couple of AWS boxes, but **never send a Sui transaction**: tunnels open and close in memory.
That number measures local ed25519 crypto throughput, not the chain. (The "4.95M peak" is a
debunked sampling artifact — a ~50k-update batch flush divided by a ~100 ms window; the
defensible off-chain figure is the ~237–250k dual-sign+verify updates/s/box.)

For the #1mtps launch we redo the experiment with **real Sui txs** opening and closing real
tunnels, under a **~300-tps privileged fullnode cap** (PE-provided, scalable, but we design
for 300 first). The goal is a **defensible 1M+** with **real on-chain settlement behind it**,
and a sized SUI cost — without ever relabelling off-chain crypto as Sui consensus TPS.

This doc states the capacity model the pipeline is built on, the game-mix budget that lands
1M+ at near-zero node cost, the measured per-tx SUI cost, and the cross-team asks. It
supersedes the working briefs in `.claude/artifacts/` (cost walkthrough + capacity brief).

## The three independent ceilings

The whole point of the redesign: there are **three** ceilings, and the old benchmark only
ever measured the first.

| Ceiling | Governs | Rough number | When it binds |
|---|---|---|---|
| **Off-chain compute** (ed25519 sign+verify) | raw moves/s (aggregate) | ~250k/box TS → higher on Rust; ~4–8 TS boxes (≈1–2 Rust) for 1M | **always** — the old bench's only domain |
| **On-chain open/close** (the 300-tps node) | tunnel **churn** rate | 300 tx/s | only for **low-`m`** games or deliberate continuous churn |
| **Relay / network** | serving-fleet only | n/a | bench is in-process ([ADR-0020](../decisions/0020-bot-fleet-topology-shared-core.md)) → **never** |

These are independent: the off-chain box ceiling is a property of the **language/runtime**,
the node ceiling is a property of the **chain**, and the relay ceiling never enters the bench
because the bench runs in-process. The redesign's job is to keep the headline on ceiling #1
and keep ceiling #2 idle during the peak.

## The phase-separated model (the core insight)

A tunnel opens **once at birth** and closes **once after its whole off-chain life** — opens
and closes are **separated in time**, not interleaved with play. So the benchmark's natural
shape is **three phases**, not one steady tx/s stream. With `N` concurrent tunnels, `mps`
moves/s per tunnel, and `B` tunnels batched per open PTB:

```
        node tx/s
  300 ┤■■■■■            (idle during the peak)            ■■■■■
      │ OPEN  ┌───────────────────────────────────────┐ CLOSE
      │ ramp  │                PLAY (the peak)         │ drain
    0 ┤       └───────────────────────────────────────┘
      └────────────────────────────────────────────────────────▶ time
        t_open = N/(300·B)   off-chain = N·mps ;  node ≈ 0    t_close = N/(300·B)
```

1. **OPEN** — open `N` tunnels. The node does **only opens** → the full 300 tps is for opens.
   `t_open = N / (300·B)`.
2. **PLAY** — the peak. Off-chain TPS = `N × mps`; the node is **≈ idle**. Duration = tunnel
   lifetime (chat: arbitrary; a bounded game: `m / mps`).
3. **CLOSE** — close `N` tunnels. The node does **only closes** → the full 300 tps is for
   closes. `t_close = N / (300·B)`.

> **There is no factor of 2.** Because OPEN and CLOSE never overlap, **each gets the full
> 300 tps**, and **during the PLAY peak the node is idle**. The 300-tps cap governs
> **ramp/drain time, not the peak.** (This corrects the earlier brief, which summed open+close
> into one 300-tps budget — `2 tx/tunnel` — and so understated the achievable peak. That sum
> only holds under *continuous churn*, below.)

So the headline is bounded by **off-chain compute** (the box count) **plus a short ramp** —
**not** by the node. `B` (a probe unknown) only moves the ramp time:

| target | mps/tunnel | N tunnels | `t_open` @ B=50 | `t_open` @ B=1 (worst) |
|---|---|---|---|---|
| 1M | 100 (chat) | 10,000 | 0.7 s | 33 s |
| 1M | ~180 (bombit tick) | ~5,600 | 0.4 s | 19 s |
| 10M | 100 | 100,000 | 6.7 s | 333 s |

⇒ **1M (even 10M) off-chain is not node-bound for carriers** — it is a few seconds of ramp
plus the off-chain box count. The peak costs the node ~nothing. This is "prove 1M cheaply,"
made concrete: even in the worst column the *peak* still holds; only ramp/drain stretches.

> **The `B=1` column doubles as the pessimistic node reading.** It is an open question for PE
> whether "300 tps" is **tx-count** (a fat 50-open PTB ≈ 1 unit → batching is a big win,
> `B=50`) or **execution-weighted** (a 50-open PTB ≈ 50 units of work → batching barely helps,
> effective opens/s ≈ 300, i.e. the `B=1` column). The true accepted rate sits between the two
> columns; **the TS probe measures it directly** (see *Measurement inputs*). Either way the
> peak is node-idle — only the ramp length is at stake.

### Continuous-churn sub-case (a *choice*, not the default)

If we deliberately rotate short-lived tunnels **during** the peak — to show live on-chain
settlements, or to run low-`m` variety games — then opens and closes overlap and **do** share
the budget. This is the **only** place the factor of 2 is real. With `C` tunnel
completions/s (opens/s = closes/s in steady state):

```
node tx/s = 2·C / B ≤ 300   ⇒   off-chain_from_churn = C·m ≤ 150·B·m
```

Use it sparingly — a small deliberate trickle for on-chain visibility, or to bound a
continuously-churned variety lane. Everything else runs in phase-separated waves at ~zero
peak node cost.

### Lifecycle decision: inline, no pre-stage (Phase 1)

We run **open → play → close in one pass** (no pre-staged tunnel pool). Because tunnels are
long-lived, opens and closes separate in time on their own — we get the phase separation
above for free, the peak is node-idle, and the run is self-contained. **Pre-staging** (slow
pre-open of a pool, then a short super-burst above sustained, then a staggered drain) only
buys a *transient* peak **above** the sustained off-chain rate — a "go beyond" lever for the
10M moment. It is deferred to **Phase 2**.

## Off-chain compute: box ceiling vs per-tunnel mps

The "1M off-chain TPS" headline is an **aggregate** — the sum of every tunnel's move rate.
Two numbers are easy to conflate:

- **Aggregate box ceiling** — total dual-sign+verify updates/s one box sustains across *all*
  its tunnels. This is what the old **TS worker-thread** bench measured (~237–250k/s/box) and
  what **Daniel's Rust (rayon) `fleet-bench`** raises (byte-exact wire parity, the canonical
  core per [ADR-0020](../decisions/0020-bot-fleet-topology-shared-core.md)). **Language lives
  here:** Rust → higher aggregate → **fewer boxes** for 1M (1M / ~250k ≈ 4 TS boxes, ~4–8 with
  headroom → ~1–2 Rust boxes).
- **Per-tunnel mps** — the "chat msgs/sec" figure. On the **local channel** (in-process, the
  bench transport) this is **not a fixed property**: it equals `aggregate_box_ceiling /
  tunnels_per_box`, a **knob**. The single-tunnel ping-pong ceiling (apply+sign+verify
  round-trip ≈ tens of µs → thousands of mps) sits far above any planning figure, so it never
  binds. Trade concurrency ↔ rate freely: 10k×100 = 5k×200 = the same 1M. **The mix plan pins
  this knob to the box-saturation knee** (≈200 tunnels/box ⇒ `mps ≈ box_ceiling/200 ≈ 800`) — the
  box-efficient *max* rate ⇒ the **minimum** tunnel count (≈200×boxes). Chosen to keep 10M
  tractable; a slower/human pace would mean proportionally more tunnels.

**So the language sets the box count, not a per-message wall.** What *does* put a hard ceiling
on per-tunnel mps is **transport**, not language:

| Transport | per-tunnel mps | Used by |
|---|---|---|
| **Local channel** (in-process, two seats co-sign) | CPU-bound → high (knob = aggregate / concurrency) | **the bench** (genuine two-party, no network) |
| **Relay** (WebSocket via AWS ECS) | RTT-bound → ~10–500 mps | serving fleet / real users |

So **"100 mps × 10k tunnels = 1M" is illustrative**: what is fixed and measured is the
aggregate box ceiling (Rust, from Daniel); the per-tunnel split is a knob, and as long as the
bench uses the **local channel**, network RTT never caps it. (Run a *small* slice over the
relay to prove the network path works — part of the two-rate honesty story — but keep the
headline volume on local.) The genuine-two-party requirement (Kostas: no `selfPlay`) costs
~nothing here: it is the same dual-sign work, routed through `DistributedTunnel` instead of
`OffchainTunnel.selfPlay`, over an in-process channel.

### Measured (fleet-bench, M4 14-core, 2026-06-29)

Per-game play move-TPS clusters at **~135k–169k/box** (≈10.7k/core) — ~game-independent, dominated
by the constant ed25519 sign+verify per move. **Outlier: tic-tac-toe ~10k (15× slower)** — minimax
bot CPU cost, not the tunnel (caro, same grid family, is 155k); flag for Daniel. AWS c7i.48xlarge
(192 vCPU) ≈ **~13.7×** → ~2M moves/s/box, so 1M off-chain ≈ **half an AWS box**.

**The serve (async) path matches the bench (sync) ceiling — but only when oversubscribed.** A
`fleet-serve`-style sweep (one tokio task per party, many tunnels multiplexed) hit **~160k moves/s
≈ 97% of the bench** at ≥200 tunnels/box, but only **~43% at 1 tunnel/core** (the A↔B ping-pong
leaves cores idle). So concurrent tunnels are NOT capped by cores — they must *exceed* them
(≳200/box). `box_offchain_ceiling` from the bench is therefore valid for the serve box count with no
derating, provided the experiment oversubscribes — and the mix calculator grounds `mps` on exactly
this knee (~200 tunnels/box).

The mix calculator (`tools/loadbench/src/mixPlan.ts`, `bun run plan`) turns these inputs +
B_open/B_close/node into per-game tunnel counts, boxes, ramp/drain, churn, and SUI for a target +
mix (`mps = box_ceiling/200`, tunnels = target/mps, boxes = target/`C_G`, churn = target/`m`).
**Minimal-tunnel plan (carriers-heavy default):** 1M ≈ **1,210 tunnels** / 0.44 AWS; 2M ≈ **2,416**
/ 0.88 AWS; 10M ≈ **12,070** / 4.4 AWS — ramp/drain ~0–0.2s, all under the **100k-tunnel
affordability cap** (the calculator flags any plan over it). The model is **multi-game
settle-once**: every tunnel opens once, plays many internal matches while held, and settles **once**
at drain → **no mid-peak churn**, lifetime tx ≈ 2·N (10M ≈ 24k opens+closes, **~99 SUI**). A
finite-`m` tunnel that finishes a match just starts the next (carry balance, reset) — it does not
close. An optional `--live-settles N` deliberately rotates some variety tunnels for live on-chain
visibility, decoupled from the play rate and clamped to the node budget (10M `--live-settles 50` →
+3k tx, 0.1% of the node). Note this replaces an earlier rotate-every-match default whose ~438k
lifetime tx was flow-over-60s (snapshot 12k tunnels), not a bug — just the wrong default for
"minimal." You can't have minimal tunnels *and* slow/realistic variety (slow variety re-balloons the
count — poker @1 mps ⇒ ~200k tunnels, over the cap).

## Per-game move model (`m` and mps)

Each game implements `Protocol<State, Move>` in `sui-tunnel-ts/src/protocol/`. **Multi-game**
wrappers pack `N` games into one tunnel (one settlement), carrying balances forward and
resetting between games — they raise effective `m` without raising the on-chain churn.

| Game | `m` (moves/tunnel) | mps limiter | Multi-game? | Role |
|---|---|---|---|---|
| **Chat** (`chat.ts`) | **∞** (O(1) rolling blake2b digest; no settle mid-stream) | JSON + 1 hash + 1 sign | n/a | **carrier** |
| **BombIt** (`bombIt.ts` + `multiGameBombIt.ts`) | ~5400/game × N | 1 sign/tick, deterministic grid | yes | **carrier** |
| **Cross** (`cross.ts` + `multiGameCross.ts`) | ~50–200/race × N | 1 sign/tick, deterministic hazards | yes | **carrier** |
| **Battleship** (`battleship.ts` + `multiGameBattleship.ts`) | ~42/game × N | commit + shoot/reveal + Merkle verify | yes | carrier/variety |
| **TicTacToe** (`ticTacToe.ts` + `multiGameProtocol.ts`) | ~5–9/game × maxGames | 1 sign/move, deterministic bot | yes | variety |
| **Quantum Poker** (`quantumPoker.ts`) | ~8–50/hand × handCap (≤1000) | 9-slot commit-reveal + shuffle | per-handCap | variety |
| **Blackjack** (`blackjack.ts`) | ~10–30/round, multi-round (cap 1000) | **4 signed updates/card** (commit-reveal) | no | **variety (expensive)** |

**mps drivers.** Deterministic-seed games (chat / bombit / cross / ttt — see
[ADR-0017](../decisions/0017-deterministic-seed-vs-commit-reveal.md)) cost **1 sign/move** →
fastest, high `m`. Commit-reveal games (blackjack, poker, battleship) need **2 round-trips per
random value** → lower mps and a smaller effective `m`. On a local channel latency ≈ a
microtask, so mps is CPU-bound, not network-bound.

## Game-mix budget strategy

Two lanes, split by **lifecycle** (not by a shared tx/s budget):

- **Carrier lane — phase-separated, ~zero peak node cost.** Chat + deterministic multi-game
  (bombit / cross) run as **long-lived** tunnels for the whole peak: open in the ramp, hold
  during the peak (node idle), drain after. Node cost = ramp/drain time only (full 300 tps
  each, never simultaneous). This lane carries the **bulk of the 1M**, limited by off-chain
  compute (box count), not the node.
- **Variety lane — optional continuous churn for live on-chain activity.** Blackjack / poker /
  battleship / ttt run either in **waves** (also ~zero peak cost) or as a deliberately
  throttled **continuous churn**, so the explorer shows real settlements *during* the peak.
  Continuous cost = `2·C_v / B`; size `C_v` to a chosen reserve so the node stays well under
  300.

Illustrative for **1M off-chain**, `B=50`, with a ~50-tx/s continuous-settlement reserve for
realism:

| Lane | Games | peak off-chain | node cost @ peak |
|---|---|---|---|
| **Carrier** (phase-sep) | chat held pool + bombit/cross | ~1.0M | **~0** (ramp/drain only) |
| **Variety** (cont. churn) | blackjack / poker / battleship | visible trickle (~tens of k) | **≤ 50 tx/s** (reserve) |
| **Total** | | **~1M+** | **≪ 300 tps** ✓ |

Carrier ramp/drain for `N≈10k` ≈ 0.7 s (B=50) … 33 s (B=1), on open and again on close. The
headline holds at ~zero node cost during the peak; the deliberate variety trickle proves real
settlements are landing live. The probe-measured `B` only moves the ramp time and the size of
the variety reserve — **never the feasibility of 1M.**

## Two-rate honest framing (the headline contract)

Always report **two numbers side by side**, never conflated:

1. **Off-chain tunnelops/s** — the L2 state-channel throughput (the big number). Counted as
   co-signed off-chain frames. This is local crypto, **not** Sui consensus.
2. **Real Sui settlement tx/s + SUI spent** — the L1 anchor. Real opens/s, closes/s, and the
   summed `effects.gasUsed` from actual transactions.

The product already separates these (the global-TPS panel counts only off-chain frames;
Active/Settled Tunnels are separate gauges). **Never relabel off-chain crypto as Sui consensus
TPS** — that is the mistake the "4.95M" claim made, and the credibility of the whole launch
rests on stating both honestly.

## Measured on-chain cost

Real testnet transactions, RGP 1000 MIST, self-play funding path (1 SUI = 1e9 MIST):

- **OPEN** `create_and_fund` — comp 1,000,000 + storage 3,374,400 − rebate 0 =
  **0.004374 SUI** *(measured — testnet 2026-06-25)*. One PTB funds both seats inline →
  **1 tx/tunnel**.
- **CLOSE** `close_cooperative_with_root` — comp 1,130,000 + storage 6,019,200 − rebate
  3,340,656 = **0.003809 SUI** *(measured — testnet 2026-06-25)*. The `Tunnel` is **mutated,
  not deleted**, so ~**0.003374 SUI/tunnel** of storage is a **permanent burn**.
- **SIP-58 settler-pays validated:** the settler `0x8b4f` paid gas via its **address balance**
  (empty `gas_payment.objects`); both players paid **0 SUI** (see
  [ADR-0007](../decisions/0007-settle-authorized-by-settlement-not-token.md),
  [ADR-0009](../decisions/0009-sponsor-create-and-fund-gas.md),
  [ADR-0013](../decisions/0013-address-balance-stake.md)). Now also validated **at scale on a node**
  — the localnet (protocol 127) accepts address-balance gas + stake withdrawals end-to-end; see the
  SIP-58 throughput measurement below.

| | Scenario A — today (no delete) | Scenario B — delete-on-close |
|---|---|---|
| open net | **0.004374 SUI** *(measured)* | same |
| close net | **0.003809 SUI** *(measured)* | ~0.0008 SUI (Tunnel storage rebated on delete) |
| **per-tunnel net** | **0.008183 SUI** | **~0.0052 SUI** |
| of which **permanent** | **0.003374 SUI/tunnel** (sunk) | **~0** (rebated) |
| **1M tunnels** | **~8,200 SUI** (~3,400 sunk) | **~5,200 SUI** (~0 sunk) |
| **10M tunnels** | **~82,000 SUI** (~34,000 sunk) | **~52,000 SUI** (~0 sunk) |

**Tie-out:** the open's Tunnel storage deposit (3,374,400) ≈ the close's rebate (3,340,656) —
the deposit is paid at open and refunded-then-repaid (mutate) at close, locked forever (the
~33k gap is the 1% non-refundable). The storage finding is arithmetically airtight.

**Funding sizing:** `sponsor SUI ≈ per-tunnel-net × tunnels_opened + in-flight float +
headroom`. Gas is paid up-front per tx; in Scenario B the storage rebate returns on close, so
the sponsor needs float to cover the open→close window. **Stake is MTPS** (free, faucet-minted,
[ADR-0010](../decisions/0010-mtps-stake-token.md)) and round-trips on self-funded seats → net
MTPS ≈ 0; the only real spend is **SUI gas + storage**. On testnet this is free faucet SUI;
the per-tx *units* transfer to mainnet, the absolute cost does not.

## Measurement inputs (what is still unmeasured)

The model has exactly **two** missing inputs, plus the off-chain box ceiling:

| Input | Symbol | Source | Status |
|---|---|---|---|
| Sustained accepted **opens/s** | `node_open_rate` | TS localnet probe | **425/s (measured — localnet, finality-bound floor)** |
| Sustained accepted **closes/s** | `node_close_rate` | TS localnet probe | **110/s (measured — localnet, finality-bound floor)** |
| **Opens-per-PTB knee** | `B_open` | TS localnet probe | **255 (measured)**, bound by command/arg |
| **Closes-per-PTB knee** | `B_close` | TS localnet probe | **681 (measured)**, opaque "Internal error" at 682 (1024-command limit beyond) |
| **Off-chain box ceiling** (Rust) | `box_offchain_ceiling` | Rust `fleet-bench` (Daniel) | **~160k moves/s/box (M4, 14-core, MEASURED 2026-06-29)** — most games 135k–169k; AWS c7i.48xlarge ≈ ~13.7× |

The **TS localnet probe** (`tools/loadbench`, reuses the tested `buildOpenAndFundMany` /
`buildCloseWithRootFromSettlement` builders + a gas-sharded signer pool) measures
`node_open_rate`, `node_close_rate`, `B`, and confirms per-tx gas against the testnet numbers
above. (On the stock localnet stack only `sui_tunnel` is published — not `mtps` — so the
localnet probe **stakes SUI** from the gas coin; the testnet/mainnet path stakes MTPS per
[ADR-0010](../decisions/0010-mtps-stake-token.md).) **Measured `B_open` = 255** (localnet,
2026-06-29): N=256 fails on the **command/argument** budget, just below the predicted 256
event-budget cap (4 events/open × 256 = 1024) — both bind around the same N, so **~255 opens/PTB**.
**Measured `B_close` = 681**: a single PTB settles up to 681 tunnels (K=682 fails with an opaque
"Internal error"; the clean 1024-command limit only bites far beyond). Closes pack **~2.7× more per
PTB than opens** — each close is one command emitting ~1 event, vs an open's split-coin + create +
4 events — so the close side is even less node-bound than the open side. Per-open gas **amortizes
with batch size**: ~6.4M MIST at N=1 → ~3.5M at N=32–64 → ~4.0M at N=255, i.e. batching roughly
**halves** per-open gas. (The owned-coin path submits via **owned gas coins**; the SIP-58
address-balance path — measured separately below — submits with empty `gas_payment` and is **not**
Rust-only: the probe builds it in TS on `@mysten/sui` 2.x.)

**Sustained rates (measured, localnet, 0% error).** Batched near the per-PTB knees
(open batch=255, close working-set=512): opens scale to **~790/s** (pool=8, near-linear), closes to
**~630/s** (pool=8). At the smaller default config (open batch=128, close working-set=32) the
figures are ~425/s and ~110/s. Two regimes are visible:
- **Finality-bound floor** at low concurrency — the probe awaits `waitForTransaction` per tx (p50
  ~2.2 s), so throughput ≈ `batch · pool / latency`; raising batch or pool lifts it ~linearly.
- **Node saturation** at high concurrency — the close cell at pool=8 (4096 concurrent batched
  closes) goes sublinear (591→630/s) with latency climbing (p50 4.2 s, p99 6.3 s), so **~630/s is a
  near-real single-node close ceiling**, not just the finality floor.

The authoritative node rates (no per-tx finality wait, SIP-58 gas) still come from Daniel's
real-fullnode run; the localnet figures bracket the floor and the single-node ceiling. Three probe
bugs were fixed to get here: a stale-gas version race under rapid submission (→ rebuild-and-retry),
a created-id↔seat mispairing that aborted batched closes (→ match by on-chain `party_a`), and
1-close-per-tx (→ batch closes per PTB like opens, capped at `CLOSE_BATCH`=512 under the 681 knee).

### SIP-58 address-balance gas — measured end-to-end (localnet, 2026-06-29)

The owned-coin rates above are floored by two artifacts the production fleet won't have: a stale-gas
**version race** (forces rebuild-and-retry) and a **signer-pool cap** (one coin can't back two
in-flight txs). SIP-58 address-balance gas removes both — with empty `gas_payment` + a `ValidDuring`
window, gas is a `FundsWithdrawal` from the settler's **address balance** (no coin object to lock),
so one account fires arbitrary concurrent PTBs and never equivocates. This had been "e2e-deferred (no
live node)"; it is now validated.

**Node support confirmed.** The localnet node (`sui-tools:testnet-v1.74.0`) runs **protocol 127** with
`enable_address_balance_gas_payments`, `enable_accumulators`, `enable_object_funds_withdraw`,
`address_balance_gas_check_rgp_at_signing` all **true** — it accepts address-balance gas.

**Probe** (`tools/loadbench/src/probeSip58.ts`, loadbench bumped to `@mysten/sui` 2.x). Each tx is
built **client-side** with the same 2.x builders the frontend uses in production: the open's stake is
`coin::redeem_funds(tx.withdrawal(...))` from the balance, gas is `setGasPayment([])` +
`setGasOwner(settler)` + `setExpiration({ValidDuring})`. The **settler is the sole sender / gas owner
/ stake funder** for every open and close; the bots stay genuine parties (their keys are in each
tunnel and co-sign the close settlement off-chain) — only on-chain submission is settler-driven,
which is exactly the production sponsor model. No backend HTTP in the path — the probe assembles and
submits the same address-balance tx the backend settler builds in Rust.

**Measured (single settler account, 0 errors, localnet).** Matched batches — 128 opens/PTB and
128 closes/PTB, 16 PTBs each:

| config | opens/s | closes/s | equivocations |
|---|---|---|---|
| SIP-58, one settler, K=16 | **3,967** | **2,146** | **0** |
| SIP-58, one settler, K=4 | 1,972 | 1,250 | 0 |
| owned-coin baseline (pool=8) | 425 | 110 | races (needs a pool) |

≈ **9× opens, ~19× closes** vs owned-coin — from **one** account, no pool.

**Why opens/s > closes/s even at equal batch** — and why this does *not* contradict the
B_close=681 > B_open=255 capacity result: they are different axes.
- *PTB capacity* (B): a close PTB fits ~2.7× more items because closes hit the **1024-command**
  limit (~1 event each) while opens hit the **1024-event** budget at 256 (4 events/open). More items
  per PTB ⇒ **fewer transactions** settle the same N ⇒ less node tx-count load (good for the 300-tps
  budget). This is real and unchanged.
- *Per-second throughput*: a close is **compute-heavier per item** —
  `close_cooperative_with_root` verifies **two ed25519 signatures in Move** (both seats) and moves
  balances, while an open does storage writes but **no in-Move sig check**. So a 128-close PTB
  executes slower (~0.93 s) than a 128-open PTB (~0.50 s). Throughput = items/PTB ÷ PTB-latency ×
  parallelism, and PTB-latency grows with items — so packing more per PTB does **not** turn into more
  per second. (Over-sizing the close batch hurts: close-batch=512 collapses 2,000 closes to **4**
  PTBs and drops to ~1,500/s; matching it to the open batch — 16 PTBs — recovers ~2,100/s.)
  Controls isolate the two effects: throttling **opens** to K=4 drops them 3,967 → **1,972/s** (most
  of the open lead was parallelism — 16 PTBs vs the fat-close's 4), and at matched batch *and* K=4
  opens still lead closes 1,972 vs 1,250 — a **~1.6× per-item residual** = the in-Move sig-verify cost.

Concurrency sweep (n=1024, opens batch=128, closes batch=512), **zero equivocation at every K incl.
64** — opens are the clean scaling story (closes flatten early: at batch=512 there are only 2 close
PTBs, so K past 2 adds nothing):

| K (in-flight PTBs) | 1 | 8 | 32 | 64 |
|---|---|---|---|---|
| opens/s | 605 | 2,645 | 2,945 | 2,884 |

Opens scale ~5× from K=1→8 then **plateau** (~2,900) — the localnet **single-node execution ceiling**,
not coin contention or the SIP-58 mechanism. The headline is the **0 equivocations** column:
address-balance gas lets one settler saturate the node with concurrent PTBs and never equivocate —
the unbuilt "SIP-58 × batching" gap, now demonstrated in TS. Absolute rates stay localnet-bound; the
privileged multi-core node and Daniel's Rust anchor remain for the production ceiling.

How they plug in:

```
ramp / drain     = N / node_open_rate     (≈ N/(300·B) at the cap)
continuous-churn = node_close_rate · m    (≤ 150·B·m bound for any churned lane)
boxes for 1M     = 1,000,000 / box_offchain_ceiling
```

## Constraints & cross-team asks

- **George Digkas (upstream-authoritative framework) — delete-on-close.** Add a Dopamint
  extension `close_cooperative_and_delete<T>` consuming `Tunnel<T>` **by value** + `id.delete()`
  (Sui allows deleting shared objects), mirroring the `create_and_fund` extension pattern —
  **do not edit the upstream close gratuitously.** Halves per-tunnel cost and removes the
  permanent storage burn (Scenario B). **Phase-2 gate; short ADR.** Phase 1 only *measures* the
  non-rebate to confirm the finding.
- **PE — the privileged Mysten node.** Clarify whether **"300 tps" is tx-count** (batching is
  a big win) **or execution-weighted** (a 50-open fat PTB ≈ 50 tx of work) — the
  optimistic-vs-pessimistic fork above. Provide the per-tx compute/object limits and run a real
  `executeTransactionBlock` load test on the node.
- **SIP-58 settler-pays** (ADR-0007/0009/0013) — validated on testnet; the settler pays gas
  from its address balance, players pay 0. Keep the settler funded; the sponsor allowlist +
  spend cap stay load-bearing for any public run.
- **Kostas — no self-play, "not fake."** Bots play as **genuine two parties** (two seats
  co-signing over `DistributedTunnel` + local channel) on our servers — never
  `OffchainTunnel.selfPlay`. Confirm **1M vs 10M** target, the mainnet demo with real DOPAMINT
  stake + real SUI sponsor, and approve delete-on-close + the SUI budget (~8,200 SUI/1M without
  delete, ~5,200 with).
- **Daniel Lam — Rust on-chain anchor** ([ADR-0020](../decisions/0020-bot-fleet-topology-shared-core.md)).
  Swap numbers (his public-fullnode submission ceiling vs the TS localnet probe); confirm the
  anchor uses `create_and_fund` (1 tx/tunnel, not create+share+2×deposit), batches opens
  (≤ event budget) and staggers closes, submits concurrently, uses `close_cooperative_with_root`,
  keeps wire parity green, and reports the two rates separately. Supply the Rust
  `box_offchain_ceiling` and confirm the headline runs on the **local channel**, not the relay.
  The **SIP-58 × batching** combination he was going to anchor in Rust is now **measured in TS**
  (`probeSip58.ts`, 3.9k opens/s · 1.5k closes/s · 0 equivocation from one settler) — use it as the
  reference shape; the Rust anchor's job is the privileged-node ceiling, not re-proving the mechanism.
