# Agent-centric PvP game session library — design

**Date:** 2026-06-20 · **Status:** proposed · **Scope:** the PvP tunnel *session*
layer for tic-tac-toe + blackjack (the layer above the PR #28 game-bot kit).

## Problem

The UI feedback (Daniel Lam, 2026-06-20) asks us to make games **agent-centric**:
package game logic + interaction into a library, have the UI *reactively* consume
it, run the same logic **headless** at max throughput for a backend bot fleet, and
keep manual clicks low. Today the PvP logic for each game is trapped inside one
giant React hook — `usePvpTicTacToe` (~685 lines), `usePvpBlackjack` (~829 lines) —
that fuses pure game logic, the off-chain tunnel session, on-chain settlement, and
React state. There is no headless path: the only fleet engine
(`frontend/src/agent/agentEngine.ts`) drives the **superseded SDK behaviour
protocols** via `proto.randomMove`, not the real frontend protocols, so its
settlements do not match human play.

**PR #28 (`feat/game-bot-kit`, merged into this branch) ships the bottom layer**: a
canonical `GameKit`/`GameBot` contract, four per-game kits, a `GAME_KITS` registry,
a self-play harness, and an import-hygiene boundary (`frontend/src/agent/**`). It is
verified to be a **pure Core layer** — zero references to `DistributedTunnel`,
transport, or settlement — so it slots cleanly *under* a session layer.

This spec covers **only that session layer**: a headless `PvpGameSession` that wraps
the SDK tunnel engine, consumes a `GameKit`, drives a real co-signed two-party game
to cooperative settlement, and exposes a reactive store the React UI can subscribe
to. PvP two-party only, tic-tac-toe + blackjack only.

## Decisions (locked with the requester)

- **Library scope = "Core + session".** The session owns the propose→co-sign→apply
  loop and the bot driver; it **wraps** the SDK `core.DistributedTunnel` rather than
  reimplementing co-signing.
- **PvP two-party only**, both games. vs-dealer / bot-arena / vs-AI / caro fold in
  later as session configs; not now.
- **Strangler migration, tic-tac-toe first**, then blackjack. Non-PvP modes and
  their hooks are untouched.
- **zkLogin is a separate effort.** The session only exposes the on-chain signing
  seam so a zkLogin implementation can drop in later without touching it.
- **Robustness target = fleet-grade.** The headless fleet must not hang a lane when
  a peer drops, abandons mid-game, or settlement fails. (See Robustness below.)

## Verified ground truth (the parts the design leans on)

The off-chain engine is `core.DistributedTunnel<S,M>`
(`sui-tunnel-ts/src/core/distributedTunnel.ts`). Constructor:
`new DistributedTunnel(protocol, cfg, transport, initialBalances)` where
`cfg = { tunnelId, self: PartyEndpoint, opponent: PartyEndpoint, selfParty }`. It
**already separates the three things the session must inject**:

1. **`transport`** — an interface `{ send(frame), onFrame(cb) }`. The relay client's
   `transport(matchId)` already returns exactly this (`bjRelay.ts`/`ttt pvpRelay.ts`),
   and proven loopback impls exist (`quantumPoker/runtime.ts`,
   `ttt pvpEngine.e2e.test.ts`). The engine never owns the connection lifecycle.
2. **`self`/`opponent` `PartyEndpoint`s** — `self` carries `secretKey` + a bound
   `sign`; `opponent` is verify-only (its pubkey arrives over the relay
   `party.hello` exchange). Built by `makeEndpoint(...)` (`core/tunnel.ts`). The
   frontend holds **only its own** seat key. Per-move co-sign is **Ed25519 over the
   wire-serialized `StateUpdate`** (`domain | tunnelId | blake2b(encodeState) |
   nonce | timestamp | balances`, `core/wire.ts`) — *not* a bare hash, so the
   identity seam must hand the engine a key+sign, never a `signState(hash)`.
3. **On-chain** is entirely outside the engine: `SignExec = (tx) => Promise<{digest}>`
   (`frontend/src/onchain/tunnelTx.ts`), with `buildOpenAndFundSeatA`
   (`onchain/createAndFund.ts`), `depositStake`, `buildCloseWithRootFromSettlement` /
   `closeCooperativeWithRoot`, and the dual settle path (backend `POST /v1/tunnels/
   {id}/settle` → wallet `close_cooperative_with_root` fallback, `agentEngine.ts`).

Engine API the session uses: `.propose(move, ts)`, `.state` (confirmed),
`.onConfirmed` (a **single settable callback**, not multi-subscriber),
`buildSettlementHalfWithRoot(ts, transcriptRoot, onchainNonce)` /
`combineSettlementWithRoot`. Both seats must independently derive the **same
transcript root** or the on-chain cooperative close fails — there is a runtime guard
("Transcript root mismatch between players") in the hooks today.

**`agentEngine.ts playOneMatch` is already a working headless session** — it does
`makeEndpoint` + `new DistributedTunnel` + `propose` on `onConfirmed` + settle. It
just drives `createBehaviorProtocol(behavior).randomMove` instead of a kit. So
`PvpGameSession` is largely *`playOneMatch` refactored to drive the kit and expose a
reactive store*, not greenfield.

**PR #28 contract** (`frontend/src/agent/gameKit.ts`): `GameKit<S,M> { id, protocol,
stateHash, createBot(seat, ctx), defaultStake }` and `GameBot<S,M> { plan(state): M
| null, confirm(state, move), abort() }`. `plan()` already includes
**protocol-mandated automation** (blackjack dealer auto-stands; ttt only seat A
advances between games), so the session does **not** add a separate auto-stand /
auto-advance loop — it relays `plan()` output.

## Architecture

```
   React page (thin)                         headless fleet driver
   useSyncExternalStore(                      loop over GAME_KITS:
     session.subscribe,                         new PvpGameSession(kit, seat, deps)
     session.getSnapshot)                        session.start()
        │  subscribes                            │  (no React)
        ▼                                        ▼
   ┌───────────────────────────────────────────────────────────────┐
   │  PvpGameSession<S,M>   (framework-free; tsx-importable)         │
   │   • owns a DistributedTunnel<S,M> (built from kit.protocol)     │
   │   • engine loop: onConfirmed → bot.plan(state) → propose →      │
   │     on accepted: bot.confirm(state, move); abort() on close     │
   │   • matchmaking handshake, transcript + root, cooperative close │
   │   • phase machine + error channel + frozen snapshot/subscribe   │
   └───────▲─────────────────▲────────────────────▲─────────────────┘
   injects │ Transport        │ PartyEndpointFactory │ SettlementSigner
           │ (relay|loopback  │ (self key+sign /     │ (open/deposit/close,
           │  + onClose/Error)│  opponent verify)    │  dual-path, role-A)
                                                  consumes GAME_KITS[id]
                                                  (kit.protocol + kit.createBot)
```

### Core unit — `PvpGameSession<S,M>`

Constructed with `{ kit: GameKit<S,M>, seat: Party, relay, endpointFactory,
settlementSigner, rngForSeat, statSink? }`. It:

- builds `bot = kit.createBot(seat, { rngForSeat })` and a `DistributedTunnel` from
  `kit.protocol` + the injected endpoints + transport;
- **solely owns `tunnel.onConfirmed`** and fans out: update snapshot → append
  transcript → run the driver (`plan → propose`; on the accepted confirmation,
  `confirm`) → notify all `subscribe()` listeners. No other code may touch
  `onConfirmed`.
- exposes an **imperative API**: `start()`, `proposeManual(move)` (human move in
  non-auto mode), `setAuto(on)`, `leave()` / `dispose()`, plus `subscribe(cb)` +
  `getSnapshot()`. `start()` runs the startup state machine in the verified order —
  queue → `match.found` (`{ matchId, role, opponentWallet }`) → obtain the per-match
  transport + build the `self` endpoint → `party.hello` to get the `opponent` pubkey
  → seat A `openAndFundSeatA` / seat B `depositSeatB` → activation poll → play — so
  the three seams interleave rather than acting independently.

Pure of React/DOM/`import.meta.env`/`localStorage` (those stay in the adapter), so it
loads under `tsx` for the fleet.

### Reactivity

The thin hook becomes `useSyncExternalStore(session.subscribe, session.getSnapshot)`
plus imperative pass-throughs. `getSnapshot()` returns a **frozen struct with a
stable reference between real changes** (rebuilding it every tick infinite-loops
`useSyncExternalStore`). The snapshot combines `tunnel.state` with session-owned
accumulators the page reads but the engine does not hold: `phase`, `error`, `role`,
`auto`, cumulative `score`/`games` (capped, not re-derivable from state),
`digests`, and per-game extras (`lastBet`/`stake` for blackjack). The exact field
list is the current hook return surface (`PvpTttView` 27 fields, `PvpView` 30
fields) — the parity contract.

### Three injected seams + one session-owned engine

1. **Transport** — reuse the SDK `{ send, onFrame }` **plus `onClose` / `onError`**
   (the engine interface has no disconnect signal; the fleet needs one). Real impl
   wraps the relay client; loopback impl pairs two sessions in-process (tests + the
   self-play harness). The relay **connection** (URL resolution, auth) is established
   outside and injected as a connected client; `start()` obtains the per-match
   transport from it (`relay.channel(matchId).transport`) after `match.found`. The
   session itself never reads a URL or `import.meta.env`, so it stays tsx-importable.
2. **PartyEndpointFactory** — yields `self` (this seat's key + bound `sign` via
   `makeEndpoint`) and accepts the `opponent` verify-only pubkey from the
   `party.hello` exchange. It abstracts the per-game identity reality: **ttt** uses
   one per-browser ephemeral in `localStorage` (`ttt pvpIdentity.ts`); **blackjack**
   uses a fresh per-match ephemeral in **IndexedDB** keyed by `matchId`
   (`bjPvpIdentity.ts`); the fleet bot uses a single unified keypair. Browser-only
   storage stays in the adapter-side factory, never in the session.
3. **SettlementSigner** — on-chain only, **asymmetric + dual-path**:
   `openAndFundSeatA(stake) → tunnelId` (seat A only), `depositSeatB(tunnelId, stake)`
   (seat B), `submitCooperativeClose(coSignedWithRoot) → digest` (**role A only**,
   backend `/settle` → wallet `close_cooperative_with_root` fallback), and a
   `closeOnTimeout()` non-cooperative path. This is the **only** place a wallet/
   zkLogin is touched; a zkLogin `SettlementSigner` drops in later unchanged.

The `DistributedTunnel` itself is **session-owned**, not a seam — the session
constructs and drives it.

### Engine loop (replaces `agentEngine`'s `randomMove` closure)

```
tunnel.onConfirmed = () => {
  snapshot = rebuildSnapshot(tunnel.state)      // + accumulators; frozen
  transcript.append(tunnel.latest)
  if (auto) {
    const move = bot.plan(tunnel.state)         // null = not my turn / waiting
    if (move) { tunnel.propose(move, ts());     // on the confirmed echo: bot.confirm }
  }
  notifySubscribers()
}
```

`plan/confirm/abort` map directly: `plan` decides, `confirm` advances bot memory only
**after** the move co-signs, `abort` tears down on an unclean close. On a rejected
proposal the session re-plans the confirmed state (idempotent by contract) rather
than advancing.

## Robustness (fleet-grade)

The kit only offers `abort()` for a closed channel, so peer-failure handling is
entirely the session's job. The session adds:

- `Transport.onClose`/`onError` → transition to a first-class **`opponent-abandoned`**
  terminal phase instead of an unbounded `await`.
- a **move timeout** and a **settle-half timeout** (the awaited opponent half is a
  bare promise today and can hang forever).
- settle **dual-path with both-fail handling**: backend `/settle` → wallet fallback →
  if both fail, surface `error` in the snapshot (never throw across the boundary).
- a **non-cooperative timeout/penalty close** (`buildOpenAndFundSeatA` already locks
  `timeoutMs`/`penaltyAmount`) for when cooperative close never happens — and an
  explicit note that **only seat A submits**, so if A vanishes after off-chain
  co-sign the channel waits for the timeout path.

Errors and phase live **in the snapshot** (`idle | connecting | queuing | opening |
funding | playing | settling | done | error | opponent-abandoned`); session methods
set `error` + transition + notify, never throw to the caller.

## Migration — strangler, tic-tac-toe first

1. **Extract** `PvpGameSession` + the three seam interfaces under
   `frontend/src/agent/session/` (next to `gameKit.ts`). Lift `playOneMatch`'s
   handshake/settle into it; swap its `createBehaviorProtocol().randomMove` for
   `GAME_KITS["tictactoe"].protocol` + `kit.createBot(seat).plan/confirm`.
2. **Thin** `usePvpTicTacToe` to `useSyncExternalStore(session.subscribe,
   session.getSnapshot)` + imperative pass-throughs. **Parity gate:** the PvP ttt
   page behaves identically and produces byte-identical settlements.
3. **Headless integration test** (see Testing) proving the kit composes with a real
   (loopback) tunnel end-to-end.
4. **Repeat for blackjack** (`BlackjackBetProtocol`, `actorFor` gating already in the
   kit). Same session class; only the endpoint factory (IndexedDB per-match) and the
   bet-vs-stake nuance differ.
5. Once both PvP pages run on the session, **retire** `agentEngine`'s
   `createBehaviorProtocol` path so there is one answer to "what does a bot drive".

## Testing

The kit harness only covers single-process `applyMove`; the session is where the
**tunnel** is first exercised, so the session owns these:

- **Two-endpoint loopback to settlement** — two independent `DistributedTunnel`s,
  **each holding only its own key**, exchanging frames over a loopback transport,
  driven by the kit to `isTerminal`, then `buildSettlementHalfWithRoot` on each side
  and assert **both derive the same transcript root** before `combineSettlementWithRoot`.
  (Giving one side both keys, or one process computing both halves, silently masks
  signature/root divergence — the exact pitfall to avoid.)
- **Move/state byte parity** — seed the RNG and assert the full ordered move list +
  final `encodeState` bytes replay identically; assert **per-seat final balances**
  (sum-conservation alone misses a wrong-winner payout).
- **Domain-tag parity** — the session drives the same FE protocol the human hook
  drives (byte-identical `StateUpdate` serialization).
- **Robustness paths** — peer-abandon at fund stage and mid-game; settle backend
  failure → wallet fallback; both-fail → `error` phase; move/settle timeouts.
- **Reactivity** — `getSnapshot()` returns an identical reference across no-op ticks;
  the thin hook exposes the full prior return surface (React parity).
- **Import hygiene** — the session + its transitive imports load under `tsx`.

## Relationship to PR #28

- **Adopt the Core kit as-is.** `GameKit`/`GameBot`/`GAME_KITS` need no rework; the
  session consumes `GAME_KITS[id]`.
- **`plan/confirm/abort`** is the driver contract — better than the older `next` it
  replaces.
- **ttt kit defects #2/#3 are fixed in this branch** (commit `3f7b4cd`): the advance
  trigger now gates on the outer protocol's terminality (no illegal advance on a
  funding-stopped session), and fast-mode `plan()` is now a pure function of state
  (idempotent on replay). Both have regression tests.
- The other PR #28 findings are **flagged back to the kit author** (out of this
  spec's scope): quantum-poker `plan()` non-idempotency on a replayed pre-commit
  state; the single-session harness; no frontend CI job running `pnpm test`; and the
  porous import-boundary (misses `import.meta.env`/`localStorage`/`window`/`react`,
  dead `*.css` glob, skips `.tsx`). None blocks the ttt/blackjack session work, but
  the poker one must land before a driver consumes the poker kit, and the CI gap
  should be closed so the import boundary actually protects headless importability.

## Out of scope

- vs-dealer / bot-arena / vs-AI / caro modes; the zkLogin implementation (only the
  signing seam); the responsive-layout fix, fewer-clicks/auto-setup, and
  lightweight-UI passes (separate sub-projects); multi-tunnel fleet pooling and AWS
  infra; mainnet; the non-ttt/blackjack kits' internals.

## Risks

- **Co-sign frame ordering / transcript-root agreement** must survive the move out of
  React, or peers' roots diverge and cooperative close fails on-chain — covered by
  the two-endpoint loopback + root-equality test and the existing mismatch guard.
- **Snapshot completeness & reference stability** — missing an accumulator (score,
  digests, lastBet) or rebuilding the snapshot every tick breaks UI parity or loops
  `useSyncExternalStore`; mitigated by pinning the snapshot to the current hook
  return surface and a stable-reference test.
- **Kickoff handshake** — ttt currently does *no* handshake (both seats call advance,
  try/catch swallows the race loser) while `agentEngine` uses an explicit race-free
  `ready` handshake. The session standardizes on the `ready` handshake; this changes
  ttt's current start behavior and needs a kickoff-sequence parity test.
- **Blackjack stake-vs-bet** — `kit.defaultStake` is the funding lock, not the
  per-round wager (the bot picks the bet); funding logic must not double-count it.
