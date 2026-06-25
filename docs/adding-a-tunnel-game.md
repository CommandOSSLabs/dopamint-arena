# Adding a Game to Dopamint Arena

> **Type:** implementation
> **Scope:** The end-to-end procedure to add a new playable game that settles over a real Sui tunnel (a wagered self-play or PvP game in the arena desktop).
> **Read when:** Building a new game (e.g. bomb-it) or wiring an existing placeholder game to the engine.
> **Does NOT cover:** How tunnels / state channels / settlement work internally — see [ARCHITECTURE.md](ARCHITECTURE.md) and the per-game design spec under [superpowers/specs/](superpowers/specs/). Backend (`tunnel-manager`) and Move (`sui_tunnel`) internals.
> **Prerequisites:** None.
> **Owns:** The file-layout contract for an arena game package; the self-play-vs-PvP wiring decision; the per-layer "what a new game must add" checklist.

## What a new game touches

A new game is almost entirely a frontend package plus ONE SDK protocol class. The backend and Move layers are game-agnostic and need no edits.

| Layer                         | New game must add                         | Why                                                                                     |
| ----------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `frontend/src/games/<game>/`  | A game package (window + hook + register) | The arena desktop is a plugin registry                                                  |
| `sui-tunnel-ts/src/protocol/` | One `Protocol<State, Move>` class         | The off-chain engine drives any protocol generically                                    |
| `backend/tunnel-manager`      | Nothing — just a new `game` string        | Generic control-plane + opaque relay; keys stats/matchmaking by string                  |
| `sui_tunnel` (Move)           | Nothing                                   | `tunnel` is a generic 2-party state channel (state_hash + nonce + balances + dual sigs) |

`sui_tunnel/` and `sui-tunnel-ts/` are **upstream-vendored** (see [CLAUDE.md](../CLAUDE.md) § Repository layout). Add a protocol following the existing protocol files; keep the SDK on its pnpm / `node:test` toolchain — do not convert it to bun/biome or restructure it.

## Pick the wiring pattern

> **Default: PvP** for any game two humans can play (race, board, shooter). Self-play is for games with no real two-human form (Blackjack vs a dealer, single-player Poker) or pure bot/stats showcases. Solo policy for PvP games is **invite / 2-tabs** (a private match code), not a bot fallback — see [superpowers/specs/2026-06-18-chicken-cross-pvp-design.md](superpowers/specs/2026-06-18-chicken-cross-pvp-design.md) § 3–4.

The pattern is fixed by **which signing keys the browser holds**, which selects the engine class. Copy the matching reference game wholesale, then swap the protocol.

|                   | Self-play (bot vs bot)                                                            | PvP (human vs human)                                                                            |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Engine            | `OffchainTunnel.selfPlay` in `sui-tunnel-ts/src/core/tunnel.ts` (grep `selfPlay`) | `DistributedTunnel` in `sui-tunnel-ts/src/core/distributedTunnel.ts` (grep `DistributedTunnel`) |
| Keys              | One browser holds BOTH seats' ephemeral keys                                      | Each browser holds ONE seat's key                                                               |
| Co-sign a move    | Two local signatures, no network                                                  | propose→ACK over the relay                                                                      |
| Funding           | `openAndFundSelfPlay` — both seats, one wallet signature                          | seat A `openAndFundSharedTunnel` + seat B `depositStake`                                        |
| Matchmaking       | None (runs solo)                                                                  | `MpClient.quickMatch("<game-id>")` in `frontend/src/pvp/mpClient.ts` (grep `quickMatch`)        |
| Reference to copy | `frontend/src/games/blackjack/`                                                   | `frontend/src/games/ticTacToe/`                                                                 |
| Hardest part      | The protocol                                                                      | The protocol + real-time determinism over a turn-based channel                                  |

Funding builders live in `frontend/src/onchain/tunnelTx.ts` (grep `openAndFundSelfPlay`). Worked example: Chicken Cross (self-play) — design rationale in [superpowers/specs/2026-06-18-chicken-cross-tunnel-design.md](superpowers/specs/2026-06-18-chicken-cross-tunnel-design.md), step-by-step in [superpowers/plans/2026-06-18-chicken-cross-game-mode.md](superpowers/plans/2026-06-18-chicken-cross-game-mode.md).

## The protocol contract

Implement the generic interface in `sui-tunnel-ts/src/protocol/Protocol.ts` (grep `interface Protocol`). Copy an existing protocol file in `sui-tunnel-ts/src/protocol/` as the structural template; read `sui-tunnel-ts/src/protocol/index.ts` for the current set and the barrel export to add to.

| Method                       | Contract                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `initialState(ctx)`          | Deterministic opening state; set `total = a + b` from `ctx.initialBalances`    |
| `applyMove(state, move, by)` | PURE (no mutation), throws on illegal move; returns next state                 |
| `encodeState(state)`         | Canonical bytes → hashed into the tunnel `state_hash`; same state ⇒ same bytes |
| `balances(state)`            | `{ a, b }` — see the two hard invariants below                                 |
| `isTerminal(state)`          | Game over, ready to settle                                                     |
| `randomMove(state, by, rng)` | Optional; drives self-play bots and the simulator                              |

> **Invariant 1 — conservation.** `balances(state).a + .b === total` for EVERY reachable state. `OffchainTunnel.step` asserts it and throws otherwise. Move funds toward the winner only at terminal states; keep the split constant during play.

> **Invariant 2 — determinism.** State must be a pure function of `(seed-or-tunnelId, ordered moves)`. Any randomness (shuffles, hazard fields, bomb timers) must be derived from a seed that is part of the state and of `encodeState`, so the counterparty and an on-chain disputer replay identically. Seed from the `tunnelId` when the random field is **public and party-independent** (no seat can bias it and the id can't be ground) — e.g. blackjack's card stream, chicken-cross's hazard field, bomb-it's symmetric grid. Use a two-party **commit-reveal** only when a party holds **hidden state it could bias** (battleship fleets, poker hands — see ADRs 0003/0008/0009 and 0010).

Encoding helpers (`protocolDomain`, `lengthPrefixedConcat`, `rollingDigest`) are exported from `Protocol.ts`. Use a fixed-size `encodeState` when state is bounded; use `rollingDigest` when state grows unbounded.

## Arena game package layout

Copy the reference game directory and adapt. Read the chosen reference under `frontend/src/games/` for the current file set; the roles are:

| File                   | Role                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`             | Calls `register({ id, name, icon, Window })` from `frontend/src/games/registry.ts` (grep `export function register`)                |
| `<Game>Window.tsx`     | Status-router component (`GameWindowProps`); renders bet panel / funding / board / error by status                                  |
| `use<Game>Session.ts`  | The integration hook — owns keys, on-chain open/fund/close, the engine, the step timer, telemetry, control-plane                    |
| `session-core.ts`      | Pure, React-free driver (`stepSession` / `deriveView` / `sessionResult`); SDK imports are `import type` only so it runs under `tsx` |
| `components/`, `*.css` | Presentation only — read the view, never decide outcomes                                                                            |

## Self-play checklist

```
1. SDK: write sui-tunnel-ts/src/protocol/<game>.ts implementing Protocol<State, Move>;
        add `export * from "./<game>"` to protocol/index.ts. Co-locate <game>.test.ts
        (determinism, balance conservation every step, terminal payout). Run with tsx.
2. FE:  session-core.ts — stepSession(protocol, tunnel, rng), deriveView(state), sessionResult(state).
        SDK imports type-only. Co-locate session-core.test.ts.
3. FE:  use<Game>Session.ts — copy blackjack/useBlackjackSession.ts; swap the protocol:
          a = createParticipant(...); b = createParticipant(...)   (grep createParticipant)
          tunnelId = await openAndFundSelfPlay({ reads, signExec, partyA, partyB, aAmount, bAmount })
          createdAt = await readCreatedAt(reads, tunnelId)
          tunnel = OffchainTunnel.selfPlay(protocol, tunnelId, a.keyPair, b.keyPair, a.address, b.address, { a, b })
          wire tunnel.onUpdate BEFORE the first step
          getControlPlaneClient().registerSession({ userAddress, game: "<game-id>", tunnels: [...] })  (best-effort .catch)
          setInterval → stepSession; count + flushHeartbeat per step (see Reporting TPS);
          on protocol.isTerminal → buildSettlement(createdAt) → closeCooperative
4. FE:  <Game>Window.tsx (status router) + components + css.
5. FE:  index.ts register(...); add `import "./<game>";` to frontend/src/games/index.ts (position = tile order).
6. Gate (run all): see Gate below.
```

**Attract / take-over (canonical for self-play).** To get the arcade
hover → pause → "Play vs Bot" UX for free, the game opts into the shared cabinet:
drive auto from your kit (step 3 already does), expose `pause`/`resume` + a manual
mode on the hook, and register a `CabinetController` in your App
(`useRegisterCabinet`). The `GameCabinet` wrap in `Desktop` is automatic; a game
that registers nothing stays inert. Cabinet adopters: tic-tac-toe, bomb-it,
chicken-cross. Reference: tic-tac-toe's `App.tsx` / `useBotGame.ts`; design in
[superpowers/specs/2026-06-23-arena-attract-takeover-shell-design.md](superpowers/specs/2026-06-23-arena-attract-takeover-shell-design.md),
decision in [decisions/0012-arena-attract-cabinet-seam.md](decisions/0012-arena-attract-cabinet-seam.md).

## Reporting TPS (heartbeat contract)

Self-play only. The backend never sees your moves — it derives the live TPS as a windowed
derivative of an action counter it accumulates from your heartbeats (single authoritative
clock, ADR-0002). You send **counts, never a rate.** Reference impl: `useBotGame.ts`
(`flushHeartbeat`, ~L224–241; counting at L457–458; tail flush at L494).

Four invariants for a correct count:

1. **Register once** before the first step:
   `registerSession({ userAddress, game, tunnels }) → { sessionId, statsToken }`. Best-effort —
   the backend is never in the per-move loop, so a failed register must `.catch` and keep playing.
2. **One action per _verified_ step.** Bump `actionsRef += 1` (and `moveCountRef += 1` for the
   nonce) exactly once per `tunnel.step(...)`, _after_ `r.verified` — never per render, per retry,
   or per timer tick. `OffchainTunnel.selfPlay` produces every update locally, so one step = one action.
3. **Flush as a throttled heartbeat, never per move.** After each step call
   `flushHeartbeat(tunnelId, false)`. It self-throttles (no-op if `actionsDelta === 0`, or the window
   is < 1 s and not forced) and on send **resets the counter to 0** and restamps the window —
   `actionsDelta` is a _delta since last flush_, not a running total. Payload:
   `{ tunnelId, nonce: String(moveCount), actionsDelta, windowMs }`; `nonce` is the monotonic move count.
4. **Force-flush the tail on settle/teardown:** `flushHeartbeat(tunnelId, true)` before building the
   settlement, so the final partial window isn't dropped.

> **PvP is different — do NOT copy this into a PvP hook.** There the relay is the single point that
> sees every move and counts it server-side (`backend/tunnel-manager/src/mp/ws.rs`). A PvP hook that
> _also_ heartbeat-counts its confirmed moves double-reports — keep the relay count, drop the client
> `actionsDelta`.

## PvP delta

Same protocol; the hook differs. Copy `frontend/src/games/ticTacToe/` and its PvP hook (grep `quickMatch`): generate a per-match ephemeral key, `MpClient.quickMatch("<game-id>")`, exchange the seat public keys, seat A `openAndFundSharedTunnel` + seat B `depositStake`, drive moves through `DistributedTunnel` (propose→ACK), seat A submits the cooperative close. Both sides replay the shared seed-driven protocol to agree on outcomes. No backend or Move change — the relay is opaque and matchmaking keys on the game-id string.

**Resume / settle checklist (PvP).** When wiring resume for a PvP game, add these
to the adapter integration steps (see [resume-adapter-guide.md](resume-adapter-guide.md)):

- [ ] Wire the three resume wirings (persistence install, warm path, cold path).
- [ ] If the game builds a `Transcript`, wire transcript persistence (the five
      edits in the resume-adapter guide § "Transcript persistence") so
      reload-then-settle does not hit a transcript-root mismatch.

## Import discipline

`tsx` (the test runner) ignores the Vite alias and tsconfig `paths` at runtime; Vite resolves them at build/typecheck. This splits how SDK imports are written.

| Context                                               | SDK import style                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `session-core.ts` (runs under tsx)                    | `import type ... from "sui-tunnel-ts/..."` — type-only, erased at runtime |
| `*.test.ts` (runs under tsx) — runtime engine imports | Relative `.ts` path: `../../../../sui-tunnel-ts/src/core/tunnel.ts`       |
| Hook / components / window (Vite-bundled)             | Bare runtime specifier: `from "sui-tunnel-ts/..."`                        |

## Gate

```
cd sui-tunnel-ts && node --import tsx --test src/protocol/<game>.test.ts
cd frontend && node --import tsx --test "src/games/<game>/session-core.test.ts"
cd frontend && pnpm typecheck
cd frontend && pnpm build      # tsc + vite; a passing build confirms single registration (registry throws on duplicate id)
```

The on-chain self-play/PvP flow needs a wallet + the `sui_tunnel` package deployed at `VITE_TUNNEL_PACKAGE_ID` (grep `VITE_TUNNEL_PACKAGE_ID`) — test it manually in `pnpm dev`; headless tools cannot pass the wallet gate.

## Deployment: relay session stickiness (local-first pairing)

The relay sets `Set-Cookie: aff=<instance_id>` on the `/v1/mp` WebSocket handshake.
For co-location to survive reconnects, the load balancer MUST be configured for
cookie-based session affinity on `/v1/mp`, honoring the `aff` cookie (or its own
stickiness cookie). Without it, reconnects are routed round-robin and co-located
matches degrade to split (still correct, over the Redis fallback). Cross-origin
deployments also need `SameSite=None; Secure` on the cookie.

### Verifying stickiness locally

`backend/tunnel-manager/smoke/` holds a self-contained harness that stands in for the
production load balancer: `docker-compose.affinity-smoke.yml` runs Redis + two relay
instances (`INSTANCE_ID=inst-a`/`inst-b`) behind haproxy configured for `aff`-cookie
affinity (`haproxy.cfg`). Run it with:

```bash
backend/tunnel-manager/smoke/affinity-smoke.sh
```

The script (Docker required) brings the harness up, then asserts: a reconnect carrying
`aff=<instance>` is pinned to that instance across repeated handshakes, while cookieless
traffic load-balances across both. It exits non-zero on any failure and tears the harness
down on exit. This validates the LB-honors-`aff` path; AWS ALB uses its own stickiness
cookie, so re-verify affinity there after deploy.

## Anti-patterns

| Don't                                                    | Do                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| Deciding death/win/score in the renderer                 | The protocol is the sole authority; the board reads the view |
| `applyMove` that mutates `state` or breaks conservation  | Pure transitions; balances sum to `total` every step         |
| Randomness not derived from a state-carried seed         | Seed in state + `encodeState`, so play is replayable         |
| `bun install` / converting SDK toolchain                 | The SDK is upstream-vendored — pnpm + `node:test` only       |
| Bare `sui-tunnel-ts/...` runtime import in a `*.test.ts` | Relative `.ts` path in tests (see Import discipline)         |
| Per-game backend or Move code                            | Both layers are generic — a new game is just a new id string |
