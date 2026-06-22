# 0010 — Pixel Duel: battleship-monochrome paint duel on the two-party tunnel

- **Status**: Proposed
- **Date**: 2026-06-22

## Context

We want a pixel-painting game where people draw against each other and finished
canvases land in a browsable gallery. The open question was the *party model*:
can "everyone paints on one canvas" run inside a single tunnel, or is the tunnel
limited to two painters? Resolving that gates the whole design, so we settle it
first, then specify the native game built on top of the answer.

### Party topology — the tunnel is strictly two-party

The tunnel is **strictly two-party**, by construction and by intent:

- On-chain, `Tunnel<T>` stores exactly `party_a` / `party_b` (`PartyConfig` each),
  and `StateCommitment` carries exactly `party_a_balance` / `party_b_balance`
  (`sui_tunnel/sources/tunnel.move:196-226, 182-193`). `create()` takes A's params
  then B's — no participant vector (`tunnel.move:588-599`).
- Every state update is a **2-of-2 co-signature**: `update_state()` verifies
  `sig_a` *and* `sig_b` against the two stored pubkeys; `close_cooperative()`
  splits the pot to exactly two addresses and asserts `a + b == total`
  (`tunnel.move:877-938, 977-1048, 859-861`). There is no aggregation/threshold in
  `signature.move`.
- Off-chain mirrors this: `Party = "A" | "B"`, `balances {a, b}`, one opponent,
  one nonce per tunnel (`sui-tunnel-ts/src/protocol/Protocol.ts:20-21`,
  `frontend/src/pvp/mpClient.ts:13`). N-player support is absent at every layer.
- This is a *design commitment*, not an accident — [[0006]] keeps genuine
  two-party play as the only model (co-signatures prove real interaction; one
  process signing to itself proves nothing). `ARCHITECTURE.md:187-205`.
- The framework already shows how N parties are reached **without** touching the
  core: `example_multi_party_channel.move` composes many 2-party tunnels with
  HTLC routing (Lightning-style). "The core tunnel remains strictly 2-party."

Forking the tunnel to a real N-of-N multisig would change the struct layout, the
signed wire format, settlement, and balance math everywhere — a protocol-wide
breaking change with signature cost growing in N. We therefore build on the
two-party tunnel as-is; a true single-canvas N-painter experience is reachable
only by **composing** 2-party tunnels (deferred, see the Decision), never by
forking the core.

### Hiding the secret templates through the state hash

The native game, Pixel Duel, is a two-seat **staked** duel that runs **entirely
over a tunnel** (1 paint = 1 co-signed move = 1 off-chain "tx"). Each seat is
**forced to a single color** (A = Sui blue idx 14, B = pink idx 5, per
`frontend/src/games/pixelPaint/palette.ts`); a move is only `{x,y}`, the color
implied by the seat. Each seat holds a **secret template** (a ~10×10 shape)
placed at a **random** location on a 48×40 board, **committed by hash at start**
and **hidden from the opponent**; the owner sees a 5-second guide then it hides
(memorize). Both seats paint **simultaneously** (no turns): they race to **paint
their own template cells** (BUILD) and to **take back cells the opponent owns**
(CONTEST/BLOCK); a cell **locks forever** to its last painter after
`overwriteLimit=3` paints. At terminal **both templates are revealed with salt**,
the protocol verifies each reveal against its commit, scores each side =
(template cells painted its color)/(template cell count), and the **higher % wins
and takes the stake** (tie = no shift).

The problem mirrors ADR 0003 (Battleship) and 0008/0009: the tunnel co-signs
`blake2b256(encodeState(state))` **every move**, and both parties **must produce
identical bytes**. If the state hash covered either secret template in plaintext,
each client would need the *opponent's* template to compute it — defeating the
secrecy. That is the governing force. We also **do not edit upstream**
(`sui-tunnel-ts/`, `sui_tunnel/` — see CLAUDE.md § Repository layout), so the new
protocol lives frontend-side and reuses the generic engine.

The genuinely contested questions, where two reasonable people could resolve
differently:

1. **The PROTOCOL ↔ CLIENT split.** What is deterministic and tunnel-native
   (public, co-signed) vs. local-only (secret template, monochrome enforcement,
   cooldown, 5s guide)?
2. **Hidden template must not leak through the state hash** until the reveal step.
3. **Where settlement lives** — a bespoke Move module or the generic tunnel.

## Decision

We build on the **two-party tunnel as-is** — no framework change. The native game
is **Pixel Duel = battleship-monochrome**: a *simultaneous two-painter* duel
where each seat paints its own secret template and contests the opponent's, scored
by commit-reveal at the end. (This supersedes an earlier sketch of Pixel Duel as
"turn-based"; the game has **no turns** — both seats paint at once, monochrome,
with secret per-seat templates revealed and scored only at terminal.)

### 1. The PROTOCOL ↔ CLIENT split

The protocol **holds public-only state** — the same "public-only state"
principle as ADR 0003. State carries: the board + paint/own/lock mechanic
(borrowed **byte- and behavior-identical** from `pixel_paint.war.v1` in
`sui-tunnel-ts/src/protocol/pixelPaint.ts`), **two 32-byte commitments** for the
two templates, phase, winner, balances. The **secret template + salt live in the
session hook/bot, NEVER in protocol state until the reveal step.** Because
`encodeState` hashes only the public parts, two PvP clients holding *different*
secret templates still produce **identical bytes** throughout play.

The following are **CLIENT/BOT only**, invisible to and unenforced by the protocol:

- **Monochrome**: client A only emits `color=14`, client B only emits `color=5`.
  The protocol *still accepts* any legal color 1..16 during play (see below for
  why this is correct, not a hole).
- **Secret-template knowledge**: held locally; passed into `applyMove` only at reveal.
- **Cooldown + miss penalty**: client-timed; **self-imposed** (see §4).
- **5s memorize guide**: UI shows the template for 5s after commit, then hides.

> **Why the protocol need not enforce monochrome.** Terminal scoring counts a
> cell only when `canvas[i] === seatColor` *and* `template[i] === 1`. If A
> "cheats" by painting B's color (idx 5) on one of A's own template cells, that
> cell scores **neither** for A (since `canvas[i] !== 14`) **nor** for B (it is not
> B's template) — it only hurts A. Monochrome is therefore a **self-imposed**
> rule: protocol-blindness here is *safe*, not a hole. Enforcing color in the
> protocol would force the state to know the template to tell "right vs wrong
> color" apart — defeating the very secrecy we built.

### 2. Game rules (the public mechanic)

Board 48×40, three parallel `width*height` (row-major) arrays exactly like
pixelPaint: `canvas` (color index), `owner` (0 empty / 1 A / 2 B = last painter),
`paints` (paint count). Each `paint{x,y,color}` move by seat `by`:

1. Reject if the cell is **locked** (`paints[idx] >= overwriteLimit`).
2. Set `canvas[idx]=color`, `owner[idx]=by`, `paints[idx]++`.
3. Maintain O(1) counters: `ownedA/ownedB` (current territory), `locked`.
4. **BUILD** = paint your own template cell (only the client knows → no state
   effect); **CONTEST/BLOCK** = paint a cell whose `owner` is the opponent → steal
   ownership; after `overwriteLimit` paints the cell **locks forever** to its last
   painter (a tug-of-war that eventually locks).
5. Terminal when `placed >= cap` **OR** `locked === width*height` → transition
   phase `play → reveal` (no winner yet; awaiting reveal).

### 3. The tunnel-native protocol

`PixelDuelProtocol implements Protocol<PixelDuelState, PixelDuelMove>` in
`sui-tunnel-ts/src/protocol/pixelDuel.ts`, name/domain `pixel_duel.v1`.

**State** — public-only; secret templates absent until reveal:

```ts
type Phase = "play" | "reveal" | "over";

interface PixelDuelState {
  // ── board + paint/own/lock mechanic (borrowed from pixel_paint.war.v1) ──
  width: number; height: number;             // 48, 40
  canvas: Uint8Array;                         // w*h, 0 empty | 1..16 color
  owner: Uint8Array;                          // w*h, 0 | 1=A | 2=B (last painter)
  paints: Uint8Array;                         // w*h, locks at overwriteLimit
  placed: number; placedA: number; placedB: number;
  ownedA: number; ownedB: number; locked: number;   // O(1) counters
  // ── commit-reveal for the two secret templates ──
  phase: Phase;
  templateCommitA: Uint8Array;                // 32 bytes (ZERO32 sentinel pre-commit)
  templateCommitB: Uint8Array;                // 32 bytes
  revealedA: Uint8Array | null;               // w*h 0/1, set only in reveal→over
  revealedB: Uint8Array | null;
  // ── scoring snapshot (set at terminal; integers, no floats in the hash) ──
  scoreNumA: number; scoreNumB: number;       // hit cells (numerator)
  templateCellsA: number; templateCellsB: number; // denominators (revealed)
  // ── config + settlement ──
  cap: number; overwriteLimit: number;
  winner: 0 | 1 | 2 | 3;                       // 0 none | 1 A | 2 B | 3 draw
  balanceA: bigint; balanceB: bigint; total: bigint; stake: bigint;
}
```

**Move** — exactly two shapes (`commit` is folded into `initialState` for the
vs-bot driver; PvP adds it as an explicit pre-play move — see §6):

```ts
type PixelDuelMove =
  | { kind: "paint"; x: number; y: number; color: number }  // color 1..16
  | { kind: "reveal"; template: Uint8Array; salt: Uint8Array };  // w*h 0/1, salt>=16B
```

**applyMove(state, move, by)** — pure, throws on illegal:

```
phase "play" && kind "paint":
  reject if winner !== 0, x/y OOB, color ∉ 1..16, or paints[idx] >= overwriteLimit
  paint cell; update owner; paints[idx]++; maintain ownedA/ownedB/locked
  if placed+1 >= cap || locked === w*h:  phase := "reveal"   // no winner yet
  return next                                                // balances unchanged

phase "reveal" && kind "reveal":
  verifyCommitment(by==="A" ? templateCommitA : templateCommitB,
                   move.template, move.salt)  // throws on mismatch → dispute path
  validate layout: length === w*h, every byte ∈ {0,1},
                   templateCells within [minCells,maxCells]   // soft legality
  store revealed{A|B} := move.template
  if BOTH revealed:
    scoreNum{A} = #{ i : canvas[i]===COLOR_A(14) && revealedA[i]===1 }
    scoreNum{B} = #{ i : canvas[i]===COLOR_B(5)  && revealedB[i]===1 }
    // compare AS FRACTIONS via cross-multiplication — integer-only, no float in hash:
    //   scoreA/cellsA  vs  scoreB/cellsB   ⇔   scoreNumA*cellsB  vs  scoreNumB*cellsA
    winner = lhs>rhs ? 1 : rhs>lhs ? 2 : 3
    settle stake loser→winner clamped to loser balance (tic-tac-toe shape)
    phase := "over"
  return next
```

> **Why cross-multiplication, not a float percentage.** The state hash must
> be canonical and byte-identical on both sides; floats / rounding risk
> platform-dependent drift. We keep the numerator (`scoreNum`) and denominator
> (`templateCells`) as **integers** in state and decide the winner by
> `scoreNumA*cellsB ⋛ scoreNumB*cellsA`. The UI may render
> `Math.round(100*num/cells)` for viewers — but that number **never** enters the
> hash.

**encodeState(state)** — canonical, fixed-width + length-prefixed; templates enter
the encoding **only after reveal**, so during play both clients hash identically
regardless of their hidden templates:

```
protocolDomain("pixel_duel.v1")
‖ u64be(width) ‖ u64be(height)
‖ canvas ‖ owner ‖ paints                    // three w*h byte runs
‖ u64be(placed) ‖ u64be(placedA) ‖ u64be(placedB)
‖ u64be(ownedA) ‖ u64be(ownedB) ‖ u64be(locked)
‖ u8(phaseCode) ‖ templateCommitA ‖ templateCommitB   // 32B each
‖ lengthPrefixedConcat([ revealedA ?? ∅, revealedB ?? ∅ ])  // ∅ pre-reveal
‖ u64be(scoreNumA) ‖ u64be(scoreNumB)
‖ u64be(templateCellsA) ‖ u64be(templateCellsB)
‖ u64be(cap) ‖ u8(overwriteLimit) ‖ u8(winner)
‖ u64be(balanceA) ‖ u64be(balanceB) ‖ u64be(stake)
```

`balances(state) = { a: balanceA, b: balanceB }`. `isTerminal(state) = winner !== 0`.

**Commit hash** uses the upstream primitive `computeCommitment(template, salt)` /
`verifyCommitment(commit, template, salt)` from `sui-tunnel-ts/src/core/commitment.ts`
(byte-identical to `randomness.move`, length-prefixed, `salt >= MIN_SALT_LEN=16`).
We do **not** invent a new hashing scheme.

**No-op / determinism proof.** Every `paint` increments `paints[idx]` (or is
rejected), so `canvas`/`paints` change and `encodeState` strictly differs — no
no-op state is reachable, and the finite `cap` (or full lock) guarantees terminal.
`reveal` is a pure verify-then-score, identical on both parties once both hold the
same verified templates. Replay/nonce ordering is the tunnel's job (Protocol.ts
contract), not the protocol's.

### 4. The self-imposed cooldown + miss penalty (CLIENT-side)

A 1.5s cooldown between moves, and a **3s penalty** for painting a
*wasted* cell (not your template, not an opponent cell), **cannot** live in the
protocol — and *should not* — for two reasons:

1. **The protocol can't see the secret template**, so it *cannot* know whether a
   move is "wasted" pre-reveal. Enforcing the penalty in-protocol would force the
   template to be exposed — contradicting the whole design.
2. **The penalty only hurts the offender.** A wasted paint scores for nobody (see
   the box in §1); adding a time penalty only slows *you* down. Because the
   incentive is already self-aligning, no protocol coercion is needed — this is a
   **client-side tactical parameter**, like bot speed or move-selection heuristics,
   not a consensus rule.

Cooldown/penalty are therefore about *pacing*, not *settlement correctness*. They
shape "watchable" play (one window = one game at a legible pace —
ARCHITECTURE.md's "multi-window activity wall") and give competing AI bots a
strategy space, but they **never** affect the co-signed bytes.

### 5. Settlement reuses the GENERIC tunnel — no new Move module

As in ADR 0003 / 0007 / 0008 / 0009: **no new Move module.** Balances
always sum to `total` (the stake shifts loser→winner, clamped to the loser's
balance), so the co-signed final state settles **exactly like tic-tac-toe** via the
generic tunnel functions (`update_state` per move; `close_cooperative` /
`close_cooperative_with_root` at close; `raise_dispute` /
`force_close_after_timeout` for disputes). Per `docs/adding-a-tunnel-game.md` a new
game adds only **one** `Protocol<State, Move>` + a frontend package; **the backend
needs just a new `game` string**, and **Move adds nothing** (the tunnel is a
generic 2-party state channel: state_hash + nonce + balances + dual sigs). Closing
is **backend-sponsored** — the frontend signs the co-signed bytes then POSTs;
the backend submits `close_cooperative_with_root` paying gas from its own address
(`docs/frontend-integration.md`; ARCHITECTURE.md: stakes operator-sponsored,
net-neutral when both seats are agents). The on-repo session-channel example
(`feat/super-auto-pets`, commit "on-chain session-channel example") demonstrates
the one-open/one-settle-covers-the-match pattern.

*Alternatives rejected:* a bespoke `pixel_duel.move` settlement/escrow module —
unnecessary (the generic tunnel already settles balances from the co-signed state
hash) and rejected by ADR 0007/0008 as a settlement architecture; a plaintext
"trust the reported %" state — not fair for PvP, and would leak both templates.

### 6. Two modes, both over the tunnel

Only **two** product modes, one `PixelDuelProtocol`:

- **PLAYER vs BOT** — *driver-led self-play* (`OffchainTunnel.selfPlay`, one
  browser holds both ephemeral keys, like blackjack/battleship). The driver holds
  both templates and calls `tunnel.step` for the human's move and the bot's move.
  `randomMove` **cannot** produce a `reveal` (it needs a secret the state lacks),
  so the driver injects the reveal — exactly ADR 0003's "driver-led" caveat.
- **BOT vs BOT** — also self-play, two heuristic bots on the same driver; this is
  the "activity wall" showcase mode and where cooldown/penalty are tuned as
  watch-pacing.

Both **genuinely co-sign** every move and settle over the tunnel; the only
difference is who generates the moves. (Human-vs-human PvP over the relay is
*feasible* on the same protocol — add a public `commit` move before play and swap
to `DistributedTunnel` — but is **out of scope** of the two committed product
modes.)

### 7. Parameters

| Param | Value | Layer | Note |
|---|---|---|---|
| board width | 48 | protocol | `width` |
| board height | 40 | protocol | `height` |
| template cells | ~100 (10×10) | client | `[minCells,maxCells]` soft-checked at reveal |
| colorA | 14 (Sui blue) | client | A's forced color; scoring `canvas===14` |
| colorB | 5 (pink) | client | B's forced color; scoring `canvas===5` |
| overwriteLimit | 3 | protocol | paints before a cell locks |
| cap | ~1200 | protocol | `2 * templateCells * overwriteLimit + slack`; also lock-out terminal |
| guide (memorize) | 5s | client | UI shows template then hides; **not** protocol |
| cooldown | 1.5s | client | self-imposed pacing; **not** protocol |
| miss penalty | 3s | client | wasted-cell pause; self-imposed; **not** protocol |
| salt length | ≥ 16 bytes | protocol | `MIN_SALT_LEN`, enforced by `computeCommitment` |
| stake | 100n (default) | protocol | clamped to loser balance at terminal |

### 8. Dispute / no-reveal path

Three cheat scenarios, all handled by commit-reveal + the tunnel's generic
dispute path (no per-game Move needed):

1. **Dishonest reveal (template ≠ commit).** `verifyCommitment` inside `applyMove`
   throws → the honest party **does not co-sign** → state cannot advance. A cheater
   cannot push state alone (every move needs a dual signature).
2. **Illegal template layout (bytes not 0/1, cell count out of range).**
   `applyMove` validates layout and throws → same refuse-to-co-sign path. (Stricter
   legality — connectedness, expected placement — is deferred; the soft-check
   suffices for the MVP.)
3. **Stalling / refusing to reveal.** After `cap`/lock the cheater goes silent. The
   honest party uses the **tunnel's generic timeout + dispute**
   (`raise_dispute` → `force_close_after_timeout`); the staller is **penalized at
   the framework layer** — the protocol stays uninvolved. This is exactly ADR
   0003's stance: a staller is *penalized*, not *prevented*.

### 9. Test plan

Co-located `pixelDuel.test.ts` next to the protocol, on the SDK's `node:test`
(via `tsx`) runner (CLAUDE.md § Testing). Name tests by behavior.

| Tier | Test | Proves |
|---|---|---|
| Unit | `paint locks a cell after overwriteLimit and rejects further paint` | lock mechanic borrowed from pixelPaint is intact |
| Unit | `every accepted paint strictly changes encodeState` | no-op impossibility (the hash always advances) |
| Unit | `play reaches terminal at cap and at full board lock` | both terminal triggers fire `play→reveal` |
| Unit | `reveal with template not matching commit throws` | commit-reveal binding (verifyCommitment) |
| Unit | `reveal with non-0/1 bytes or out-of-range cell count throws` | layout legality soft-check |
| Unit | `higher coverage % wins; equal fractions draw` | cross-multiplication scoring, tie handling |
| Unit | `wasted cross-color paint scores for neither side` | the §1 monochrome self-harm invariant |
| Unit | `stake shifts loser→winner clamped, draw shifts nothing` | tic-tac-toe settlement shape |
| Invariant | `balanceA + balanceB === total for every reachable state` | conservation (invariant 1 of adding-a-tunnel-game) |
| Integration | `two clients with different secret templates produce identical encodeState during play` | the public-only hash property (no secret leak) |
| Integration | golden byte-parity of `computeCommitment(template,salt)` vs the Move `randomness::create_commitment` fixture | reveal verifies on-chain too (cross-language boundary) |
| E2e | vs-bot + bot-vs-bot self-play runs open→…→reveal→`close_cooperative`, balances settle | both product modes settle end-to-end |
| E2e (dispute) | stalled no-reveal resolves via `raise_dispute`/`force_close_after_timeout` | §8 no-reveal path, framework-level penalty |

### Paint Wall (composition, deferred)

A true "everyone together" r/place experience is **deferred** and, when built,
rides on **composition of 2-party tunnels — never an N-of-N core fork**: each
painter opens a tunnel with a *wall sequencer*; strokes are co-signed 2-party
(attributable, tamper-evident per contribution); the sequencer owns global
ordering and publishes the combined wall. This follows the existing multi-hop
example (`example_multi_party_channel.move`) and needs no core change. We
explicitly **do not** fork `tunnel.move` to N-of-N multisig.

## Consequences

- **Easier.** Pixel Duel ships on the canonical `Protocol<State, Move>` recipe
  with zero framework risk. The paint/own/lock mechanic is borrowed byte-identical
  from `pixel_paint.war.v1`; commit-reveal reuses the existing
  `computeCommitment`/`verifyCommitment` (already golden-parity with
  `randomness.move`); settlement is identical to tic-tac-toe over the generic
  tunnel. The game rides the same `Protocol + OffchainTunnel` hot path, getting
  state hashing, strictly-increasing nonce, dual-sign, and replay protection for
  free.
- **Honest trust model.** Every pixel is a real co-signed move between two
  independent keys — consistent with [[0006]].
- **Harder / committed to.** Scoring must use integers + cross-multiplication (no
  floats) to keep the hash canonical. State grows ~2×100 bytes at reveal
  (length-prefixed; `rollingDigest` if O(1) is ever needed). `randomMove`
  **cannot** emit `reveal`, so self-play is **driver-led** and the game is not
  wired into the SDK bulk simulator (as in ADR 0003). The design is 2-player-first:
  if a future product genuinely needs atomic N-party canvas state, that is a new
  ADR superseding this one and a Protocol-v2 effort, not an incremental change.
- **Paint Wall is composition, not consensus.** True single-canvas N-way consensus
  is out of reach without forking the core; the deferred Paint Wall's global
  ordering trusts the sequencer (a Lightning-hub-style coordination point).
  Per-painter contributions stay provable, but the wall's total order is not a
  single N-party signature. We accept this rather than fork the core.
- **Move footprint.** None — the generic tunnel open/deposit/cooperative-close/
  dispute functions suffice; no edits to `sui_tunnel` core or `sui-tunnel-ts`
  core.
- **Explicitly not done.** No protocol-level monochrome enforcement (self-imposed,
  safe); no protocol cooldown/penalty (client pacing); no strict template legality
  at commit (soft-check at reveal; ZK legal-placement deferred as ADR 0003 Tier 2);
  no bespoke Move module; no human-vs-human PvP within the two committed product
  modes; no N-of-N tunnel fork.
