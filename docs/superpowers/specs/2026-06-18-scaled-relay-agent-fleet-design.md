# Scaled-relay agent fleet — real-app agents that mimic users at scale

- **Date**: 2026-06-18
- **Status**: Draft (design)
- **Owner**: TBD
- **Refs**: `docs/DEMO-STRATEGY.md` (§1, §5–§9); ADR-0001 (baseline),
  ADR-0002 (FE↔BE contract), ADR-0004 (PvP experience lane), ADR-0005
  (Redis-backed HA control plane); spec `2026-06-17-multiplayer-pvp-design.md`.

## Goal

Fill the arena with **agents that are indistinguishable from real users** and
drive a large, honest throughput number from their play. Every agent runs the
**real published web app** in a real browser, connects a wallet, queues, and
plays — over the **same relay a human uses**. A real human can drop into any
match at any time, because to the relay an agent and a human are the same peer.

The throughput claim is **off-chain effective TPS** per `DEMO-STRATEGY.md` §1:
each co-signed, mutually-verified relayed message is a real, settleable
transaction, anchored by a real on-chain open/settle and archived to Walrus.
The headline target is **≈1M effective TPS**; the *published* figure is whatever
the scaled relay **sustains under load test** (§ Numbers — TBD).

## Why this shape (the decisions behind it)

These were settled during brainstorming and are load-bearing — record them so
they are not silently reopened:

1. **Relay-routed, not in-process.** In-process self-play co-signing reaches 1M
   trivially but has **no open seat for a human** — a person can only join
   through a relay seat. "Real humans drop in any time" is a hard requirement,
   so every move flows over the relay. This caps per-tunnel rate at the network
   round-trip and makes the relay the throughput bottleneck — accepted.
2. **Agents run the real app, not a headless bot.** A headless Node client over
   raw WS would test a *synthetic* path and undercut the "real user traffic"
   claim. Agents load the same page, same origin, same `mpClient` /
   `DistributedTunnel` / wallet flow as a human — only the driver differs.
3. **Full-render agent mode; no headless/no-render variant up front.** The
   auto-play logic lives in React hooks (`useBotGame`, `usePvpTicTacToe`,
   `useBlackjackBot`) that only run inside a render. Full-render reuses them
   untouched. A render-suppression "no-render" mode is a **measured fallback**
   (§10), built only if the load test shows full-render can't hit the needed
   agents-per-instance within budget.
4. **The big number is honest because of Walrus, not the relay.** A skeptic
   cannot audit the relay's internal stream (§5 — provenance is unverifiable);
   the checkable artifacts are the on-chain open/settle and the Walrus-archived
   transcript. Those make each transaction real and durable.
5. **Humans never wait — agent-vs-agent yields to a reserve floor, not the
   reverse.** Agents pairing each other (across all queues) is the throughput
   engine, not a bug; the constraint is that a human — or a batch-open request
   for N games — must always find free *local* agents instantly. So agent-fill is
   admission-gated to leave a reserve floor of idle agents per instance,
   maintained **at the pairing decision** — never a runtime scan (§6.1).
6. **Concurrent tunnel pool per agent — the efficiency multiplier.** One agent
   (one wallet, one browser context, one WS) runs **M concurrent tunnel slots**
   across games, refilling each slot the instant it settles, so the agent never
   idles. The relay stays the throughput ceiling (concurrency doesn't raise it),
   but you **reach** it with **M× fewer browser contexts/hosts (§5)** and **M×
   fewer wallets** (less faucet/provisioning/gas-headroom, §3). Honest caveat:
   total **staked + storage** SUI scales with concurrent *tunnel* count, so M
   shrinks wallet count and gas overhead, **not** the per-tunnel stake/storage.
   Cost: a wallet cannot fire concurrent on-chain txs on one gas coin (Sui
   *equivocation* locks the coin), so each wallet's open/deposit/settle run
   through a **per-wallet serial queue**; off-chain moves stay fully concurrent
   (§2). M is a measured knob (§Numbers#2).

## In scope

1. **Agent mode** in the web app: a programmatic wallet (popup-free), auto-queue,
   auto-play via the existing per-game hooks, settle, and re-queue in a loop.
2. **Wallet provisioning + treasury funding fan-out** for thousands of agent
   wallets (gas + stake) — the binding on-chain constraint.
3. **Scaled relay**: horizontal `tunnel-manager` matchmaking/relay (ADR-0005
   Redis HA) with **sticky match→shard routing** and **failover**.
4. **Fleet runner**: launches/supervises N agent contexts (Playwright) across
   AWS hosts; ramp up/down; restart on crash.
5. **Telemetry**: per-shard / per-agent message counting, summed to the live
   panel; one defined TPS metric.
6. **Walrus archival** of transcripts (reuses the existing settle path).
7. **Human drop-in**: matchmaker always leaves seats joinable by real players,
   via a per-instance **human-priority reserve pool** (§6.1) — the mechanism that
   also serves a batch-open `reserve N`.

## Out of scope (deferred)

In-process / self-play throughput lane; a no-render agent mode (measured
fallback only, §10); real-stakes human-vs-agent economics and anti-farming (any
agent stake is sponsored/exhibition — see ADR-0004 out-of-scope); the on-chain
referee for griefing-proof finalization; distinct-IP / multi-region "users from
everywhere" provenance (single-region co-location is assumed for RTT, §4); games
without a playable+bottable UI (§ Game coverage); the spectacle desktop's final
visual polish.

## Phasing (build order)

The body below describes the full HA / 10k end state, but it is **not** built all
at once:

- **P1 — prove the real-scenario claim cheaply.** Agent mode + programmatic
  wallet + the existing per-game hook, against **one** relay instance and a
  **small co-located fleet**, plus the §Numbers load test. Success = one agent
  context completes open→play→settle→Walrus through the real app with no human
  and no popup, a human drops in, and we have **measured** the single-relay and
  per-host numbers. This validates the entire premise before any scale spend.
- **P2 — scale out, gated on P1's measurements.** HA relay (local matching,
  failover), treasury funding fan-out, and the full fleet runner — sized by the
  numbers P1 produced, not by the estimates in this spec.

## Architecture

```
   Everything an agent does is the real app over the real relay. A human is the
   same peer; the relay cannot tell them apart, which is the point.

   ┌── Agent fleet (AWS) ──────────────┐   ┌── Real humans (anywhere) ─────────┐
   │ host × (tunnels ÷ M ÷ density)    │   │ browser → published page          │
   │   ctx × M concurrent tunnels      │   │ dapp-kit wallet · auto/ manual    │
   │   = real app in AGENT MODE        │   │  (M & density measured, §Num#2;    │
   │   (programmatic wallet, auto-play)│   │   no-render §10 raises density)    │
   └───────────────▲───────────────────┘   └──────────────▲────────────────────┘
                   │  WS: connect · queue.join · relay(MOVE/ACK) · settle
   ┌───────────────┴──────────── Scaled relay (tunnel-manager, ADR-0005) ──────┐
   │ LB → ~10–30 instances · Redis: presence/queues/match→shard routing        │
   │ sticky: both seats of a match on ONE instance (no per-move cross-shard hop)│
   │ watchtower (latest co-signed update) · settle+Walrus · event indexer      │
   │ NEVER signs a move · NEVER a counterparty                                  │
   └───────────────▲───────────────────────────────────────▲───────────────────┘
                   │ existing PTB builders + event reads     │ POST /settle
   ┌───────────────┴──────── Sui + tunnel.move (unchanged) ──┴───────────────────┐
   │ create_and_share · gated deposit_party_a/b · close_cooperative_with_root     │
   └──────────────────────────────────────────────────────────────────────────────┘
                                   │ transcript + root
                              ┌────┴─────┐
                              │  Walrus  │  proof each off-chain tx is real & durable
                              └──────────┘
```

## 1. Agent mode (in the web app) — one game-agnostic engine

A single param — bare `?agent` — turns the real app into a self-driving agent.
There is **no game selection**: the agent rotates through **every** tunnel game
to maximize concurrent tunnels. The agent is **game-agnostic** — one engine plays
**all five tunnel games**, because every `Protocol` exposes the same
`randomMove(state, by, rng)` and `createBehaviorProtocol(game)` maps a game id →
the right `Protocol` (verified: `agents/behaviors.ts` + all of
`protocol/*.ts`). The agent runs a **pool of M concurrent tunnel slots** (one WS,
one wallet — decision #6); each slot loops independently, so the agent never
idles:

- **Connect** a programmatic wallet (§2) — no popup. **One WS multiplexes all M
  slots** (the relay routes by `matchId`; this is the main engine change vs the
  single-match `MpClient`).
- **Pick a game** for the free slot and `MpClient.quickMatch(gameId)`. On
  `queue.timeout` (no partner), try the next game — self-balances across queues.
- **Open/fund** via the existing gated path. A wallet runs M concurrent slots, so
  its on-chain txs (open / deposit / settle) go through a **per-wallet serial
  queue** to avoid gas-coin equivocation (§2); the M slots' off-chain moves stay
  fully concurrent.
- **Play** generically: `DistributedTunnel(createBehaviorProtocol(game), …)`,
  each turn `proto.randomMove(state, party, rng)` → `propose`. One engine drives
  ttt, blackjack, payments, chat, poker.
- **Settle** (co-signed close + Walrus), then the slot **immediately refills**
  with a new game. Pace = "auto" (machine speed, bounded by the relay RTT).

This is `pvpTttBot.mjs` generalized over the protocol. It is additive: a human
session is the same app with `agent` off. No new wire format, no new PTB
builders. The generic engine drives the protocol/relay/chain directly and does
**not** mount a per-game React board (see Game coverage for the render split).

## 2. Programmatic wallet (popup-free)

The app currently mounts dapp-kit `WalletProvider autoConnect` (real extensions).
Agent mode registers an **in-page programmatic wallet** via the Wallet Standard
(`registerWallet`) backed by a generated/injected `Ed25519Keypair`, then
auto-connects it. It signs the wallet transactions in the happy path — the gated
deposit (and seat-A's cooperative close) — without UI. With **M concurrent
tunnels** per wallet (decision #6) that is M deposits/closes, so they run through
a **per-wallet serial queue**: one in-flight tx per gas coin, because Sui
*equivocation* locks an owned object (the gas coin) used by two conflicting txs.
Off-chain move-signing uses a **per-slot ephemeral key**, is separate, popup-free
(ADR-0004 §1), and fully concurrent across slots. The injected wallet key is
provided per context by the fleet runner from the funded pool (§3).

> Identity model is unchanged from ADR-0004 §1: `party.address` = the agent's
> real funded wallet (pays deposit, receives payout); `party.public_key` =
> ephemeral move signer. Do **not** derive the address from the ephemeral key.

## 3. Wallet provisioning + treasury funding fan-out (binding constraint)

Each agent needs its **own** funded wallet — gas + stake — because seats are
funded by the **gated** path (`deposit_party_a/b`, `sender == party.address`),
**not** `create_and_fund` (that is the single-sender/self-play path and is not
used here). The testnet faucet will not directly fund thousands of wallets, so:

- Generate N keypairs (deterministic from a seed for reproducible runs).
- A **treasury** wallet (faucet-topped) fans out gas+stake to all N via batched
  PTB coin-splits (bounded number of split txns, each crediting many addresses).
- **Health-check before queue**: an agent only joins matchmaking once its wallet
  shows the required gas+stake balance. An underfunded fill agent that can't
  deposit is a broken opponent on camera — this check is mandatory.
- **Reclaim**: sweep residual balances back to treasury after the event.

Stakes are **sponsored/exhibition** (small, treasury-funded). Real-stakes
human-vs-agent economics + anti-farming are out of scope (ADR-0004).

> **Long-pole risk — testnet SUI supply.** Concurrency (decision #6) cuts the
> **wallet count** to concurrent-tunnels ÷ M (≈500 wallets at 10k tunnels, M≈20)
> — shrinking faucet calls, provisioning, and gas-headroom. But the **staked +
> storage** SUI is **per concurrent tunnel** and M does *not* reduce it: 10k
> concurrent tunnels lock ~10k × (stake + storage) regardless of how few wallets
> hold them. Faucets are rate/amount-limited, so **acquiring that SUI may be the
> actual critical path, ahead of any code.** Mitigations (decide early): keep
> stakes tiny and tunnels long-lived (fewer lifecycles; storage is rebated on
> close); pre-provision and recycle a wallet pool; drip-fill the treasury over
> days; or fall back to mainnet (bounded-by-tunnel-count cost). This gates fleet
> size as hard as the relay does.

> Read note: this is the *only* unbounded-cost axis. On-chain txns scale with
> **tunnel count** (~4 per tunnel: create + 2 deposits + settle), not with TPS.
> Keep tunnel lifetimes long (many moves per tunnel) so the chain op-rate and
> faucet stay within testnet limits (§9).

## 4. Scaled relay (tunnel-manager, ADR-0005)

The relay is now the throughput bottleneck and a **single point of failure** —
both are designed for explicitly:

- **Horizontal**: ~10–30 instances behind the LB; presence, queues, and match
  records in Redis (ADR-0005).
- **Local matching (both seats co-located by construction)**: avoid the hard
  "pin two independent WS connections to instance #7 behind an LB" problem
  entirely. Because agents are **fungible** (AI-vs-AI), each instance **matches
  among its own locally-connected waiters** — so both seats of an agent match are
  already on one instance and every move is forwarded **in-process**, zero
  cross-shard hop. A human lands on some instance via the LB and matches a
  **local** agent — guaranteed available by the per-instance reserve floor (§6.1).
  The **Redis global queue is the fallback**, not the hot path — used only for
  challenge-by-wallet or when an instance's local pool is empty. (A cross-shard
  Redis hop *per move* is forbidden.)
- **Co-location**: the agent fleet runs in the **same region/AZ** as the relay so
  the round-trip is sub-millisecond — required to reach ~100+ moves/sec/tunnel.
  This trades away "agents from everywhere"; real humans connect from anywhere
  and simply play at their own (slower) rate — fine, they are a small cohort.
- **Failover/HA**: instance loss must not take down the arena; matches re-home
  via Redis. The watchtower (latest co-signed update per match) already supports
  re-sync of a dropped socket (ADR-0004 §3).

Relay protocol is unchanged (ADR-0004 §4): `connect`/`challenge`,
`queue.join`/`match.found`, opaque `relay` MOVE/ACK frames, `tunnel.opened`,
`settle`. The relay **never** parses a move and **never** signs.

## 5. Fleet runner (AWS)

A supervisor that:

- Launches **Playwright** browser hosts. The throughput unit is concurrent
  **tunnels**; one context runs **M** of them (decision #6), so contexts =
  concurrent-tunnels ÷ M. With M≈20 and ~50–150 contexts/host (both measured,
  §Numbers#2), **10k concurrent tunnels ≈ 500 contexts ≈ a handful of hosts** —
  versus ~100–150 hosts at M=1. (No-render §10 raises density further, only if
  measured necessary.) Each **browser context** is isolated (WS + wallet +
  storage, shared engine), pointed at the published page with bare `?agent` and
  an injected funded key (§2).
- **Ramps** the population up to target and down at end; **restarts** crashed
  contexts; re-queues finished agents.
- Tags two cohorts: a large **volume cohort** (the headcount/number) and a small
  **showcase cohort** (fully visible, for recordings) — same app, same path.

**Density unit + two browser gotchas (decide in P1, measure in §Numbers#2):**
- **One browser *context* per agent**, not multiple agents sharing tabs of one
  context — tabs in the same context share origin `localStorage`/`IndexedDB`, so
  two agents would collide on dapp-kit wallet state and the app's stored keys.
  Many contexts per process is the density win.
- **Disable background-tab throttling** or packed agents idle: Chrome throttles
  non-foreground timers to ~1/sec. Launch Chromium with
  `--disable-background-timer-throttling --disable-renderer-backgrounding
  --disable-backgrounding-occluded-windows` (Playwright `args`); headless also
  sidesteps it.

## 6. Human drop-in (first-class)

The matchmaker must **always leave seats joinable** by real players: a human in
the queue is paired ahead of / alongside agents (the relay cannot tell them
apart). This is the requirement that forced relay-routing (§ Why, #1) — it is a
core success criterion, not a nice-to-have. The concrete mechanism that delivers
it is the **human-priority reserve pool** (§6.1).

### 6.1 Human-priority reserve pool (the never-wait guarantee)

"Always leave seats joinable" is made concrete by a **reserved-capacity pool** —
the standard pattern for priority access to a shared fleet (min-idle in a
connection pool, warm reserve in a worker pool). Agents pairing **each other is
the default and desired** use of idle capacity — it is the throughput engine — so
the policy does not stop it; it **caps** it so a human always finds a free *local*
agent.

**Unit = free seats, not whole agents.** With the concurrent pool (decision #6)
the reservable resource is a **free tunnel slot waiting in a queue**, and one
agent contributes several — so the reserve is *capacity*, not idle processes, and
is far cheaper to hold (an agent giving a human a seat just plays the human in one
of its M slots).

**Invariant (maintained at the pairing decision, never by a scan):** every relay
instance keeps a reserve floor of **K free local seats** per human-joinable game.
This is one admission rule on the existing atomic pairing step (ADR-0005 — the
same Lua script that already guarantees "two instances never pair the same
waiter"), keyed on a per-instance free-seat counter:

- **Human request** (a drop-in, or a batch-open `reserve N`) pairs against free
  seats **down to zero** — absolute priority.
- **Agent-vs-agent fill** is admitted **only while `local_free > K`** — it may
  consume seats only *above* the floor, and can never cross it.

Because matching is **local** (§4), the reserve is **per-instance**: a free seat
on another instance cannot serve this human without a forbidden cross-shard move
hop. And because agents rotate across all game queues (§1) while a human plays a
**specific** `gameId`, the floor is keyed **per (instance, human-joinable game)**:
the matchmaker must hold K seats queued on — or rotating on `queue.timeout` to —
the human's game on that instance. Agents still rotate
**uncoordinated** (§1); the **matchmaker** — not the agent — biases *pairing*
toward human-joinable queues to hold the floor.

Two control loops keep the floor intact under load:
- **Backpressure:** when `local_free` for a human-joinable game falls below a
  low-water mark, **pause new agent-fill** that would drain it and let slots
  finishing their loops replenish it (they return continuously, so refill is fast).
- **Autoscale / rebalance:** a sustained low floor signals the fleet runner (§5)
  to ramp more contexts and/or **rebalance agents across instances** so *every*
  instance holds ≥K — the floor is meaningless if satisfied only in aggregate.

**Policy of record — dynamic floor + a small dedicated reserve (hybrid).** The
dynamic floor (above) is the mechanism; a small **dedicated** standby cohort that
never pairs AI-vs-AI guarantees instant availability through a cold start or a
burst before the dynamic loop catches up. Rejected as *sole* mechanisms: a pure
dynamic floor (no cold-start guarantee) and a pure dedicated cohort (simple, but
those agents produce zero TPS). For **single drop-in**, humans are a small, slow
cohort (ARCHITECTURE §Throughput), so the reserve costs a rounding error of the
headline number. **Batch-open changes that** — see the cost trade in the callout.

**P2 sequencing (avoid over-building):** ship the **dedicated standby cohort
first** — it alone covers a demo's handful of live humans and is a fraction of the
code/test surface. Add the **dynamic floor + backpressure + rebalance only if**
humans grow numerous enough that idle dedicated agents cost meaningful TPS. Do
not build the full dynamic machinery for the first event.

> **Batch-open interaction.** A human launching N games at once consumes **N
> reserve slots atomically** from *their* instance's floor. This is a **real cost,
> not free**: either hold **K ≥ peak(concurrent humans × max-N)** idle per instance
> — non-trivial once batch-open is actually used (the drop-in "rounding error" does
> **not** extend to large batches) — **or** cap N and **partial-fill** (open the
> M ≤ N available now, queue the remainder a beat later, accepting the human waits
> for the tail of a big batch). Pick the trade explicitly per event size. The
> reserve-N grab and the floor check are the same atomic op, so two humans never
> race for the same agent.
>
> **What "many games" means today.** A human matches an agent only on a game with
> a **human PvP UI** (§ Game coverage — tic-tac-toe today; blackjack if/when
> wired). So a batch today is **N simultaneous tic-tac-toe matches**, not N
> *different* games; the multi-variety version the user pictured is gated on
> building those PvP UIs, not on this matchmaking change.
>
> Batch-open's human-side flow (one gated-deposit PTB over N pre-shared tunnels,
> then settle) is a **separate feature spec**; this section defines only its
> matchmaking contract with the fleet.

## 7. Telemetry (edge-aggregate, sum-at-center)

Per `DEMO-STRATEGY.md` §7, nothing counts a million events centrally:

- Each **relay shard** (or each agent) maintains its own message counter and
  reports **periodic deltas**; a central aggregator **sums a handful of counters**
  into the live TPS / active-tunnel panel (existing ADR-0002 heartbeat shape +
  the SSE fan-out the panels already consume).
- **Metric definition (decide once, surface it):** the demo counts **each
  relayed message** as one transaction, per the chosen "each message = TPS"
  rule. Note this is ~2× the count of **confirmed state transitions** (a
  transition = MOVE + ACK). The more conservative, §1-aligned figure is
  per-confirmed-transition. **Report both**: headline = messages/sec; footnote =
  confirmed transitions/sec. Do not silently pick the bigger one without saying so.

## 8. Walrus archival (the integrity proof)

Reuses `POST /v1/sessions/{id}/settle` + `close_cooperative_with_root`
unchanged: terminal state → both ephemeral keys co-sign the settlement → backend
submits the close and **archives the transcript to Walrus, root anchored
on-chain**. This is what makes "off-chain txns count": each tunnel's full signed
move history is durable and verifiable, not just a live counter. Storage dial:
root-only vs full transcript, sampled (§8 of DEMO-STRATEGY).

## 9. Read / write model

- **Moves (off-chain)** — unbounded, append-only per tunnel; written hot
  (~100/sec/tunnel) and forwarded by the relay; **never centrally persisted**.
  Counted as deltas at the edge (§7); archived per tunnel to Walrus (§8).
- **On-chain txns** — bounded, ~4 per tunnel; scale with tunnel count, gated by
  testnet RPC + faucet. Long-lived tunnels keep this rate low. Per wallet
  (decision #6) they run through a **serial queue** — one in-flight tx per gas
  coin — so M concurrent slots never equivocate on the wallet's coins.
- **Reads** — the panel reads one aggregate snapshot (cached SSE fan-out, scales
  with audience); explorer + Walrus are external reads of real artifacts.
- **Idle pool + reserve floor (§6.1)** — per-instance, bounded by fleet size;
  written hot at every match end (agent re-queues) and every pairing
  (reserve/grab). The "K free agents" invariant is held **at the pairing decision**
  via one atomic admission rule, not by scanning the pool — the same
  write-time-maintained-counter discipline as the TPS figure.

No runtime aggregate (COUNT/SUM) over a growing store anywhere on the live path;
the TPS figure is a maintained counter.

## 10. No-render agent mode (measured fallback only)

If the load test (§ Numbers) shows full-render can't reach the needed
agents-per-instance within AWS budget, add a render-suppression branch: agent
windows return `null`/placeholder so the hooks keep ticking but the board isn't
painted. Same origin, same wallet, same relay path — only pixels are skipped.
**Not built unless measured to be necessary.**

## Numbers — TBD (load-test first; the make-or-break)

Per `DEMO-STRATEGY.md` (Pre-livestream) — measure before committing fleet size
or the headline:

1. **One relay instance**: sustained frame-forwards/sec and p99 latency. This
   sizes the relay fleet (8 vs 80 instances) and decides whether ≈1M is reachable.
2. **One Playwright host**: **M (concurrent tunnels per context)** and
   contexts/host at full-render before the per-tunnel move rate degrades —
   together they size the browser fleet (contexts = tunnels ÷ M) and trigger §10
   if needed.
3. **Per-tunnel move rate** at the co-located RTT, per game protocol.
4. **On-chain**: gas/open, gas/settle, faucet throughput → max safe tunnel count.
5. **Sustained aggregate** + autoscaling under a dry run; publish the measured
   sustained figure as the headline (target ≈1M, do not pre-promise it).

**Kill-criterion / fallback (decide the threshold BEFORE measuring).** Everything
hinges on #1. Pick a threshold `R_min` frames/sec/instance such that the relay
fleet needed for the target stays within budget (e.g. if a tuned instance does
< ~50k forwards/sec, 1M needs >80 instances → out of budget). If the measured
rate is below `R_min`, the pre-agreed response is **not** a debate — it is, in
order: (a) publish a **smaller honest headline** (whatever the affordable fleet
sustains); (b) spend for **more instances** only if within budget; (c) revisit
the relay (batching, binary frames) before any scale spend. P1 must end with this
number compared against `R_min`, and the chosen branch recorded here.

## Honesty / what we can truthfully claim

- ✅ "Real, mutually-signed, settleable transactions, every one over our live
  relay, the same path a human plays — archived to Walrus, anchored on-chain."
- ✅ "Real humans played alongside the agents on the same arena."
- ⚠️ Headline number = **measured sustained**, not a pre-announced 1M.
- ⚠️ Per-message vs per-transition counting stated openly (§7).
- ❌ Do **not** claim agents are unrelated humans (shared treasury is a funding-
  graph tell) or that provenance is skeptic-proof (it is not, §5); the checkable
  realness is on-chain + Walrus.

## Game coverage

The generic engine (§1) plays **all five tunnel games** —
**tic-tac-toe, blackjack, payments, chat, quantum poker** — with no per-game
code, because each `Protocol` supplies `randomMove`. So the **volume fleet
covers every game** out of the box — it rotates all of them, no selection.

Two caveats, not blockers:
- **Render split.** Only **tic-tac-toe** and **blackjack** have board UIs
  (`useBotGame`/`useBlackjackBot`). The volume fleet shows a status UI, not a
  board; the **recordable showcase cohort** that paints a board is therefore
  limited to those two. Adding a board UI for the others is optional polish.
- **Human-joinable games.** A human can match an agent only in a game that has a
  human PvP UI (today: tic-tac-toe; blackjack PvP if/when wired). The other
  three run agent-vs-agent (still real, still over the relay) until a human UI
  exists. The `gameId` an agent queues on **must equal** the one the human UI
  queues, so humans and agents share a queue.

The non-tunnel "house" games (coinFlip, dice, slots) are **not** in scope — they
are not 2-party tunnel games and have no `Protocol`. Do not count them toward
"10 games."

## Testing

- **Agent mode (unit/integration)**: with `?agent` set, a context auto-connects a
  programmatic wallet, queues, plays a full match via the existing hook, and
  settles — no human input, no popup. The programmatic wallet signs exactly the
  one deposit tx.
- **Funding**: treasury fan-out funds N wallets; an underfunded agent is **held
  out of the queue** by the health-check (never presents a broken opponent).
- **Relay scaling (backend)**: both seats of a match land on one shard; a move is
  never round-tripped cross-shard; instance loss re-homes a match without
  dropping it; the relay forwards opaque frames and never parses them.
- **Human drop-in (e2e)**: a real browser session is matched (with priority) into
  the agent pool and completes a real-stakes-sponsored match end-to-end.
- **Concurrency / no-equivocation**: M slots on one WS each open→play→settle
  independently; **assert the per-wallet serial queue never has two in-flight
  on-chain txs** (gas-coin equivocation would lock the coin until epoch end); one
  slot's failure does not kill the others.
- **Load test**: the five § Numbers measurements on the deployed dev stack.

## Success criteria

1. An agent context, given only a funded key and bare `?agent`, completes
   open→play→settle→Walrus **through the real app and the relay**, with **no**
   human input and **no** wallet popup; payout lands in its own wallet.
2. The fleet runner sustains a target population of such contexts on AWS (each
   context running **M concurrent tunnel slots** over one WS), with ramp +
   crash-restart, all traffic over the **sticky-routed, HA** relay.
3. A **real human** drops into the live pool at any time and plays an agent
   end-to-end — indistinguishable to the relay.
4. The live panel shows an aggregate TPS summed from edge/shard counters, with
   the metric (messages vs transitions) stated; the **published headline is the
   load-test-measured sustained figure**.
5. Every transaction is a real co-signed update, anchored by a real on-chain
   open/settle and archived to Walrus. **No new Move code or PTB builders.**
6. Relay-instance loss does not take down the arena (HA/failover verified).
7. **A human never waits, never starved by agent throughput.** Under sustained
   agent-vs-agent load, a drop-in human — or a batch-open `reserve N` — is paired
   from the per-instance reserve floor instantly; agent-fill yields to the floor,
   and the floor is restored by backpressure/rebalance before the next human
   (§6.1).
