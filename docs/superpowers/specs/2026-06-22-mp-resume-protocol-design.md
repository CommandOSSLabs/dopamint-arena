# MP Resume Protocol — Design

**Status:** Draft (approved in brainstorming, pending spec review)
**Date:** 2026-06-22
**Scope owner:** backend `tunnel-manager` (mp lane) + frontend `mpClient`
**Related:** ADR-0005 (HA control plane + delivery primitive), ADR-0009 (data plane local / partition by ownership — defers resume + affinity), ADR-0007 (settlement self-authenticating), ADR-0008 (dispute/ZK path). New ADR-0010 records this decision.

---

## Problem

A dropped WebSocket — network blip, page refresh, mobile backgrounding, or a backend
instance dying — currently kills a live match. On disconnect the server only
`clear_presence_if` + `bus.unregister` (`mp/ws.rs:163-168`); the match record persists in
Redis (6h TTL) but its seat `ConnRef` still points at the dead socket, so any relayed frame
or `match.found` is delivered into the void. There is no path for a returning player to
re-attach to an in-flight match. The product fallback today is "reconnect/on-chain" — i.e.
the match is effectively abandoned.

This hits every user (reconnects are routine), unlike the affinity/throughput work which only
matters at scale. ADR-0009 explicitly defers "a resume protocol so a dropped socket can
rejoin" to its own ADR. This is that work.

## Goals

- A player whose socket dropped can reconnect (to any instance) and **re-attach to the same
  in-flight match**, continuing from the current co-signed state.
- Survive a backend instance dying: its sockets drop, **both** peers reconnect via the same
  path and rebind to surviving instances — no dedicated dead-instance detection.
- Preserve the performance invariant that motivated this whole line of work:
  **zero per-move Redis writes and zero per-move on-chain writes**. The relay hot path
  (`relay_to_other`) is untouched.

## Non-goals (explicitly out of scope)

- **Proactive owner-death re-homing** (server detects a dead instance and migrates its matches
  via a Redis CAS on `owner_instance_id`, liveness heartbeats, socket migration without the
  client noticing). That is the **affinity ADR** (future ADR-0011), per ADR-0009:104-109.
- **Server-side game-state storage / a watchtower checkpoint store for resume.** Live state is
  client-held; the server stores no game state to resume (see "State ownership"). The existing
  `record_checkpoint` / `latest_checkpoint` machinery may stay for an *independent* watchtower
  role, but **resume does not depend on it** and this spec does not extend it.
- **Adjudicating disputes.** Conflicting co-signed states at the same nonce (equivocation) are
  a settlement concern (on-chain referee / ZK, ADR-0008), not resume's job.
- **On-chain checkpoint cadence changes.** On-chain stays open/close/dispute only; resume adds
  nothing to it.

---

## Design in one line

> **Resume = `ConnRef` rebind + socket reconnect + event-driven peer-cache invalidation. Live
> state reconciles peer-to-peer (highest both-signed checkpoint wins, client-verified, off the
> hot path). On-chain settlement is the floor when peers can't reconcile. The server stores no
> game state for resume; the hot path and Redis writes are untouched.**

## State ownership (why the server stores nothing new)

| State | Lives where | Durable across a drop? |
|---|---|---|
| Match identity (game, seats, tunnel_id) | Redis match HASH `match:<id>` | yes (6h TTL) — already built |
| Seat → socket binding (`conn_a`/`conn_b` = `ConnRef`) | Redis match HASH | yes, but **stale** after a drop → this is what resume rebinds |
| Latest co-signed game state (the live "checkpoint") | **the two clients** (off-chain, co-signed) | yes — each client holds its own latest |
| Settlement floor (last co-signed state) | **on-chain** (submitted only at close/dispute) | yes — the trust layer |

The server never holds live game state. Resume only fixes the **seat→socket binding** (control
plane) and lets the clients re-exchange their own state (data plane, peer-to-peer).

---

## Architecture

Three planes, mirroring ADR-0009. Resume touches only the control plane and the
reconnect-time edge of the data plane:

1. **Control plane (Redis, rare/per-reconnect rate):** rebind the seat `ConnRef` in the match
   HASH; re-assert presence. A handful of ops *per reconnect* — never per move.
2. **Data plane (in-process / bus, per move):** unchanged. After a rebind, the peer's in-memory
   match cache is corrected by an **event** (the rebind signal), not a poll — so steady-state
   moves still never read Redis.
3. **Trust layer (on-chain):** unchanged. Settlement floor for the can't-reconcile case only.

### Reconnect → re-attach flow

```
Client (dropped)                Server (any instance)              Peer (if online)
  │  ws connect                    │                                  │
  │  connect{wallet,pubkey,sig}──▶ │ verify ed25519 (existing auth)   │
  │                                │ register conn + set_presence     │
  │  resume{ match_id } ─────────▶ │ rebind_match_conn(match_id,      │
  │                                │   wallet, here()) -> Some(seat)  │
  │                                │   (atomic Lua, O(1) HSET)        │
  │  ◀── resume.ok{ role,          │                                  │
  │       opponent, game,          │ if peer online:                  │
  │       peerOnline } ────────────│   deliver peer.resumed{ match_id,│
  │                                │     seat, connRef } ───────────▶ │ update cache[match_id]
  │                                │                                  │ re-send latest co-signed
  │  ◀───────── relay (peer's latest co-signed state) ───────────────│   state over relay
  │  reconcile locally (verify sigs, adopt max nonce); resume play    │
```

If `peerOnline == false` (both dropped, peer not back yet): the resumer waits; when the peer
also resumes, the two reconcile peer-to-peer. If the peer never returns within the grace
window, the resumer settles on-chain from its held checkpoint.

### Disconnect notice (so the peer can react)

On socket close, for each active match the closing conn was a seat in (known from the
per-connection match cache), the server emits `peer.dropped{ match_id }` to the other seat so
the FE can show "opponent reconnecting…" and start a grace timer. This is the only addition to
the disconnect path; it is a control message, not state.

---

## Components

### C1. `MpStore::rebind_match_conn` (new, atomic)

```
async fn rebind_match_conn(&self, match_id: &str, wallet: &str, at: ConnRef) -> Option<Seat>
```

- **Redis impl:** one Lua script `REBIND_MATCH_CONN`. `HGET seat_a/seat_b`; if `wallet ==
  seat_a` → `HSET conn_a = <ConnRef json>`; elif `wallet == seat_b` → `HSET conn_b`; else
  return nil. `EXPIRE` refresh (6h). Return the matched seat ("a"/"b"). O(1), no loops, no
  read-modify-write, no `cjson` of any balance (ConnRef carries no numbers). Mirrors the
  atomic-primitive discipline established by the aggregation-correctness work.
- **Memory impl:** `get_mut` the record; set the matching seat's `ConnRef`; return the seat.
  No-op (return `None`) if the match is absent or the wallet owns no seat — behaviorally
  identical to Redis.
- Returns `Option<Seat>` so the handler knows the role (and whether the wallet legitimately
  owns a seat — authorization is the seat check itself).

`Seat` is a small enum (`A`/`B`) or a `&str`; pick one and use it consistently.

### C2. Protocol additions (`mp/protocol.rs`)

Client → Server:
- `Resume { match_id: String }` (`#[serde(rename = "resume")]`) — sent **after** `connect`
  succeeds. Re-attach to an existing match.

Server → Client:
- `ResumeOk { match_id, role, opponent_wallet, game, peer_online: bool }`
  (`"resume.ok"`) — re-attach confirmed.
- `PeerResumed { match_id, seat, conn_ref }` (`"peer.resumed"`) — delivered to the *peer*; it
  both (a) invalidates/updates the peer's cached `ConnRef` for that seat and (b) cues the peer
  to re-send its latest co-signed state over the relay. Carrying `conn_ref` avoids a Redis
  read on the peer.
- `PeerDropped { match_id }` (`"peer.dropped"`) — delivered to the still-present seat on the
  opponent's disconnect.
- Reuse the existing `Error { code, message }` for resume failures (`not_a_seat`,
  `match_gone`, `not_connected`).

Wire shapes follow the existing dotted-`type`, camelCase convention (the FE contract; a rename
is an integration break — see the `protocol.rs` round-trip tests).

### C3. Server handlers (`mp/ws.rs`)

- **`Resume`** (only valid in the authed state, after `Connect`): call
  `rebind_match_conn(match_id, wallet, here())`. On `Some(seat)`: read the match for
  `opponent`/`game`/`role` (`bus.register` is already done at connect, `ws.rs:195`).
  Determine **peer_online** as `get_presence(opponent_wallet).is_some()` — presence is
  set on connect and cleared on disconnect (`clear_presence_if`), so it is the cross-instance
  liveness signal (one Redis read, at resume only). Reply `ResumeOk{ ..., peer_online }`, then
  `bus.deliver(peer_conn_ref, PeerResumed{...})` using the match's *other-seat* `ConnRef`
  (delivery is harmless if the peer is offline — it's dropped by the bus). On `None`:
  `Error("not_a_seat" | "match_gone")`.
- **Disconnect path:** when the socket loop ends, for each match this conn is a seat in,
  `bus.deliver(other_seat, PeerDropped{match_id})`. Keep the existing `clear_presence_if` +
  `unregister`. Do **not** delete the match record (it must survive for re-attach within the
  6h TTL).
- **Conn→matches tracking (perf-safe, robust):** maintain a per-connection in-memory
  `HashSet<match_id>` (alongside the existing relay-cache map), populated when this connection
  becomes a seat — at `match.found` (quick-match), `challenge.accept`, and on a successful
  `Resume`. This is **control-plane, rare** (match creation, not per move): O(1) insert at
  match-create, O(1) iteration at disconnect, **zero per-move cost**. It guarantees
  `PeerDropped` fires even if the dropper never relayed a frame — without inferring matches
  lazily from the relay cache. (The relay cache stays exactly as-is for the hot path; the set
  is a separate, tiny membership index on the same connection task.)

### C4. Peer-cache invalidation (`relay_to_other` cache)

The hot path caches `MatchRecord` per connection (`ws.rs:405-435`) to stay off Redis. On
receiving `PeerResumed{ match_id, seat, conn_ref }`, the peer updates
`cache[match_id].conn_<seat> = conn_ref` in place. **No Redis read is added to the move path** —
the cache is corrected by the event. (This is ADR-0009:93's "targeted bus rebind signal".)
Note: `PeerResumed` is a server→client control message *and* the peer's local cache update is
server-side state on the peer's connection task — both live on the peer's instance; the rebind
ConnRef rides in the message so neither side re-reads Redis.

### C5. Peer-to-peer state reconciliation (frontend `mpClient` + game protocol)

Largely a **client** concern; the backend only delivers the relay frames. Over the existing
peer-message side channel (`mpClient.ts:23`, multiplexed on the relay):
- On `PeerResumed` (peer side) or `ResumeOk` with `peerOnline` (resumer side), the online
  party re-sends its **latest co-signed checkpoint** as a peer-message.
- The receiver **verifies both signatures** against the known peer pubkey, then adopts the
  **highest nonce that carries both signatures** (a co-signed checkpoint is self-proving;
  the higher one can't be denied). Play resumes from there; any in-flight post-checkpoint move
  is re-sent by its originator (co-signed moves aren't final until both sign — naturally
  idempotent).
- Verification is **client-side, at resume only** — off the hot path, zero per-move cost.

### C6. Settlement floor (existing on-chain path)

If the peers cannot reconcile (one never returns within the grace window, or genuine
equivocation), the present party settles on-chain from the highest co-signed checkpoint it
holds (`update_state` + close, as today), opening the dispute/challenge window. Resume does not
adjudicate; it falls through to the existing settlement path. No new on-chain code.

---

## Auth

Reuse the existing `Connect` handshake (ed25519 over the server nonce, `mp/auth.rs`) — it
already proves wallet control. `Resume` carries only `match_id`; **authorization is the seat
check** inside `rebind_match_conn` (the authed `wallet` must equal `seat_a` or `seat_b`). No new
crypto, no new token. A wallet that owns no seat in the match gets `not_a_seat`.

## Grace window & abandonment

- The match record's 6h TTL bounds how long re-attach is *technically* possible; a returning
  player can rebind any time within it.
- The **peer's** willingness to wait is a shorter, product-level grace window of **60s**
  (configurable) after which the present party may trigger on-chain settlement
  (claim-via-timeout). Enforcement is the **on-chain dispute timeout**, not the server killing
  the match — the server never unilaterally ends a match. The grace window is surfaced to the
  FE via `PeerDropped`; the FE decides when to offer "claim/settle".
- The 60s window must be ≤ the on-chain challenge window so a settle started after the grace
  period is always contestable by a late-returning peer. Confirm the on-chain challenge window
  during planning and adjust only if it is shorter than 60s.

---

## Failure modes & edge cases

- **Both drop, both return:** each rebinds; whoever the first `PeerResumed`/`ResumeOk` reaches
  triggers a re-send; reconciliation adopts max both-signed nonce. No server anchor needed.
- **Both drop, one returns:** returning party waits the grace window, then settles on-chain
  from its held checkpoint.
- **Stale anchor / nonce gap:** benign — the party with the higher both-signed checkpoint
  proves it; max wins. Not a disagreement (see C5).
- **Equivocation (conflicting state at same nonce):** out of scope → on-chain dispute.
- **Resume for a match that 6h-expired:** `match_gone` → client re-queues / settles on-chain
  from its held state.
- **Duplicate `Resume` (double-click / racing reconnect):** `rebind_match_conn` is an atomic
  last-writer HSET; the latest rebind wins; earlier socket is simply not the bound seat anymore
  and its frames stop being routed. No two-winner hazard (the bind is single-valued per seat).
- **Resume targeting a seat you don't own:** `not_a_seat`.

## Performance invariants (must hold; assert in tests where possible)

- **Per move:** zero Redis ops, zero on-chain ops — `relay_to_other` unchanged; `PeerResumed`
  updates the in-memory cache without a Redis read.
- **Per reconnect (rare):** ≤ ~3 control-plane Redis ops (rebind HSET+EXPIRE via one Lua,
  presence SET, one match read) + bus messages. No per-move amplification.
- **Signature verification:** client-side, resume-time only — never on the move path.
- **Hot path file `mp/ws.rs` relay function `relay_to_other`:** logic unchanged except the
  cache-update branch driven by `PeerResumed`.

---

## Queue / lobby re-attach (in scope, first slice; same primitive)

A player who drops while **queued** (not yet matched) has durable state too: the queue entry
(`join_or_pair`, keyed by wallet) and presence both live in Redis. The same primitive applies:
on reconnect, re-assert presence (already done at `Connect`); if a `match.found` was produced
while offline (the match record exists with this wallet as a seat), the `Resume`/re-attach path
covers it; if still queued, the client remains in queue and presence rebind makes a future
`match.found` deliverable to the new socket. **This needs no new mechanism beyond presence
rebind + the match re-attach** — it ships in the first slice. The only client work is: on
reconnect, after `Connect`, the FE issues `Resume` for any match it believed active, and
otherwise re-issues `queue.join` if it was queued. Re-joining is **safe**: `JOIN_OR_PAIR`
discards the caller's own entries at the queue front and never self-pairs (see the existing
`join_or_pair_never_pairs_wallet_with_itself` test); a transient duplicate self-entry can sit
mid-queue but is harmless and self-cleans when it reaches the front. Add a test that a
reconnect-then-rejoin still pairs correctly and delivers `match.found` to the new socket (not
the dead one).

---

## Testing strategy

- **Unit (memory store, fast):** `rebind_match_conn` rebinds the correct seat, refreshes the
  record, returns the right `Seat`, is a no-op for a non-seat wallet and an absent match —
  identical behavior asserted against both impls.
- **Integration (Redis, `#[ignore]` + `TEST_REDIS_URL`):** `REBIND_MATCH_CONN` Lua atomicity —
  concurrent rebinds yield a single final binding; a rebind of an expired match is a no-op
  (mirrors `set_tunnel_id`'s EXISTS-guard test); the rebound `ConnRef` round-trips.
- **Protocol round-trip:** new `Resume` / `ResumeOk` / `PeerResumed` / `PeerDropped` shapes
  serialize to the exact dotted/camelCase wire the FE expects (extend the `protocol.rs` tests).
- **Behavioral (ws):** disconnect emits `PeerDropped` to the other seat only; `Resume` after
  `Connect` rebinds and emits `ResumeOk` (+ `PeerResumed` when the peer is online);
  `not_a_seat` for a non-seat wallet.
- **Performance guard:** a test (or review checklist item) confirming `relay_to_other` issues
  no Redis call on the steady-state move path after a resume (cache-update is in-memory).
- **Frontend:** `mpClient` reconnect loop sends `connect`→`resume`; on `PeerResumed` re-sends
  latest co-signed state; verifies peer signatures before adopting; adopts max both-signed
  nonce. Reconciliation unit tests on the highest-nonce-wins + sig-verify rule.

---

## Deliverables

1. **ADR-0010** — short decision record: "Resume = rebind + peer-reconcile; on-chain is the
   floor; server stores no game state; affinity/re-homing deferred." Links this spec.
2. Backend: `rebind_match_conn` (both impls + Lua), the four protocol messages, the `Resume`
   handler, the disconnect `PeerDropped` notice, the `PeerResumed` cache-update branch.
3. Frontend: reconnect loop (`connect`→`resume`), peer-state re-send + reconciliation
   (sig-verify + max both-signed nonce) over the peer-message side channel.
4. Tests per the strategy above.

## Decisions (locked)

- **Grace window: 60s** (configurable), must be ≤ the on-chain challenge window — confirm that
  window during planning and only adjust down if it is shorter than 60s.
- **Queue/lobby re-attach: in the first slice.**
- **`PeerDropped` reliability: robust** via the per-connection conn→matches set populated at
  match creation — chosen specifically because it adds zero per-move cost.

## Open items to pin during planning

- `Seat` representation (`enum {A,B}` vs `&str`) — pick one and use it consistently.
- Confirm the actual on-chain challenge-window duration (the Move tunnel/referee module) to
  validate the 60s grace window.
