# Tunnel settlement fairness: cheating, deadlocks, and the cash-out invariant

> **Type:** design
> **Scope:** How wagered arena games settle over a Sui tunnel — what cheating is
> impossible, what a stalemate pays, the one griefing hole, and the fix.
> **Read when:** Someone asks "is this 100% cheat-proof?", "what if both players
> cheat and nobody moves?", "can a match end in a stuck draw?", or "does this work
> for player-vs-server-bot, not just self-play?".
> **Does NOT cover:** Tunnel/state-channel internals ([ARCHITECTURE.md](ARCHITECTURE.md));
> adding a game ([../guide/adding-a-tunnel-game.md](../guide/adding-a-tunnel-game.md)).
> Decision record: [../decisions/0029-settleable-at-every-state-balances.md](../decisions/0029-settleable-at-every-state-balances.md).
> **Owns:** The safety-vs-liveness framing for arena games and the griefing-draw
> threat model.

## TL;DR

- **No game is "real-time."** Chicken Cross and Bomb-it look like arcade games,
  but every "tick" is **one turn both players cryptographically sign**. Turn-based
  games with an arcade skin; no frame loop anywhere.
- **Cheating (an illegal move) is ~100% impossible** — a move counts only if the
  opponent co-signs, and the chain rejects anything both parties didn't sign. You
  can't forge a move, rewind, or invent a result.
- **"No cheating" ≠ "the game always finishes."** The first holds
  cryptographically; the second does not come for free.
- **The one real hole:** a *losing* player stops signing and stalls. With balances
  frozen at a 50/50 "nobody's won yet" state, that stall settles as a **refund** —
  a trailing player turns a loss into a draw, free. **That's a bug.**
- **The fix:** make the running progress *be* the payout at every state
  (`settleShare`). A stall then locks only your current share, which **erodes** as
  the opponent keeps playing. Griefing stops paying.
- **Chicken Cross is fixed by this. Bomb-it is not** (elimination game, no progress
  gradient) — it needs a separate on-chain forceable-move mechanism, scoped as
  follow-up.

## 1. Two guarantees — do not conflate them

**Safety — "no invalid state can settle." ~100%, cryptographic.** Every move is
signed by both parties; each re-runs the other's move and signs only if the rules
produce the same result. A monotonic nonce blocks rewinds. On settlement the chain
checks *signatures + balance conservation* — **not game rules**. So "no cheating"
means "no state you didn't personally sign"; it rests on your client refusing bad
moves, which it does. You are always safe because you can always **refuse**.

**Liveness — "the game reaches a winner." Not automatic.** The chain guarantees
your *money* never sticks: if the opponent vanishes you `raise_dispute`, wait the
timeout, and `force_close` on the last co-signed state. It does **not** guarantee
the *game* finishes. If the two stop agreeing on moves, the match settles at the
last state they both signed.

## 2. Tick ≠ real-time

What we call a "tick" is one signed state update, not a rendering frame. Bomb-it's
own header: *"every world advance is ONE tick = one dual-signed state update; each
tick one seat acts, the other implicitly stays."* Both games serialize into strict
turns, so the turn-based safety story applies unchanged — ticks add **no** new
cheating surface. (PvP is the roadmap default per ADR-0006; today Chicken Cross
runs self-play, so the two-player griefing case is a future — but imminent —
concern.)

## 3. The griefing hole — asymmetric stall

Trace "both cheat, nobody moves":

1. **Cheating cannot succeed** — every move needs the opponent's signature, so an
   illegal move is simply refused. Neither side gains anything illegal.
2. The game **freezes** at the last mutually-signed state; money doesn't freeze
   (timeout → settle that state).
3. If the opponent **disappears**, you force-close the last state they signed and
   they eat an absence penalty — you win. Symmetry broken.
4. **The hole:** a player about to *lose* doesn't disappear — they stay online and
   withhold the signature on the losing move. The last co-signed state is
   *pre-win*, balances frozen 50/50, and they politely `agree_to_dispute` — **no
   penalty** (that only punishes full absence). Result: **both stakes refunded, a
   draw.** The chain can't stop it: it doesn't know whose turn it was
   (`turn = nonce % 2` is off-chain) or what the rules force.

So the honest answer to "we can't draw, can we?" is: **today a losing player can
force one, free.** That is the bug.

## 4. Symmetric stalls are fair, not a bug

A refund is only wrong when someone was *ahead*. When progress is equal, 50/50 is
correct. The distinction:

| Case | Who's ahead | Fair outcome | Bug? |
|---|---|---|---|
| **Asymmetric stall** — one ahead, the trailer stalls to dodge a loss | someone | split by progress (loser ≠ refunded) | **yes → fixed** |
| **Symmetric stall** — equal progress (incl. both `0` from the start, or 10/10 after equal play) | nobody | 50/50 refund | **no — just** |

"Both cheat from the start, nobody ever moves" → stuck at the initial state, scores
`0/0` → 50/50 refund → **correct** (nobody played, nobody is robbed). Funds never
stick: `raise_dispute_current_state` works on the on-chain initial state with no
signature, then `force_close`. Nobody profits, so it isn't an attack — just an
abandoned table (a spam/ops nuisance, self-limiting since the griefer pays gas).

## 5. The fix — the cash-out invariant

Make `balances(state)` the fair *settle-if-halted-here* split at **every** reachable
state (ADR-0029), not a frozen split. Chicken Cross uses `settleShare`: the lead in
furthest-lane `score` maps linearly to the pot as a fraction of the race distance.
It is implemented byte-identically in **both** the TS SDK (`cross.ts`) and the Rust
port (`rust/protocols/cross`) — the two must stay in parity because balances are
part of the encoded state hash.

```
share_A(total) = total · (distance + clamp(scoreA − scoreB, −distance, distance)) / (2 · distance)
share_B = total − share_A                       // conserved exactly, despite integer flooring
```

Worked example — pot `2S`, race to lane 600:

| Situation | Old (frozen) | New (by progress) |
|---|---|---|
| Abandoned, A at lane 400, B at 100 | refund `S` / `S` | **1.5S / 0.5S** |
| Abandoned, tiny early lead (A lane 1, B 0) | `S` / `S` | ≈ `S` / `S` (a trivial lead barely moves it — by design) |
| Someone crosses the finish | winner takes `2S` | winner takes `2S` (**unchanged**) |

Two properties: stalling locks only your *current, smaller* share; and because the
split tracks `scoreA − scoreB`, a staller's share **shrinks** as the opponent keeps
moving — stalling is strictly self-harming. `score` (furthest lane, monotonic) is
used, never current `lane`, so a respawn can't lower a locked claim (strategyproof)
— and it matches the existing `TICK_CAP` score-tiebreak.

### Chicken Cross outcome taxonomy (post-fix)

| Outcome | Result |
|---|---|
| One crosses the finish first | that player takes the whole pot (decisive) |
| Both cross same tick / hit `TICK_CAP` | higher `score` wins all; exact tie ⇒ 50/50 push |
| Abandoned mid-race, **unequal** progress | proportional (leader gets more) |
| Abandoned mid-race, **equal** progress | 50/50 refund |

A 50/50 only ever happens when the two are genuinely tied. You never get 50/50
while one player is ahead — the split is a pure function of `(scoreA, scoreB)`, so a
draw can't be manufactured to dodge a loss.

## 6. Bomb-it and the elimination residual

The fix needs a **progress gradient**. Bomb-it is an *elimination* game — both
players are simply "alive" until a kill, so mid-game there is no gradient and 50/50
genuinely *is* fair while both live. The only unfair stall is refusing to sign the
tick where you'd die, which proportional balances can't express. Closing that needs
**on-chain forceable settlement**: the non-staller forces the rule-mandated outcome
without the staller's signature, via `zk_verifier` / `resolve_dispute_verified`
(anticipated by ADR-0008). Scoped, built per-game when Bomb-it ships real-money PvP
— **not** silently left exposed.

## 7. Player-vs-server-bot ("house") topology

The fix is topology-agnostic: both `OffchainTunnel.selfPlay` and the PvP engine
`DistributedTunnel` settle through the same `balances()`, so it works the moment a
house tunnel runs.

**The player cannot be robbed by the house.** The house has no veto: it can't
censor a dispute tx (permissionless Move call), can't fake a co-signed state (needs
both sigs), can't dodge the on-chain timeout. Post-fix, the state the player
force-closes already carries the fair progress split. Worst case if the house
vanishes is a settlement **delay** (grace + on-chain timeout), never a fund loss.
The client dispute path (`raiseDisputeUnilateral` / `forceCloseAfterTimeout`) is
already wired. One operational requirement: the player must reach Sui **independently
of the house** (own node / a watchtower) to force-close if the house is also the relay.

**Residual (rational house):** the progress split is a proxy, so a near-certain
winner can be shaved. E.g. player at lane 580 (would take the full pot) → a house
stall settles ≈ `1.8S`, not `2S`. Far better than the old `S` refund-draw, but not a
perfect near-win guarantee — that last mile is the forceable-move path (§6).

### Player-vs-bot mode readiness (separate from the fix)

The **fix** ships now with zero blockers. The **mode** is a separate build (real
on-chain you-vs-bot is deferred, ADR-0012):

| | Status |
|---|---|
| `DistributedTunnel` in Node; relay client; player dispute path | **BUILT** (see `docs/guide/quantum-poker-bot-server.md` for the bot-server pattern) |
| Game-specific server bot for cross / bomb-it | **MISSING** |
| Server-side house funding / custody of the stake | **MISSING** (funding builders need a browser wallet) |
| Version-pin client SDK ↔ server-bot SDK | **RISK** — byte-identical `encodeState` required, or the tunnel silently stalls on a hash mismatch |

## 8. Honest limitations

- Progress-proportional is a fair *proxy*, not a win-probability calculation. Fine
  for arcade stakes; for a high-value game with a contested proxy, escalate that
  game to the forceable-move path.
- Abandoned matches now pay by progress instead of refunding — a deliberate,
  fairer behaviour change.
- Elimination / hidden-info games stay on the old behaviour until the forceable
  path ships per-game.
- Correctness depends on a monotonic `balances()`; a future game that gets it wrong
  is a new vector, so the settle-fairness invariant test is mandatory — and any
  change must land in TS **and** Rust together or wire parity breaks.
