# 0027 — Serving-fleet topology: WS-client for the demo, co-located game-server at scale

- **Status**: Proposed
- **Date**: 2026-06-29
- **Refs**: realizes the serving-fleet seam of [0020](0020-bot-fleet-topology-shared-core.md);
  funds the arena flow of [0026](0026-arena-enter-one-sig-genuine-two-party.md); relies on the
  co-location affinity of [0011](0011-local-first-pairing.md).

## Context

ADR-0020 fixed that both fleets drive one shared `tunnel-harness` core, differing only in seam
implementations — and named the serving fleet's transport seam "network socket." It did **not**
fix *where the serving bot runs relative to the relay*. With ADR-0026's "one popup, all 7 games
live" arena, a 5000-CCU worst case is **5000 × 7 = 35,000 concurrent genuine games**, which forces
the question now.

The relay exists to connect two *remote* parties (two browsers). A fleet bot is **our own
server-side infrastructure**, not a remote party. Two ways to wire it:

- **Separate WS-client service** (built today): the bot is a relay client. Connections =
  5k users + 35k bots = **40k WS**, and every move is relayed twice (user→relay→bot,
  bot→relay→user).
- **Co-located in-process**: only users hold WS (**5k**); the bot is a local task the relay routes
  to through a channel — one WS leg per move, the bot turn in-process.

The latency difference is **noise** (the relay↔bot hop is sub-ms same-AZ; the user↔relay RTT and
on-chain open dominate, per ADR-0001's cost model) and is **invisible to the user**. The real
difference is **capacity**: co-location halves the relay's connection count and per-move fanout —
which is what makes 5000 CCU affordable, not faster.

## Decision

**The serving fleet evolves WS-client → co-located, with the `FrameTransport` seam as the swap
point. Pick by load, not by principle.**

- **Demo / hundreds of CCU — WS-client (as built):** the bot is a standalone service connecting
  over WS (`WsRelayTransport`, `/v1/mp` + `/v1/fleet`), run on a single box against the *deployed*
  relay. Do **not** build standalone-fleet ECS infra or harden `/v1/fleet` for scale — it is the
  demo/dev harness, and the relay just needs a modest autoscale (2 → ~6–8 tasks).
- **5000 CCU — co-located game-server tier:** bots run **in-process on the relay instances**,
  registering a *virtual connection* with the bus (an in-process channel, not a WS socket), so the
  relay routes user↔bot frames in-process. Only the transport seam swaps (`WsRelayTransport` → a
  bus-channel transport); `play_match`, the strategy, the `MatchAnchor`/`SuiAnchor`, `MatchChannel`,
  the `BotPool` logic, and the whole FE/backend arena contract (`/v1/arena/*`, `enterArena`,
  seat-A batcher) all carry over unchanged. Co-location pairs with ADR-0011 affinity (a user's bot
  is always local → no cross-instance `SPUBLISH` for bot games), native ed25519, and a dedicated
  worker pool so bot crypto can't starve relay IO.

The **swap trigger** is when projected concurrent users push the relay past a modest autoscaled WS
tier (bot-side sockets start dominating) — a planned milestone, not a scramble.

## Consequences

- **Low-regret path.** The seam (ADR-0020) means the WS-client → co-located change discards only a
  thin layer — `WsRelayTransport`/`relay_client`, the `/v1/fleet` registration socket, and a
  (never-built) standalone ECS service. Game logic, pool logic, and the arena contract are reused.
- The relay's "never signs / never a counterparty" invariant **holds**: routing code still never
  signs; the bot is a separate in-process task the relay merely routes to via a channel. The relay
  gains a "host a local counterparty" capability — a **game-server** role — but the routing/signing
  separation is intact.
- **The dominant scale knob is auto-play cadence, not topology.** 35k games at full speed is
  millions of ops/s regardless of where bots run; capping attract-mode to a watchable few moves/s
  is what makes 5000 CCU tractable. Co-location's RTT halving is a *throughput* bonus for
  high-cadence auto-play, not a human-felt latency win.
- The 5000-CCU connect-spike (≈5k open-PTBs + ≈35k `deposit_party_b`, gas-sponsored) needs sponsor
  autoscaling + spike staggering; the batched open (ADR-0019/0026) is mandatory.
- The bench self-play fleet (ADR-0020, `c7i.48xlarge`, no relay) is **unchanged** — it remains the
  source of the headline TPS; the serving fleet is the genuine-two-party provenance layer, bounded
  by real concurrent users.
- We explicitly do **not** co-locate for the demo (no user-visible benefit, real added complexity),
  and do **not** run the serving bot at bench cadence over the relay (the relay is RTT-bound).
