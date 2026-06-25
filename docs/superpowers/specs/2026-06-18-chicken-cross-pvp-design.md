# Chicken Cross — PvP mode (design)

**Date:** 2026-06-18
**Status:** Approved (design); implementation pending
**Supersedes:** the deferred-PvP note (§11) of `2026-06-18-chicken-cross-tunnel-design.md`

## 1. Goal

Convert Chicken Cross to **PvP as the default** (team decision: all PvP-capable games default to
pattern 2; Blackjack/Poker stay self-play). Two real wallets race over one on-chain tunnel; the
winner takes the pot. Solo policy: **invite / 2-tabs only** — no bot fallback, no agent.

Reuses `CrossProtocol` (in `sui-tunnel-ts/src/protocol/cross.ts`) **unchanged** — it is already
deterministic and winner-take-all. **No SDK, backend, or Move changes.** New work is one frontend
hook + a lobby, mirroring `frontend/src/games/ticTacToe/usePvpTicTacToe.ts` (grep `usePvpTicTacToe`).

## 2. Constraints from the real engine (verified)

- `DistributedTunnel.propose(move, ts)` (in `sui-tunnel-ts/src/core/distributedTunnel.ts`, grep
  `class DistributedTunnel`) is **half-duplex by nonce**: it throws if a proposal is already
  pending, and `onMove` requires `frame.by !== selfParty` and `frame.nonce === nonce + 1`. Both
  seats proposing the same nonce collides. ⇒ **exactly one seat proposes per nonce.**
- `onConfirmed(u)` fires on each co-signed update (on ACK for the proposer, on MOVE for the
  responder). `state` is confirmed; `displayState` shows the proposer's pending move pre-ACK.
- `MpClient` (in `frontend/src/pvp/mpClient.ts`, grep `class MpClient`) exposes only
  `quickMatch(game)` (open queue keyed by the game string), `channel(matchId)` (engine
  `transport` + `sendPeer`/`onPeer`), `announceTunnel`. The earlier-waiter is assigned role `A`.

## 3. Play model — alternate-proposer ping-pong (lockstep)

`CrossProtocol` is simultaneous (`CrossMove { dirA?, dirB? }` advances the world one tick applying
both). The engine is one-proposer-per-nonce. Bridge: **each seat proposes only on its turn,
carrying only its own dir; the world advances each propose.**

```
turn(nonce) = (nonce % 2 == 0) ? "A" : "B"      // A proposes nonce 0→1, B 1→2, A 2→3, ...
each seat keeps `myDir`, default "north" (auto-forward); a key/D-pad press overrides
  the NEXT hop, then it reverts to "north" so a player who stops steering keeps racing
on my turn (after each onConfirmed, if turn(nonce) == selfParty and not terminal):
    after STEP_MS pacing:
      A: dt.propose({ dirA: myDir }, 0n)         // B stays this tick
      B: dt.propose({ dirB: myDir }, 0n)         // A stays this tick
responder re-applies the SAME CrossMove (deterministic) → matches → co-signs (ACK)
both re-render from dt.displayState via deriveView(...)
```

Each player hops on alternate world-ticks (hazards advance every tick); both get equal hops, so the
race is fair. Pace is round-trip-bound. (A smoother "both move every tick via a dir side-channel"
variant is a future refinement; it needs a `mpClient` peer-message addition.)

## 4. Lobby & matchmaking — invite code via private queue

No directed-challenge API exists; use a **per-match private queue name**. No backend change.

| Action | Flow                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create | generate a short code; `quickMatch("chicken-cross:" + code)` parks first ⇒ this seat is `A` (opener/funder); show the code while awaiting `match.found` |
| Join   | enter the code; `quickMatch("chicken-cross:" + code)` ⇒ seat `B`                                                                                        |

Same machine = two tabs (one creates, one joins). Distinct on-chain stakes need two wallet accounts
(same wallet ⇒ the wager round-trips — fine for a demo).

## 5. Match lifecycle (mirrors `usePvpTicTacToe`)

```
1. ephemeral = generateKeyPair(); mp = new MpClient(resolveMpWsUrl(resolveBackendUrl()), wallet, ephemeral); await mp.connect()
2. match = await mp.quickMatch("chicken-cross:" + code); role = match.role
3. channel = mp.channel(match.matchId); waitPeer = makeInbox(channel)   // buffered peer inbox (copy from ttt)
4. exchange ephemeral pubkeys:  sendPeer({t:"hello", ...}); oppPub = (await waitPeer("hello"))
5. fund: A → openAndFundSharedTunnel({partyA:{wallet, ephemeral.pub}, partyB:{opponentWallet, oppPub}, amount: STAKE})
            mp.announceTunnel(matchId, tunnelId); sendPeer({t:"open", tunnelId})
         B → tunnelId = (await waitPeer("open")).tunnelId; depositStake({tunnelId, amount: STAKE})
6. engine: proto = new CrossProtocol(); self = makeEndpoint(backend, wallet, ephemeral, true);
            opp = makeEndpoint(backend, opponentWallet, {publicKey: oppPub, scheme: ephemeral.scheme}, false);
            dt = new DistributedTunnel(proto, {tunnelId, self, opponent: opp, selfParty: role}, channel.transport, {a: STAKE, b: STAKE})
7. dt.onConfirmed = () => { render(); if terminal → settle once; else if my turn → schedule propose }
8. readiness handshake (A awaits "ready", B sends "ready") AFTER dt is live — same as ttt
9. settle: createdAt = readCreatedAt(...); half = dt.buildSettlementHalf(createdAt, 0n);
            exchange halves over sendPeer/waitPeer("settleHalf"); co = dt.combineSettlement(...);
            role A → closeCooperative({tunnelId, settlement: co})
```

`STAKE` is a per-seat constant (MIST); winner-take-all is automatic from `CrossProtocol.balances`,
so no stake-shift parameter is needed (unlike ttt).

## 6. Files

| File                                                        | Change                                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `frontend/src/games/chickenCross/usePvpChickenCross.ts`     | NEW — the PvP hook (this spec)                                                                           |
| `frontend/src/games/chickenCross/components/CrossLobby.tsx` | NEW — create/join-code screen                                                                            |
| `frontend/src/games/chickenCross/ChickenCrossWindow.tsx`    | EDIT — route to PvP: lobby → board; statuses idle/matching/funding/playing/settling/settled/error        |
| `frontend/src/games/chickenCross/components/CrossBoard.tsx` | REUSE — render `deriveView(dt.displayState)`; add this seat's input (arrows + on-screen D-pad) → `myDir` |
| `frontend/src/games/chickenCross/index.ts`                  | UNCHANGED — same `register({ id: "chicken-cross", ... })`                                                |

`CrossProtocol`, `session-core.ts` (`deriveView`) reused. The self-play hook
(`useChickenCrossSession.ts`) and `session-core` stepSession stay in-tree (no longer wired into the
window) — retained as the bot engine for a possible future agent; not dead-code to delete here.

## 7. Testing & gate

- Gate: `cd frontend && pnpm typecheck` + `pnpm build` (green). The PvP path has no new pure logic
  to unit-test (protocol already covered); the hook is integration.
- Headless determinism is already proven for `CrossProtocol`; PvP re-uses it, and both seats run the
  identical `applyMove`, so co-sign matching is structural.
- **Full e2e is manual** (like self-play's on-chain step): run the backend `tunnel-manager` relay,
  open two tabs (two wallet accounts on testnet with the `sui_tunnel` package deployed at
  `VITE_TUNNEL_PACKAGE_ID`), create+join a code, race, confirm the winner is paid.

## 8. Risks

- **Relay required.** Unlike self-play, PvP needs the `tunnel-manager` `/v1/mp` WebSocket up. In dev
  the frontend proxies same-origin; against a deployed backend set `VITE_BACKEND_URL`.
- **Pace.** Ping-pong is round-trip-bound; on a slow link hops feel turn-like. Acceptable for v1;
  the dir-side-channel variant (both move per tick) is the future smoothing.
- **Disconnect/timeout.** v1 has no reconnect; a dropped peer strands the match (settle never
  completes). The on-chain `timeout`/dispute path (`force_close_after_timeout`) is the safety net;
  a polished reconnect is out of scope.
