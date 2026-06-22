# 6B — Per-Game Cold-Load Resume + Blackjack Migration — Design

**Status:** Approved (design). Supersedes the partial Task 6B from
`docs/superpowers/plans/2026-06-22-mp-resume-protocol-frontend.md` (commit `ed490ca`).

**Goal:** Finish PvP resume for all four games so a dropped player — **including a
full page reload** — re-attaches to their in-flight match and resumes from the last
co-signed state. The warm path (reconnect → resync) already works for ttt/caro,
battleship, and poker; this work adds the **cold-load** (page-reload) path for all
four, finishes the **blackjack `bjRelay → MpClient` migration**, and ships a
**reusable adapter integration guide** so future games get resume by implementing one
adapter + one spec.

**Out of scope:** Task 7 (on-chain settlement floor — unilateral settle + 1h grace
timer). It gets its own spec. Attestation unification (a teammate is folding bjRelay's
attested hello into MpClient across the team separately) — this work **drops**
blackjack's attestation to match the other three games' v1 self-asserted hello.

## Background

Layers A/B/C from the parent plan are in place and committed (Tasks 1–6A + a partial
6B):

- **Layer A (SDK):** `DistributedTunnel.adoptCheckpoint`/`snapshot`/`seatPending`/
  `resendPending`; pure `decideReconcile`.
- **Layer B (`frontend/src/pvp/mpClient.ts`):** reconnect loop, resume wire, typed
  `resume.ok`/`peer.resumed`/`peer.dropped` events, active-match registry,
  multi-listener `PvpChannel`.
- **Layer C (`frontend/src/pvp/resume.ts` + `resumeSession.ts`):** `ResumeRecord`
  persistence (debounced write, `pagehide` flush, bigint JSON, active-tunnel index,
  6h TTL), the `attachResume` warm driver + `restoreInto` cold-load primitive, the
  `resync` `PeerMessage` variant, and the four per-game adapters.

**What 6B left undone (the gap this spec closes):**

1. **No cold-load reconstruction.** `restoreInto` exists, but nothing rebuilds a fresh
   `DistributedTunnel` from a persisted record on mount. The parent plan referenced
   helpers (`cfgFromRecord`/`channelFor`/`identityFromRecord`) that **do not exist**.
2. **Battleship/poker can't cold-load at all** — they mint their ephemeral signing key
   with `generateKeyPair()` each session, so after a reload the key needed to co-sign
   moves and the resync is gone.
3. **Blackjack is unfinished** — still on `RelayClient`, only the persistence lifecycle
   is wired (no warm `attachResume`, no resync). Its buy-in rides a `stake` app message
   that `MpClient.PeerMessage` has no variant for. Commit `ed490ca` also bundled ~150
   lines of prettier churn into `usePvpBlackjack.ts`.

## Decisions (from brainstorming)

- **Scope:** cold-load for all 4 games **+** the blackjack `bjRelay → MpClient`
  migration. Task 7 separate.
- **Ephemeral key survival:** persist the **per-match** self ephemeral secret inside the
  `ResumeRecord` (TTL-evicted, driver-owned) — not a shared per-wallet identity. This
  keeps it scoped and auto-expiring, and uniform across all four games.
- **Blackjack attestation:** **drop it** for this migration (match the other three
  games' unverified hello). A teammate unifies attestation into MpClient separately.
- **Cold-load locus:** **centralized driver + thin per-game `RebuildSpec`** (approach A).
  One audited reconstruction path; the integration guide becomes "implement an adapter +
  a `RebuildSpec`," not "write a cold-load loop."
- **Integration guide:** standalone living doc at `docs/resume-adapter-guide.md`.
- **Plan structure:** one implementation plan — a shared foundation task, then one
  phase per game.

## Global constraints (carried from the parent plan)

- **Generic SDK/driver core + thin per-game adapters.** No game re-implements
  verification, adoption, persistence, or reconstruction. One audited crypto/reconcile
  path; verification stays confined to `adoptCheckpoint` (resume-time only).
- **Local-authoritative + peer gap-fill.** Each seat restores its own tunnel, its own
  hidden secret, **and its own ephemeral key** from local persistence; the peer's
  `resync` only resolves the ≤1 in-flight move.
- **Per-move cost unchanged.** The only per-move addition remains the debounced resume
  record write. Cold-load adds work at **mount/resume time only**.
- **`encodeState` is a one-way digest input.** Every adapter owns full-state JSON
  (de)serialization; `adoptCheckpoint` re-binds by asserting
  `blake2b256(encodeState(deserialized)) === stateHash`.
- **No new server message types.** Reconciliation and the blackjack `stake` exchange
  ride the existing opaque peer-message side channel.
- **Framework discipline (CLAUDE.md).** `sui-tunnel-ts` is upstream-authoritative — no
  SDK changes are needed here; all work is in `frontend/`. Keep pnpm + prettier +
  `node:test` via tsx; co-locate `*.test.ts`.
- **`RelayClient`/`bjRelay` deprecated, not deleted** — `@deprecated`, left in tree.
- **Conventional Commits**, ≤50-char subject, no AI attribution, one logical change per
  commit.

---

## Architecture

Cold-load is a **mount-time discovery + reconstruction** pass that feeds the existing
warm machinery. Nothing on the hot path changes.

```
hook mount
  ├─ installResumePersistence()                      (idempotent; pagehide/visibilitychange flush)
  ├─ const mp = new MpClient(...)
  ├─ resumeActiveTunnels(mp, GAME_ID, spec, ctx)      ── cold-load (NEW)
  │     evictExpiredRecords()
  │     for each listActiveTunnels() where record.game === GAME_ID:
  │         rebuildTunnel(mp, record, spec, ctx)
  │             keypair  = keypairFromSecretHex(record.selfEphemeralSecretHex)
  │             self     = makeEndpoint(backend, ctx.selfWallet, keypair, true)
  │             opponent = makeEndpoint(backend, record.opponentWallet,
  │                                     { publicKey: fromHex(record.opponentPubkeyHex), scheme: 0 }, false)
  │             channel  = mp.channel(record.matchId)
  │             tunnel   = new DistributedTunnel(spec.proto,
  │                          { tunnelId, self, opponent, selfParty: record.role, moveCodec: spec.moveCodec },
  │                          channel.transport, balancesFromRecord(record))
  │             restoreInto(tunnel, record, spec.adapter)     (adopt checkpoint + secret + pending)
  │             mp.markActive(matchId)
  │             return { tunnel, channel }                     (reconstruct-only; NO attachResume here)
  │      hook: activateSession(mp, channel, tunnel, info)      (wires onConfirmed THEN attachResume; hydrates UI)
  └─ mp.connect()                                     ── handshake sends resume{matchId} for each active match (incl. first connect)
        └─ server: resume.ok(peerOnline) / peer.resumed
              └─ attachResume → sendResync → decideReconcile → adopt | re-propose | noop | settle
                    └─ adapter.onReconciled(...) hydrates UI; next move co-signs; onConfirmed re-persists
```

### Units and boundaries

| Unit | Location | Responsibility | Depends on |
|---|---|---|---|
| `ResumeRecord` (+`selfEphemeralSecretHex`) | `resume.ts` | durable per-tunnel state incl. per-match key | — |
| `keypairFromSecretHex` | `resume.ts` | rebuild a `KeyPair` from the persisted secret | `@noble/curves`, `bytes` |
| `RebuildSpec<State,Move>` | `resumeSession.ts` | the thin per-game inputs reconstruction can't derive | — |
| `rebuildTunnel` | `resumeSession.ts` | reconstruct one tunnel from a record + spec (reconstruct-only: `restoreInto` + `markActive`, NO `attachResume` — the hook's `activateSession` owns that) | `DistributedTunnel`, `MpClient`, `restoreInto` |
| `resumeActiveTunnels` | `resumeSession.ts` | evict + rebuild every active tunnel for a game | `resume.ts` index, `rebuildTunnel` |
| per-game `RebuildSpec` factory + adapter | each hook / adapter file | proto, codec, secret handlers, UI hydration | the game's protocol |

`rebuildTunnel`/`resumeActiveTunnels` are the only new shared surface. A game provides a
`RebuildSpec` and calls `resumeActiveTunnels` once on mount — it never writes
reconstruction logic.

### Interfaces (new / changed)

```ts
// resume.ts
interface ResumeRecord {
  // ...existing fields...
  selfEphemeralSecretHex: string; // NEW: per-match self signing secret (hex)
}

// resumeSession.ts
interface ResumeIdentity {
  // ...existing fields...
  selfEphemeralSecretHex: string; // NEW: persisted so buildRecord writes it
}

interface RebuildSpec<State, Move> {
  proto: Protocol<State, Move>;                 // same proto object the hook builds for a live match
  moveCodec?: MoveCodec<Move>;                   // games with binary moves (battleship, poker)
  adapter: ResumeAdapter<State, Move>;           // full-state + secret (de)serialization + onReconciled
  balancesFromRecord?(record: ResumeRecord): { a: bigint; b: bigint }; // default: from latest checkpoint balances
}

interface ResumeContext {
  selfWallet: string;                            // current connected wallet at mount
}

interface RestoredSession<State, Move> {
  tunnel: DistributedTunnel<State, Move>;
  channel: PvpChannel;
  detach: () => void;
}

function rebuildTunnel<State, Move>(
  mp: MpClient, record: ResumeRecord, spec: RebuildSpec<State, Move>, ctx: ResumeContext,
): RestoredSession<State, Move>;

function resumeActiveTunnels<State, Move>(
  mp: MpClient, gameId: string, spec: RebuildSpec<State, Move>, ctx: ResumeContext,
): RestoredSession<State, Move>[];

// mpClient.ts — PeerMessage gained (landed):
//   | { t: "stake"; amount: number }
```

Default `balancesFromRecord`: `{ a: checkpoint.partyABalance, b: checkpoint.partyBBalance }`.
Since balances always sum to the locked total, the current split reconstructs the same
total; `adoptCheckpoint`'s `a + b === total` check passes. Blackjack therefore needs no
separate stake persistence — the asymmetric split is recovered from the checkpoint.

---

## Data flow details

### Cold-load ordering
`resumeActiveTunnels` runs **before** `mp.connect()`. `mp.channel()` only registers
local relay handlers (no socket needed), and `attachResume` only subscribes to events,
so both are safe pre-connect. `markActive` registers each match in the registry before
the handshake. On connect, the challenge handler issues `resume{matchId}` for every
active match — **this must fire on the first connect, not only on reconnect** (a small
change to the Task 3 handshake, which currently gates resume behind an `isReconnect`
flag).

### Warm vs cold
- **Warm** (socket dropped, no reload): the live tunnel object survives in memory;
  reconnect → `resume` → `resync` → reconcile. Unchanged.
- **Cold** (reload): the tunnel object is gone; `rebuildTunnel` reconstructs it from the
  record, then the same reconnect → `resume` → `resync` → reconcile path runs.

Both converge through `attachResume`/`decideReconcile`; cold-load only adds the
reconstruction step.

### UI hydration
`rebuildTunnel` returns the reconstructed tunnel; the hook's `activateSession` wires
`onConfirmed` + `attachResume` and hydrates the rendered state from `tunnel.snapshot().state`
immediately (so the board shows before the peer answers), and `adapter.onReconciled`
re-hydrates after the handshake resolves any ≤1-move gap.

---

## Per-game specifics

| Aspect | ttt/caro | battleship | poker | blackjack |
|---|---|---|---|---|
| Transport | MpClient ✓ | MpClient ✓ | MpClient ✓ | MpClient ✓ (migrated) |
| Balances | const symmetric | const symmetric | const symmetric | asymmetric (from checkpoint) |
| Move codec | JSON-native | `battleshipMoveCodec` | `pokerMoveCodec` | JSON-native |
| Secret | none | fleet (board+salts) **+ placements** | hole cards + slot secrets | none |
| Opener | role A | role A | role A | role B (preserved) |
| Warm `attachResume` | wired ✓ | wired ✓ | wired ✓ | wired ✓ |
| Cold-load `activateSession` | wired ✓ | wired ✓ | wired ✓ | wired ✓ |

- **ttt/caro:** `RebuildSpec` with no secret + JSON move + const balances. The shared hook
  serves both games; filter `listActiveTunnels()` by the per-game id ("tictactoe"/"caro"
  — confirm the exact ids each registers).
- **battleship:** spec carries `battleshipMoveCodec`; `restoreInto` restores the secret
  blob `{ fleet, placements }` via `restoreSecret`. `placements` is carried because it is
  not reconstructable from the 0/1 board yet is needed for per-ship damage; both round-trip
  into the hook's out-of-React store (`PvpSession.secret` / `.placements`) as number arrays
  so they survive `localStorage` JSON (the commitment is recomputed from board+salts).
- **poker:** spec carries `pokerMoveCodec`; restores hole-card/slot secrets via
  `restoreSecret` into `tunnel.state` (applied after `rebuildTunnel` returns). Slot
  `value`/`salt` typed arrays are encoded as number arrays, and `serializeState`
  preserves bigints structurally (no `JSON.stringify`) so the record round-trips.
- **blackjack:** `RelayClient → MpClient` migration landed — the buy-in `stake` rides
  `sendPeer`/`onPeer` (the new `PeerMessage` variant), the attested `party.hello` was
  dropped for the plain `hello`, role-B-opens is preserved, and the warm `attachResume`
  + cold-load are wired through a shared `activateSession`. `bjRelay` is `@deprecated`.

---

## Error handling

- **Integrity failure on rebuild** (`adoptCheckpoint` throws on bad sig / wrong tunnelId
  / hash mismatch / balance-sum mismatch): `rebuildTunnel` wraps reconstruction in
  try/catch, calls `clearResumeRecord(tunnelId)` for the corrupt entry, and skips it —
  the user falls through to a fresh match (and, once Task 7 lands, the on-chain floor).
- **Missing `selfEphemeralSecretHex`** (a pre-migration record): unrestorable → skip +
  `clearResumeRecord`. Schema stays `v1`; the field is additive and optional-at-read,
  records lacking it are simply evicted.
- **Equivocation** (`decideReconcile` → `settle`): surfaced via `adapter.onReconciled
  (tunnel, "settle")`. The actual settle UI/flow is Task 7; here it's surfaced only.
- **Opponent absent on cold-load:** rebuild succeeds, `resume` is sent, no `resync`
  arrives; the seat sits at its restored checkpoint. The warm grace timer (Task 7)
  governs settlement; this work just restores and waits.
- **Corrupt/oversized localStorage:** existing `parseWithBigint` try/catch returns
  `null`; `readResumeRecord` already tolerates this — rebuild skips null records.

---

## Testing strategy

All `node:test` via tsx; reuse the fake-relay-pair harness from `mpClientFrameParity`/
`resumeSession` tests.

**Foundation (`resumeSession.test.ts`, `resume.test.ts`):**
- `keypairFromSecretHex` round-trips a generated key (sign with restored == sign with
  original).
- `rebuildTunnel` reconstructs a tunnel from a persisted record that co-signs the next
  move **byte-identically** to a never-dropped tunnel.
- `resumeActiveTunnels` evicts expired records and rebuilds only records matching the
  given `gameId`.
- `selfEphemeralSecretHex` persists through `buildRecord` and survives the
  stringify/parse round-trip.

**Per-game cold-load integration (one per game):**
- Drive two `MpClient`s over the fake relay to nonce N; persist seat A's record; **drop
  and "reload"** seat A by constructing a fresh `MpClient` + `rebuildTunnel` from the
  persisted record (fresh objects, same persisted secret); reconnect; run the resync;
  assert both seats converge and the next move co-signs.
- **battleship:** the fleet secret is restored on cold-load and **never** appears in a
  `resync`/`serializeState` payload (extends the existing secret test).
- **blackjack:** (1) frame-envelope parity gate across two MpClients (migration guard,
  like Task 4); (2) `stake` buy-in round-trips through `sendPeer`/`onPeer` and yields the
  correct asymmetric `{a, b}`; (3) cold-load integration with asymmetric balances.

**Typecheck/format gate:** `pnpm -C frontend typecheck` + `pnpm -C frontend format`
clean after each task; stage only the task's files.

---

## Integration guide (`docs/resume-adapter-guide.md`)

A living how-to for adding resume to any **future** game. Contents:

1. **What resume gives you** — warm (reconnect) + cold (reload) restore, on-confirm
   persistence, the ≤1-move reconciliation handshake, and the settlement floor hand-off.
2. **The three wirings** every hook needs:
   - `installResumePersistence()` once on mount.
   - warm: `attachResume({ mp, channel, tunnel, adapter, identity })` after the live
     tunnel is built; call `detach()` on teardown.
   - cold: `resumeActiveTunnels(mp, GAME_ID, spec, ctx)` on mount before queueing.
3. **Implementing a `ResumeAdapter`** — full-state JSON (de)serialization;
   `serializeState` **must exclude** the hidden secret; `encodeState` is one-way so you
   own (de)serialization; `captureSecret`/`restoreSecret` for hidden state; optional
   move codec for binary moves; `onReconciled` for UI hydration.
4. **Providing a `RebuildSpec`** — proto, codec, adapter, optional `balancesFromRecord`.
5. **Invariants checklist** — secret never serialized; per-move cost unchanged; verify
   only at resume; record carries the per-match key; one audited path.
6. **Worked examples** — ttt (minimal, no secret) and battleship (with fleet secret).

---

## File structure

**Modified**
- `frontend/src/pvp/resume.ts` — `ResumeRecord.selfEphemeralSecretHex`;
  `keypairFromSecretHex`.
- `frontend/src/pvp/resumeSession.ts` — `RebuildSpec`, `ResumeContext`,
  `RestoredSession`, `rebuildTunnel`, `resumeActiveTunnels`;
  `ResumeIdentity.selfEphemeralSecretHex`; persist the key in `buildRecord`.
- `frontend/src/pvp/mpClient.ts` — `stake` `PeerMessage` variant; first-connect resume.
- `frontend/src/pvp/resume.test.ts`, `resumeSession.test.ts` — foundation units.
- The four hooks — cold-load wiring + per-game `RebuildSpec`; blackjack also migrates
  off `bjRelay` and adds the warm `attachResume`.
- `frontend/src/games/blackjack/app/lib/bjRelay.ts` (+ any `packages/` copy) —
  `@deprecated`.
- The four adapter files as needed (secret handlers for battleship/poker).

**Created**
- `docs/resume-adapter-guide.md` — the integration guide.
- Per-game cold-load test files (co-located: `src/pvp/*.test.ts` and the game dirs).

## Self-review notes (coverage)

- Cold-load reconstruction → foundation `rebuildTunnel`/`resumeActiveTunnels` + per-game
  `RebuildSpec`.
- Battleship/poker reload feasibility → per-match `selfEphemeralSecretHex` in the record.
- Blackjack completion → migration + `stake` variant + warm `attachResume` + cold-load +
  churn cleanup.
- Future games → the standalone integration guide + the `RebuildSpec`/adapter contract.
- Task 7 (settlement floor) → explicitly out of scope; `settle` is surfaced via
  `onReconciled` for it to consume.
