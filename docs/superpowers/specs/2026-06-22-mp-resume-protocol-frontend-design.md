# MP Resume Protocol — Frontend Design

**Status:** Draft (approved in brainstorming, pending spec review)
**Date:** 2026-06-22
**Scope owner:** frontend (`mpClient`, the per-game PvP hooks, `sui-tunnel-ts` engine)
**Related:** [MP Resume Protocol — Design](2026-06-22-mp-resume-protocol-design.md) (the contract),
[MP Resume Protocol — Backend Implementation Plan](../plans/2026-06-22-mp-resume-protocol-backend.md)
(the server mechanics this consumes), ADR-0010 (the decision record). ADR-0007 (settlement
self-authenticating), ADR-0008 (dispute/ZK path).

---

## Problem

The backend half of the resume protocol ships the _control-plane_ mechanics: a dropped player
reconnects to any instance, re-runs the `connect` handshake, sends `resume { matchId }`, and the
server atomically rebinds the seat's `ConnRef`, notifies the peer (`peer.resumed` / `peer.dropped`),
and invalidates the peer's relay cache. **The server stores no game state for resume.**

That leaves the _data plane_ — the live, co-signed game state — entirely to the client, and the
client does not yet do any of it. Today:

- `MpClient` (`frontend/src/pvp/mpClient.ts`) has a one-shot `connect()` with no reconnect loop:
  on `ws.onclose` it nulls the socket and the match is abandoned.
- ttt/caro use a **separate, near-duplicate** `RelayClient` (`pvpRelay.ts`, also copied under
  `packages/client/`), so any reconnect work would otherwise have to be built twice.
- `DistributedTunnel` (`sui-tunnel-ts/src/core/distributedTunnel.ts`) advances state **only**
  through `propose`/`onMove`/`onAck`, and `onMove` throws on any nonce gap. There is **no way to
  seat a tunnel at nonce N** after the in-memory tunnel is gone.
- The tunnel's game state lives only in an in-memory React ref. The ephemeral co-signer key
  survives a reload (`pvpIdentity.ts` persists it in `localStorage`), **but the game state does
  not** — a page refresh keeps the ability to _sign_ and loses _what we are signing over_.
- The FE on-chain code (`onchain/tunnelTx.ts`) wires **cooperative close only** (both parties
  co-sign a fresh `Settlement`). When the peer is gone, that path cannot complete.

This spec defines the client work the backend deliberately left to it: a reconnect loop, a
peer-to-peer reconciliation engine, reload-grade tunnel reconstruction, the `peer.dropped` grace
flow, and the settlement floor.

## Goals

- A player whose socket dropped — **including a full page reload** — re-attaches to the same
  in-flight match and resumes from the current co-signed state.
- Reconciliation is **client-side and resume-time only**: zero per-move signature verification,
  zero per-move Redis/on-chain ops. The relay payload stays opaque and byte-for-byte; reconciliation
  rides the existing peer-message side channel, **not** new server message types.
- A single audited crypto/reconciliation path shared by all four PvP games (ttt/caro, blackjack-pvp,
  battleship, quantum poker), with thin per-game adapters.
- When reconciliation is impossible (peer never returns, or genuine equivocation), fall through to
  the **existing** on-chain settlement path — no new dispute logic.

## Non-goals (explicitly out of scope)

- **Backend mechanics** — `rebind_match_conn`, the four wire messages, the bus eviction path, the
  `peer.dropped` notice. Shipped by the backend plan; consumed here as fixed.
- **Affinity / owner-death re-homing** (future ADR-0011) and any **server-side watchtower
  checkpoint store**. Resume is client-held state only.
- **Self-play modes** (e.g. self-play blackjack via `OffchainTunnel`) — no relay, no peer, state is
  deterministically replayable; not part of the PvP resume path.
- **New on-chain / dispute logic.** The unilateral settle path already exists in the SDK
  (`onchain/lifecycle.ts`); this spec only _surfaces_ it in the FE.

---

## Design in one line

> **Resume = a reconnect loop in `MpClient` (reconnect → `connect` → `resume`/`queue.join`) +
> reload-grade tunnel reconstruction from a locally-persisted co-signed checkpoint + a peer-to-peer
> reconciliation handshake that adopts the highest both-signed nonce and re-proposes the ≤1
> in-flight move. Local persistence is authoritative; the peer fills the gap. On-chain settlement
> from the last co-signed checkpoint is the floor.**

---

## Decisions (locked in brainstorming)

| Decision           | Choice                                                                             | Why                                                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failure-mode scope | **Reload-grade (full)**                                                            | The spec's problem statement lists "page refresh"; the tunnel ref is lost on reload, so we must reconstruct from persistence, not just re-attach the socket.                                                                                             |
| Architecture       | **Generic core + thin per-game adapters**                                          | The `CoSignedUpdate` shape, ed25519 verification, nonce ordering, hash-binds-state, adoption, and persistence are all game-agnostic. Per-game impls would be 4× the bug surface on the trust-sensitive path.                                             |
| Trust model        | **Local-authoritative + peer gap-fill**                                            | Each seat restores its own tunnel from local persistence (and its own hidden secret, which the peer can never supply); the peer's re-send only resolves the ≤1 in-flight move and recovers a client whose local storage is gone. Robust to peer-offline. |
| Client split       | **Migrate ttt/caro onto `MpClient`; deprecate `RelayClient` (keep, don't delete)** | The reconnect loop must live in the socket-owning client; building it twice is waste. `RelayClient` is marked `@deprecated` and left in the tree for now — lower-risk and reversible — rather than removed.                                              |

---

## Architecture — three layers

### Layer A — SDK reconciliation primitives (`sui-tunnel-ts`, framework)

The one bounded framework change. `DistributedTunnel` gains:

**`adoptCheckpoint(state: State, coSigned: CoSignedUpdate): void`** — seat the tunnel at a verified
both-signed checkpoint. Preconditions, all asserted:

- `coSigned.update.tunnelId === this.tunnelId`
- `coSigned.update.nonce >= this._nonce` (never move backward; a lower nonce is ignored, not an error)
- `partyABalance + partyBBalance === this.total`
- `blake2b256(this.protocol.encodeState(state)) === coSigned.update.stateHash`
  (binds the full state to the signed hash)
- both signatures valid over `serializeStateUpdate(coSigned.update)` — reuse the existing
  `verifyCoSignedUpdate(coSigned, partyA, partyB)`

On success: set `_state = state`, `_nonce = update.nonce`, `_latest = coSigned`; clear `pending`
iff `pending.nonce <= update.nonce`.

**`snapshot(): TunnelSnapshot`** — read-only `{ state, nonce, latest, pending? }` for the
persistence layer (Layer C serializes `state` via the adapter; `latest` carries both sigs).

No other tunnel internals change. `propose` regenerates an identical MOVE frame deterministically
(ed25519 over identical bytes), which is how a restored pending proposal is re-sent.

> **Framework discipline (CLAUDE.md):** `sui-tunnel-ts` is upstream-authoritative. `adoptCheckpoint`
>
> - `snapshot` are additive, minimal, and the genuinely-missing capability resume needs — not a
>   refactor. Keep them on the existing toolchain (pnpm, prettier, `node:test` via tsx) and co-locate
>   `*.test.ts`.

### Layer B — reconnect loop + resume wire (`frontend/src/pvp/mpClient.ts`)

`MpClient` becomes reconnect-capable:

- **`connect()` refactor:** split the one-shot promise into (a) socket open + `challenge→connect`
  handshake and (b) a persistent `onclose` handler that triggers reconnect. The `#relayHandlers`
  map, `#matchQueue`, and `#matchWaiters` survive across reconnects and are re-bound to the new
  socket.
- **Reconnect loop:** on `ws.onclose` (not an explicit `close()`), reconnect to the LB with capped
  exponential backoff + jitter; re-run `connect`; then for each match the client believes active,
  send `resume { matchId }`; if it was only queued (no match yet), re-issue `queue.join` (idempotent
  server-side — `JOIN_OR_PAIR` discards the caller's own front entries and never self-pairs).
- **New inbound messages:** handle `resume.ok { matchId, role, opponentWallet, game, peerOnline }`,
  `peer.resumed { matchId, seat, connRef }`, `peer.dropped { matchId }`. Surface them to subscribers
  via a small typed event API (`onResumeOk`, `onPeerResumed`, `onPeerDropped`) the game hooks attach
  to. `connRef` is server-side routing only — the FE ignores its contents.
- **Active-match registry:** `MpClient` tracks which `matchId`s it considers active (set at
  `match.found` and on `channel(matchId)`, cleared at `releaseMatch`) so the reconnect loop knows
  what to `resume`.

**`RelayClient` is deprecated, not removed.** ttt/caro migrate to `MpClient`. The two clients are
near-identical (same handshake, same matchId-multiplexed relay, same app/frame split); the migration
reconciles the one real divergence — the engine-frame envelope key (`{t:"frame", f}` in `RelayClient`
vs `wrapInnerFrameJson` / `{t:"frame", data}` in `MpClient`). Pick `MpClient`'s shape and update
ttt's transport accordingly. `RelayClient` (and its `packages/client/` copy) stays in the tree marked
`@deprecated` with a pointer to `MpClient` — lower-risk and reversible; deletion is a later cleanup
once the migration has soaked.

### Layer C — per-game adapter + persistence (each game hook)

A small interface each PvP game implements, plus a shared persistence helper.

```ts
interface ResumeAdapter<State> {
  serializeState(s: State): JsonValue; // full app state — NOT encodeState (may be a digest)
  deserializeState(j: JsonValue): State;
  captureSecret?(): JsonValue; // hidden info the peer cannot supply (e.g. fleet)
  restoreSecret?(j: JsonValue): void;
  onReconciled(
    tunnel: DistributedTunnel<State, Move>,
    outcome: ReconcileOutcome,
  ): void;
}
```

The hook wires the adapter into the generic `reconcile` engine and the persistence helper, and
re-renders on `onReconciled`.

---

## The reconciliation handshake (the heart)

A drop leaves the two seats **at most one move apart**: a seat cannot propose nonce `N+2` until
`N+1` is co-signed (`propose` throws while a proposal is pending). Reconciliation is therefore a
short handshake over the **existing peer-message side channel** — a new `PeerMessage` variant,
opaque to the relay, **no new server message types**:

```ts
| { t: "resync"; nonce: string; hasPending: boolean;
    checkpoint?: { update: WireStateUpdate; sigA: string; sigB: string };
    fullState?: JsonValue }       // adapter-serialized; sent so the peer can adopt
```

Trigger: on `peer.resumed` (peer side) or `resume.ok` with `peerOnline === true` (resumer side),
each seat sends `resync` carrying its latest co-signed nonce, whether it holds a pending proposal,
and (for the gap-fill / lost-storage case) its checkpoint + full state.

Decision table for the receiver:

| Condition                                                                 | Action                                                                                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `peer.nonce > my.nonce`                                                   | Peer already co-signed the move I lacked. `adoptCheckpoint(deserialize(peer.fullState), peer.checkpoint)`. Adoption clears my pending. I do **not** re-send. |
| `my.nonce > peer.nonce`                                                   | Symmetric — my `resync` lets the peer adopt mine.                                                                                                            |
| equal **and** I hold a pending proposal                                   | Re-`propose(pending.move, pending.timestamp)` — re-sends the MOVE through the normal transport; peer applies + ACKs.                                         |
| equal, no pending                                                         | Nothing to do; resume play.                                                                                                                                  |
| peer's both-signed checkpoint at **my** nonce has a different `stateHash` | **Equivocation** → settlement floor; do not adopt.                                                                                                           |

The explicit nonce-exchange is exactly what avoids the "re-send a MOVE the peer already applied →
nonce-gap throw" hazard: we decide _adopt vs. re-propose_ **before** touching the transport.
Verification (`adoptCheckpoint`) is client-side and resume-time only.

When the local tunnel survived (transient WS drop, no reload), the same handshake runs against the
live in-memory tunnel — restoration (below) is skipped and the seat already holds its own state.

---

## Reload-grade reconstruction

Reload destroys the in-memory tunnel, so each seat persists a compact **resume record**, keyed by
`tunnelId`, written on each confirmed move via the existing `onConfirmed` hook:

```ts
interface ResumeRecord {
  matchId: string;
  tunnelId: string;
  role: "A" | "B";
  game: string;
  opponentWallet: string;
  opponentPubkeyHex: string; // to verify a peer re-send if local is lost
  latestCoSigned: { update: WireStateUpdate; sigA: string; sigB: string }; // settle floor (both sigs)
  latestState: JsonValue; // adapter-serialized full app state
  pending?: { move: JsonValue; timestamp: string }; // re-proposed deterministically on restore
  secret?: JsonValue; // adapter hidden secret (fleet, hole salt)
  updatedAt: number;
}
```

- **Store:** `localStorage`, matching the existing `pvpIdentity` ephemeral-key pattern (synchronous,
  survives reload, already the trusted home for PvP signer material). bigints serialize via a JSON
  replacer/reviver. A tiny `Set<tunnelId>` active-match index is persisted at match-open so a cold
  load knows what to resume.
- **Cadence: debounced (coalesced) writes.** `onConfirmed` marks the latest record dirty and
  schedules a coalesced flush (e.g. microtask / short timer), so a burst of confirmed moves collapses
  to one `localStorage` write — the faster choice on the move path. A **synchronous flush on
  `pagehide` / `visibilitychange:hidden`** guarantees durability before a reload or tab close. This is
  **local I/O off the relay/Redis/on-chain hot path** the spec protects, and signature work stays at
  resume only. Losing the very latest checkpoint to the debounce window is safe: restore lands at
  most one move behind, which the reconciliation handshake closes (peer-ahead → adopt).
- **Restore (cold load):** read the active-match index → for each, `new DistributedTunnel(...)` →
  `adoptCheckpoint(adapter.deserializeState(latestState), latestCoSigned)` → if `pending`,
  `propose(pending.move, BigInt(pending.timestamp))` (deterministic ⇒ byte-identical frame re-sent)
  → `adapter.restoreSecret(secret)`. Then the reconnect loop issues `resume { matchId }`; the
  reconciliation handshake closes any remaining in-flight gap with the peer.
- **Lifecycle:** record cleared on cooperative settle / match end; on load, evict records older than
  the server's 6h match TTL (a resume past that gets `match_gone` and falls to settlement).

Because local persistence is authoritative, a seat reconstructs **without any peer involvement** —
critical when both dropped or the peer never returns. The peer's `resync` is an optimization (closes
the in-flight gap) and a recovery path (a client whose `localStorage` was cleared verifies the
peer's checkpoint against the on-chain party pubkeys + the `stateHash` binding).

---

## `peer.dropped` → grace timer → settlement floor

- On `peer.dropped { matchId }`, the adapter surfaces "opponent reconnecting…" and starts a **60s**
  FE grace timer. 60s is a **frontend constant**; the server never ends a match.
- On `peer.resumed` / `resume.ok` with `peerOnline`, cancel the timer and run the reconciliation
  handshake instead.
- **On grace expiry**, offer settle from the **last co-signed checkpoint** the client holds
  (`latestCoSigned`). Cooperative close needs the peer's fresh signature, which is unavailable — so
  this uses the SDK's **existing** unilateral path (`sui-tunnel-ts/src/onchain/lifecycle.ts`:
  `force_close` / `raise_dispute`), which submits the already-both-signed checkpoint and claims after
  the on-chain timeout. The only new FE code is **surfacing that existing builder in
  `frontend/src/onchain/tunnelTx.ts`** (which today wires cooperative close only). Equivocation falls
  through the same path.

**On-chain timeout confirmation:** the Move referee's default `timeout_ms` is **1 hour**
(`sui_tunnel/sources/referee.move:113,297`), comfortably ≥ the 60s grace window, so a settle started
post-grace is always contestable by a late-returning peer. Planning confirms the exact config
Dopamint opens tunnels with and adjusts only if it is shorter than 60s.

---

## Per-game integration

| Game          | Client today                              | State serialization                                              | Hidden secret                                     | Notes                                                                       |
| ------------- | ----------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| ttt / caro    | `RelayClient` → **migrate to `MpClient`** | `AnyState` is plain JSON (board, turn, balances, size, lastMove) | none                                              | `RelayClient` + its `packages/client/` copy left `@deprecated`, not deleted |
| blackjack-pvp | `MpClient`                                | `BlackjackState` serializer                                      | none                                              | **self-play** blackjack out of scope (no relay, deterministic)              |
| battleship    | `MpClient`                                | public state JSON                                                | **fleet secret — local-only, never sent to peer** | the canonical reason local-authoritative was chosen                         |
| quantum poker | `MpClient`                                | state JSON                                                       | hole-card salt (if any) as `secret`               | ZK dispute path unchanged, separate from resume                             |

Each game keeps its existing tunnel + channel wiring; the adapter adds (de)serialization, secret
capture/restore, and an `onReconciled` re-render. No game re-implements verification or adoption.

---

## Failure modes & edge cases

- **Transient WS drop (tunnel survives):** reconnect, `resume`, run the handshake against the live
  tunnel. No restoration, often no transfer (each seat holds its own state; only the in-flight move
  reconciles).
- **Page reload (tunnel lost):** restore from `localStorage`, `resume`, handshake closes the gap.
- **Both drop, both return:** each restores locally; whoever's `resync` lands first triggers the
  ≤1-move reconciliation. No server anchor.
- **Both drop, one returns:** returning seat restores locally, waits the 60s grace, settles on-chain
  from `latestCoSigned`.
- **Peer never returns:** local-authoritative restore still yields a playable/ settleable state;
  grace → settlement floor.
- **`localStorage` cleared on one side:** that seat recovers full state from the peer's `resync`,
  verified against the on-chain party pubkeys + the `stateHash` binding before `adoptCheckpoint`.
- **Resume for a 6h-expired match:** server replies `match_gone` → clear the local record, settle
  from `latestCoSigned` if held, else the match is already on-chain-recoverable only.
- **Duplicate `resume` (double reconnect):** server rebind is last-writer-wins; the stale socket
  stops being routed. The FE issues one `resume` per active match per reconnect.
- **Equivocation (conflicting both-signed state at the same nonce):** out of scope to adjudicate →
  settlement floor → on-chain dispute (ADR-0008).

---

## Performance invariants (must hold)

- **Per move:** zero signature verification beyond the existing `onMove`/`onAck` co-sign, zero
  Redis/on-chain ops, opaque relay payload unchanged. The only per-move addition is marking the
  resume record dirty; the **local** `localStorage` write is debounced/coalesced off the protected
  hot path (synchronous flush on `pagehide`).
- **Per reconnect (rare):** one `connect` handshake + one `resume`/`queue.join` per active match +
  the bounded `resync` exchange. Signature verification (`adoptCheckpoint`) happens **only here**.
- **No new server message types**; reconciliation rides the existing peer-message side channel.

---

## Testing strategy

- **SDK unit (`node:test` via tsx, co-located):** `adoptCheckpoint` accepts a valid both-signed
  checkpoint; rejects bad sig, wrong `tunnelId`, hash mismatch, balance-sum mismatch, lower nonce;
  clears stale pending. `reconcile` decision table: peer-ahead→adopt, self-ahead→peer-adopts,
  equal+pending→re-propose, equal→noop, equivocation→signal-settle. Deterministic, no IO.
- **Persistence unit:** `ResumeRecord` round-trips with bigint fidelity; restore reconstructs a
  tunnel that co-signs the next move byte-identically; restore-with-pending re-emits the identical
  MOVE frame.
- **`MpClient` reconnect unit (mocked `WebSocket`):** `onclose` → backoff reconnect → `connect` →
  `resume` per active match; queued-only → `queue.join`; relay handlers / waiters survive re-bind;
  an explicit `close()` does **not** reconnect.
- **Cross-client integration:** two in-process `MpClient`s over a fake relay drive a full
  drop→reconnect→reconcile for ttt; both converge to the same nonce/state and the next move
  co-signs.
- **Battleship secret test:** the fleet secret is restored locally and **never** appears in any
  peer-message payload (assert on serialized `resync` bytes).
- **ttt migration regression:** the existing ttt PvP happy-path test passes unchanged after the
  `RelayClient` → `MpClient` swap (frame-envelope parity).

---

## Deliverables

1. **SDK (Layer A):** `DistributedTunnel.adoptCheckpoint` + `snapshot` and the generic `reconcile`
   engine + decision table, with `node:test` units.
2. **`MpClient` (Layer B):** reconnect loop, `resume`/`queue.join` on reconnect, `resume.ok` /
   `peer.resumed` / `peer.dropped` handling + typed event API, active-match registry; ttt/caro
   migrated to `MpClient` and `RelayClient` marked `@deprecated` (kept, not deleted).
3. **Persistence + adapters (Layer C):** `localStorage` resume-record helper (debounced write +
   `pagehide` flush, cold-load restore) and the four per-game adapters (ttt/caro, blackjack-pvp,
   battleship, quantum poker).
4. **Settlement floor:** surface the SDK's existing unilateral `force_close` / `raise_dispute` in
   `onchain/tunnelTx.ts`; wire the 60s grace timer + settle offer to `peer.dropped`.
5. Tests per the strategy above.

## Open items to pin during planning

- Confirm the exact `timeout_ms` Dopamint opens tunnels with (default is 1h; validate ≥ 60s).
- Confirm the precise SDK entrypoint for the unilateral checkpoint settle (`force_close` vs
  `raise_dispute` + claim) and its argument shape from a `CoSignedUpdate`.
- Confirm `protocol.encodeState` is a one-way digest for every game (drives the adapter-owned
  `serializeState`/`deserializeState` requirement); if any game's `encodeState` is reversible, its
  adapter may reuse it.
- Decide whether the active-match registry / resume-record helper lives in `mpClient.ts` or a small
  sibling module (`frontend/src/pvp/resume*.ts`) — likely a sibling to keep `MpClient` focused.
