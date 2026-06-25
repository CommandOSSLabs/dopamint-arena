# PvP Resume — Adapter Integration Guide

How to give a new PvP tunnel game **resume**: a dropped player — including a full
page reload — re-attaches to their in-flight match and continues from the last
co-signed state. You implement one `ResumeAdapter` and one `RebuildSpec`; the
shared, audited driver does verification, adoption, persistence, and
reconstruction. No game re-implements crypto or reconciliation.

Design rationale and the cross-game decisions live in
[`specs/2026-06-22-6b-per-game-resume-design.md`](specs/2026-06-22-6b-per-game-resume-design.md).
This file is the how-to; read it when wiring a game.

## What resume gives you

- **Warm restore** (socket dropped, tab still open): the live tunnel survives in
  memory; reconnect → `resume` → `resync` → reconcile.
- **Cold restore** (page reload): the tunnel object is gone, so the driver
  rebuilds it from a persisted `ResumeRecord`, then runs the same handshake.
- **On-confirm persistence**: every co-signed move debounce-writes a record; a
  `pagehide`/`visibilitychange` flush guarantees durability before a reload.
- **≤1-move reconciliation**: each seat restores its own checkpoint, hidden
  secret, and ephemeral key locally; the peer's `resync` only resolves the single
  in-flight move (adopt / re-propose / noop / settle).
- **Settlement-floor hand-off**: equivocation or grace-timer expiry is surfaced
  via `onReconciled(tunnel, "settle")` / `onGraceExpired` for the on-chain floor.

Per-move cost is unchanged — the only hot-path addition is the debounced record
write. All reconstruction happens at mount/resume time.

## Source map

| Unit                                                         | Location                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `ResumeRecord`, persistence, `keypairFromSecretHex`          | `frontend/src/pvp/resume.ts`                                                         |
| `ResumeAdapter`, `attachResume`, `restoreInto` (warm)        | `frontend/src/pvp/resumeSession.ts`                                                  |
| `RebuildSpec`, `rebuildTunnel`, `resumeActiveTunnels` (cold) | `frontend/src/pvp/resumeSession.ts`                                                  |
| `MpClient`, `PvpChannel`, first-connect resume               | `frontend/src/pvp/mpClient.ts`                                                       |
| Worked adapters                                              | `…/ticTacToe/app/lib/tttResumeAdapter.ts`, `…/battleship/battleshipResumeAdapter.ts` |

## The three wirings every hook needs

### 1. Install persistence once, on mount

```ts
import { installResumePersistence } from "@/pvp/resume";

installResumePersistence(); // idempotent; registers the pagehide/visibilitychange flush
```

### 2. Warm path — attach after the live tunnel is built

After the match handshake builds the `DistributedTunnel`, attach the driver. It
persists on every confirmed move and runs the resync handshake when the peer is
reachable. Keep the returned `detach` and call it on teardown. Wire your game's
`tunnel.onConfirmed` (render + bot automation) **before** calling `attachResume` —
`attachResume` chains its persistence onto whatever `onConfirmed` you set. Put
both in one shared `activateSession(mp, channel, tunnel, info)` helper so the live
and cold-load paths produce identical wiring.

```ts
import { attachResume } from "@/pvp/resumeSession";

const detach = attachResume({
  mp,
  channel,
  tunnel,
  adapter,
  identity: {
    matchId,
    tunnelId,
    role, // "A" | "B"
    game: GAME_ID,
    opponentWallet,
    opponentPubkeyHex,
    selfEphemeralSecretHex, // hex of THIS seat's ephemeral secret — required
  },
  // Optional: settlement floor after the grace window (defaults to 1h).
  onGraceExpired: (latest) => {
    /* raise unilateral dispute from `latest` */
  },
});
```

`selfEphemeralSecretHex` is the one field easy to miss. It is the per-match
signing secret, persisted into the record so a **cold** reload can rebuild the
signer. Without it the record is unrestorable and gets evicted on reload.

### 3. Cold path — rebuild active matches on mount, before connecting

Call `resumeActiveTunnels` once on mount, **before `mp.connect()`** (so the
opening handshake carries the `resume{matchId}` frames — `MpClient` resumes on the
first connect, not only on reconnects). It evicts expired records and rebuilds
every active record for your `gameId`. `rebuildTunnel` is **reconstruct-only**: it
reseats each tunnel at its checkpoint and calls `mp.markActive`, but does **not**
wire `onConfirmed` or call `attachResume`. The hook owns that through the same
`activateSession` it uses for the live path, so both paths get identical per-move
wiring (and the cold path can pass `onGraceExpired`).

```ts
import { resumeActiveTunnels } from "@/pvp/resumeSession";
import { readResumeRecord } from "@/pvp/resume";

const restored = resumeActiveTunnels(mp, GAME_ID, spec, { selfWallet });
if (restored.length > 0) {
  const { tunnel, channel } = restored[0]; // one active match per game in practice
  const rec = readResumeRecord(tunnel.tunnelId)!;
  activateSession(mp, channel, tunnel, {
    matchId: rec.matchId,
    role: rec.role,
    opponentWallet: rec.opponentWallet,
    opponentPubkeyHex: rec.opponentPubkeyHex,
    selfEphemeralSecretHex: rec.selfEphemeralSecretHex!,
  });
  await mp.connect(); // opening handshake carries resume{matchId}
  return; // skip matchmaking — we are continuing an in-flight match
}
await mp.connect();
// ...normal quickMatch flow...
```

Each `RestoredSession` carries `{ tunnel, channel }` (no `detach` — the hook's
`activateSession` owns the `attachResume` lifecycle). `activateSession` hydrates
the UI from `tunnel.snapshot().state` right away; `adapter.onReconciled` re-hydrates
after the handshake resolves any gap. A corrupt or pre-key record is dropped and
skipped — one bad entry never blocks the rest, and that seat falls through to a
fresh match.

## Implementing a `ResumeAdapter`

The adapter is the only game-specific serialization the driver needs.

```ts
interface ResumeAdapter<State, Move> {
  serializeState(s: State): JsonValue; // FULL public state; MUST exclude the hidden secret
  deserializeState(j: JsonValue): State;
  serializeMove?(m: Move): JsonValue; // omit for JSON-native moves (identity default)
  deserializeMove?(j: JsonValue): Move;
  captureSecret?(): JsonValue; // hidden state the peer can never supply
  restoreSecret?(j: JsonValue): void;
  onReconciled(tunnel, outcome): void; // re-render; `outcome === "settle"` → settlement floor
}
```

Rules:

- **You own full-state (de)serialization.** `encodeState` is a one-way digest
  input, not a serializer — `adoptCheckpoint` re-binds by asserting
  `blake2b256(encodeState(deserializeState(json))) === stateHash`. Round-trip any
  non-JSON field (e.g. `Uint8Array` ⇄ number arrays) yourself.
- **`serializeState` must never include the hidden secret.** It feeds the
  persisted record _and_ the `resync` payload sent to the peer. Hidden state goes
  through `captureSecret`/`restoreSecret` only.
- **Binary moves need a codec.** Provide `serializeMove`/`deserializeMove`
  (typically your `moveCodec.encode`/`.decode`); JSON-native moves omit them.
- **`bigint` is handled for you** — the persistence layer tags bigints through a
  JSON replacer/reviver, so balances in state serialize structurally.

## Providing a `RebuildSpec`

The cold path needs the few inputs it can't read from a record:

```ts
interface RebuildSpec<State, Move> {
  proto: Protocol<State, Move>; // the SAME proto object a live match builds
  moveCodec?: MoveCodec<Move>; // binary-move games only (battleship, poker)
  adapter: ResumeAdapter<State, Move>; // same adapter as the warm path
  balancesFromRecord?(record): { a: bigint; b: bigint }; // default: checkpoint A/B split
}
```

The default `balancesFromRecord` reads the checkpoint's `partyABalance`/
`partyBBalance`. Since balances always sum to the locked total, the current split
reconstructs the same total and `adoptCheckpoint`'s `a + b === total` check
passes — so even games with an asymmetric split (a buy-in, say) need no separate
balance persistence.

## Worked example — tic-tac-toe (no secret)

Public state, JSON-native moves, symmetric balances. Minimal adapter:

```ts
// frontend/src/games/ticTacToe/app/lib/tttResumeAdapter.ts
export function makeTttResumeAdapter<AnyState, CellMove>(
  onReconciled: ResumeAdapter<AnyState, CellMove>["onReconciled"],
): ResumeAdapter<AnyState, CellMove> {
  return {
    serializeState: (s) => s as unknown as never, // public state is structural JSON
    deserializeState: (j) => j as AnyState,
    onReconciled, // no secret, no move codec
  };
}

const spec = { proto, adapter: makeTttResumeAdapter(onAdvance) };
```

## Worked example — battleship (hidden fleet)

The fleet (board + per-cell salts) must survive restore but must never reach the
peer. The secret blob is `{ fleet, placements }` — `placements` (the per-ship
layout) rides along because it is **not reconstructable from the 0/1 board**, yet
`deriveBattleshipView`/`fleetStatus` need it for per-ship damage. Both ride
`captureSecret`/`restoreSecret` exclusively; the binary move needs a codec, and the
typed-array fields are stored as number arrays so they survive `localStorage` JSON:

```ts
// frontend/src/games/battleship/battleshipResumeAdapter.ts (abridged)
return {
  serializeState: (s) => ({
    ...s,
    commitA: s.commitA ? Array.from(s.commitA) : null, // Uint8Array → number[]
    commitB: s.commitB ? Array.from(s.commitB) : null,
  }),
  deserializeState: (j) => /* number[] → Uint8Array */,
  serializeMove: (m) => battleshipMoveCodec.encode(m),
  deserializeMove: (j) => battleshipMoveCodec.decode(j),
  // fleet board+salts (as number arrays) AND placements — NEVER in serializeState.
  captureSecret: () => ({
    fleet: { board: Array.from(fleet.board), salts: fleet.salts.map(Array.from) },
    placements: getPlacements(),
  }),
  restoreSecret: (j) => {
    setSecret(makeFleetSecret(Uint8Array.from(j.fleet.board), j.fleet.salts.map(Uint8Array.from)));
    setPlacements(j.placements); // the commitment is recomputed from board+salts
  },
  onReconciled: () => sync(),
};

const spec = { proto, moveCodec: battleshipMoveCodec, adapter };
```

The fleet + placements round-trip into the hook's out-of-React secret store; on
cold-load they are restored from `record.secret`, never from a `resync` payload.

## Invariants checklist

- [ ] `serializeState` excludes the hidden secret (it feeds both the record and
      the peer-facing `resync`).
- [ ] Hidden state round-trips only through `captureSecret`/`restoreSecret`.
- [ ] `selfEphemeralSecretHex` is set in the `attachResume` identity (else cold
      reload can't co-sign).
- [ ] Binary moves provide a `moveCodec` in both the live tunnel config and the
      `RebuildSpec`.
- [ ] `resumeActiveTunnels` runs on mount **before** `mp.connect()`.
- [ ] Per-move cost unchanged — no extra work on the hot path beyond the debounced
      write.
- [ ] Verification stays at resume time only (inside `adoptCheckpoint`); the game
      never touches keys or signatures.

## Adoption status

The shared cold-load path (`rebuildTunnel`, `resumeActiveTunnels`,
`keypairFromSecretHex`, first-connect resume) is implemented and unit-tested, and
all four PvP games are wired: tic-tac-toe/caro, battleship, quantum-poker, and
blackjack each extract a shared `activateSession` and route both the live and
cold-load paths through it. The blackjack `bjRelay → MpClient` migration landed
alongside (adding the `stake` peer-message variant); `bjRelay` is `@deprecated` but
retained. Each game's byte-parity reconstruction is unit-tested; the end-to-end
page-reload path still needs manual two-tab QA per game.
