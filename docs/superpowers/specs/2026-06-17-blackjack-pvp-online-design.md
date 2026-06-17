# Blackjack PvP (Online) Mode — Design

**Date:** 2026-06-17
**Status:** Approved (design); pending implementation plan
**Scope:** Add a **separate online PvP mode** to the blackjack game where two real people
are matched over the `tunnel-manager` relay and play a blackjack duel through a Sui tunnel.
Each seat is played by its human **or** handed off to that player's bot.

**Grounding:** integration guide `docs/frontend-integration.md`; relay backend
`backend/tunnel-manager` (verified running: connect/queue/match/relay all pass); SDK
`sui-tunnel-ts/src/core/distributedTunnel.ts` (`DistributedTunnel`), `core/tunnel.ts`
(`makeEndpoint`), `onchain/txbuilders.ts` (`buildCreateAndShare` / `buildDepositFromGas` /
`buildCloseFromSettlement`); existing `protocols.BlackjackProtocol` (deterministic dealerless
card stream) as the model for the new duel protocol.

---

## 1. Goal & scope

A new, **independent** blackjack mode — distinct from the existing local self-play modes
(Play vs Dealer, Watch Bot Arena, which use `OffchainTunnel.selfPlay` with no server). The
online mode:

- Connects to the relay server (`tunnel-manager`, `GET /v1/mp`), **quick-matches** two players.
- Both players play a blackjack hand against a **shared deterministic auto-dealer**;
  **head-to-head for one pot** (better result vs the dealer wins; tie-break by hand value;
  exact tie → push).
- Each seat can be **played manually (Hit/Stand) or auto-played by that player's bot** (a
  per-seat toggle, flippable mid-hand), reusing basic strategy.
- Settles **on-chain** (cooperative close); the pot pays out to the winner's wallet.

PvP shares only the underlying tunnel/SDK primitives with self-play; nothing in PvP touches
the self-play path.

> **Revision (2026-06-18):** the on-chain identity changed from a faucet-funded local keypair
> to the **connected Sui wallet** (dapp-kit). The main menu now shows a **Connect Wallet**
> login that gates the game options; PvP funds the stake / receives winnings / signs the
> `party.hello` attestation with that connected wallet (via `useSignAndExecuteTransaction` /
> `useSignPersonalMessage`). The ephemeral move-key is unchanged. (Implemented in
> `Home.tsx`, `usePvpBlackjack.ts`, `bjPvpIdentity.ts` `attestationMessage`, `PvpBlackjack.tsx`.)

### Decisions locked (brainstorming)
- **Game model:** symmetric duel, shared auto-dealer, head-to-head pot (option 1A).
- **On-chain identity:** the **connected Sui wallet** via dapp-kit (option 2B; see the
  Revision above), connected through a main-menu login before playing. The wallet funds the
  stake, receives winnings, and signs the attestation; the ephemeral key still signs moves.
- **Settle:** **client-side cooperative close** (`buildCloseFromSettlement`) — no
  backend-`/settle` + Walrus archival in the first cut.
- **Match granularity:** **one hand per match** (rematch by re-queue). Multi-round is a later
  enhancement.

### Non-goals (first cut)
- Backend `/v1/sessions/{id}/settle` + Walrus archival; watchtower-driven dispute.
- Forfeit/no-show recovery (`raise_dispute` / `force_close` / `withdraw_*`).
- Directed challenges (Quick-Match only). Real dapp-kit wallet signing. Multi-round matches.
- Any change to the relay backend (`backend/**`) or the on-chain Move package — PvP is
  game-side + a small SDK barrel export.

---

## 2. Architecture & match flow

```
both browsers: ws /v1/mp → challenge → connect (ephemeral-key signed nonce)
both: queue.join("blackjack") → match.found {matchId, role A/B, opponentWallet}
both: party.hello {matchId, ephemeralPubkey, walletSig} → each verifies the other's attestation
seat A: buildCreateAndShare(walletA+ephA, walletB+ephB, timeout, penalty=stake)
        → read tunnelId from effects → tunnel.opened{matchId, tunnelId}
each: verify own on-chain seat (my wallet + my ephemeral pubkey, status CREATED)
each: buildDepositFromGas(stake), signed by own wallet key → 2nd deposit ⇒ TunnelActivated
      (detect activation on-chain — match.active is not emitted in v1)
play (DistributedTunnel over relay): A plays its hand (hit/stand), then B plays its hand;
      when B finishes, the protocol resolves the shared dealer (draw-to-17) → terminal
settle: both ephemeral keys co-sign (buildSettlementHalf ↔ relay ↔ combineSettlement)
        → buildCloseFromSettlement on-chain → pot paid to the winner's wallet
```

Components (all game-side in the blackjack client unless noted):
- **Duel protocol** — `BlackjackDuelProtocol` (implements the SDK `Protocol`).
- **Identity** — faucet-funded wallet keypair + per-match ephemeral keypair + attestation.
- **Relay client** — WS handshake, matchmaking, and a `Transport` adapter for the engine.
- **Engine** — SDK `DistributedTunnel` (exposed via a small SDK barrel addition).
- **On-chain** — create/deposit/close PTB builders (reuse `onchain/txbuilders.ts`).
- **Orchestration hook + UI** — `usePvpBlackjack` + a `PvpBlackjack` page (matchmaking → table).

---

## 3. `BlackjackDuelProtocol` (game-side, implements SDK `Protocol<DuelState, DuelMove>`)

Lives in the blackjack client (e.g. `lib/bjDuelProtocol.ts`); does **not** touch SDK core.
Reuses the SDK `BlackjackProtocol`'s deterministic, dealerless card-stream idea so both seats
derive identical cards and their state hashes agree (required for dual-signing).

```ts
type Seat = "A" | "B";
type DuelPhase = "a_turn" | "b_turn" | "over";
type DuelMove = { action: "hit" | "stand" };

interface DuelState {
  dealerHand: number[]; // 2 dealt at start; index 0 is the visible upcard
  handA: number[];
  handB: number[];
  phase: DuelPhase;
  drawCount: number;    // next index into the deterministic card stream
  balanceA: bigint;
  balanceB: bigint;
  wager: bigint;        // the pot stake; == each seat's deposit
}
```

- **Card stream:** `card(seed, index)` is a pure function (e.g. `blake2b(seed ‖ u64be(index))`
  → a card value via the existing `bjCards` mapping). `seed = ctx.tunnelId`. Deterministic and
  identical on both seats. The plan pins the exact byte scheme (matching `handValue`).
- **`initialState(ctx)`:** deal dealer cards at indices 0–1, A at 2–3, B at 4–5; `drawCount=6`;
  `phase="a_turn"`; `balanceA/B = ctx.initialBalances`; `wager = STAKE`.
- **`applyMove(state, {action}, by)`** (pure; throws on illegal move / wrong turn / terminal):
  - `a_turn` (only A): `hit` → draw at `drawCount`, append to `handA`, `drawCount++`; bust
    (`handValue(handA) > 21`) ends A's turn. `stand` ends A's turn. → `b_turn`.
  - `b_turn` (only B): same for `handB`; when B busts or stands, **resolve the dealer in the
    same transition** — draw into `dealerHand` from `drawCount` until `handValue(dealerHand) ≥ 17`
    (dealer stands on 17+), compute the head-to-head outcome, apply the wager swap → `phase="over"`.
- **Head-to-head settle (one pot, A↔B swap, balance-conserving):**
  - `resultVsDealer(hand)`: bust → LOSE; else dealer bust → WIN; else compare to dealer
    (`>` WIN, `<` LOSE, `=` PUSH).
  - `rank = (resultRank: WIN=2, PUSH=1, LOSE=0, then handValue with bust=0)`.
  - Compare A vs B by `resultRank` then `handValue`: higher takes `wager` from the other;
    fully equal → push (no transfer). Loser always covers `wager` (each deposited exactly it).
- **`isTerminal(state)`:** `phase === "over"`.
- **`balances(state)`:** `{ a: balanceA, b: balanceB }` (sums to `2 × STAKE` always).
- **`encodeState(state)`:** `protocolDomain("blackjack.duel.v1") ||
  lengthPrefixedConcat([dealerHand, handA, handB, [phaseByte], u64be(drawCount),
  u64be(balanceA), u64be(balanceB), u64be(wager)])` — deterministic, canonical, distinct
  domain (no collision with `blackjack.v1` or the caro/ttt domains).
- **`randomMove(state, by, rng)`:** basic strategy for the side to move — hit while
  `handValue < 17` (using the dealer upcard for a light basic-strategy refinement), else stand;
  `null` when it isn't `by`'s turn or the game is terminal. Drives the per-seat bot toggle.

**Stake:** a single small constant `STAKE` (e.g. `10_000_000` MIST = 0.01 SUI — tiny on
testnet, gas dominates). Each seat deposits `STAKE`; pot = `2 × STAKE`; winner → `2 × STAKE`,
loser → `0`, push → each keeps `STAKE`.

---

## 4. Identity model (`lib/bjPvpIdentity.ts`)

Two **independent** keys per the integration doc's identity rule (`party = { address: wallet,
publicKey: ephemeral }` — never derive one from the other):

- **Wallet keypair** — a `@mysten/sui` `Ed25519Keypair`, seed persisted in `localStorage`
  (`bj_pvp_wallet`), **faucet-funded** and reused across matches. It is the on-chain identity:
  pays gas, funds the stake, **receives winnings** (`party.address`). Never signs moves.
- **Ephemeral keypair** — a fresh SDK `core.generateKeyPair()` **per match**, persisted in
  **IndexedDB keyed by `matchId`** (with the `tunnelId` once known) so a tab refresh resumes
  the match. It is the **move signer** (every `propose`/co-sign) and the lobby auth signer;
  holds no gas, sends no tx. Key loss is unrecoverable but scoped to the one match (safe).

**Lobby `connect` auth (v1 caveat):** sign the server `challenge.nonce` with the **ephemeral**
key (raw ed25519), send `pubkey = ephemeralPubkeyHex` + `wallet = walletAddress`. (The backend
does a raw-ed25519 verify and does not bind pubkey↔wallet; lobby identity is self-asserted —
the on-chain seat check in §6 is the real security.)

**`party.hello` attestation:** the wallet keypair signs the message `matchId ‖ ephemeralPubkeyHex`
via `keypair.signPersonalMessage(...)` (Sui personal-message format, which embeds the wallet
pubkey). The opponent verifies with `@mysten/sui`'s `verifyPersonalMessage(message, walletSig)`
and asserts the recovered address `=== opponentWallet` (from `match.found`). This is verified
**client-side**, so the §5 raw-vs-intent mismatch does not apply, and it works with the
faucet-local wallet keypair without exchanging the wallet pubkey separately.

---

## 5. Relay client + transport (`lib/bjRelay.ts`)

A thin WS client over `GET ${VITE_MP_URL}/v1/mp` (default `ws://127.0.0.1:8080/v1/mp`).
Externally-tagged JSON on `type` (camelCase fields), exactly matching `mp/protocol.rs`.

- **Handshake:** open → receive `challenge {nonce}` → send `connect {wallet, pubkey, sig,
  nonce}` (sig = ephemeral raw-ed25519 over `nonce` bytes, hex).
- **Matchmaking:** `queue.join {game:"blackjack"}`; handle `match.found {matchId, role,
  opponentWallet, game}`. Implement a **client-side queue timeout** (server `queue.timeout` is
  not emitted in v1).
- **Key exchange:** send/handle `party.hello {matchId, ephemeralPubkey, walletSig}`; verify the
  opponent's attestation (§4).
- **Open announce:** opener sends `tunnel.opened {matchId, tunnelId}`; both store `tunnelId`.
- **Transport adapter** for the engine — maps the engine's opaque `Uint8Array` frames to/from
  the `relay {matchId, payload}` string for this match only:

```ts
function makeRelayTransport(relay, matchId) {
  let onFrame = () => {};
  relay.onRelay(matchId, (payloadStr) => onFrame(new TextEncoder().encode(payloadStr)));
  return {
    send: (frame) => relay.send({ type: "relay", matchId, payload: new TextDecoder().decode(frame) }),
    onFrame: (cb) => { onFrame = cb; },
  };
}
```

- **Error handling:** surface `error {code,message}` (`bad_nonce`, `bad_signature`,
  `not_authenticated`, `target_offline`, `already_connected`, …) to the UI. On disconnect,
  re-`connect` + re-`queue.join`, or resume by `matchId` from IndexedDB; avoid two sockets per
  wallet (a reconnect can evict the newer presence entry).

---

## 6. Engine + on-chain lifecycle

**Engine** (`hooks/usePvpBlackjack.ts`): SDK `DistributedTunnel` over the relay transport.

```ts
const tunnel = new DistributedTunnel(duelProtocol, {
  tunnelId,
  self:     makeEndpoint(defaultBackend(), myWallet, myEphemeralKeyPair, /*controlled*/ true),
  opponent: makeEndpoint(defaultBackend(), oppWallet, { publicKey: oppEphPubkey, scheme: 0 }, false),
  selfParty: role,                 // "A" | "B" from match.found
}, makeRelayTransport(relay, matchId), { a: STAKE, b: STAKE });

tunnel.onConfirmed = (u) => renderTable(tunnel.state);
tunnel.propose({ action }, BigInt(timestamp));  // your turn only; advances on ACK
```
Engine guarantees (relied on): the receiver re-applies + only co-signs when the re-derived
`{stateHash,nonce,balances}` match (illegal/tampered frames never advance state); `propose`
advances only on a valid ACK; `propose` throws off-turn or with a proposal in flight (surface
as UI guards).

**On-chain** (`lib/bjPvpOnchain.ts`, reuse `onchain/txbuilders.ts`; sign with the **wallet**
key; `signatureType = 0`):
- **Open** (seat A): `buildCreateAndShare(tx, { partyA:{walletA, ephPubA, 0}, partyB:{walletB,
  ephPubB, 0}, timeoutMs, penaltyAmount: STAKE })` → read the shared `Tunnel` id from effects →
  `tunnel.opened`.
- **Verify seat** (before deposit, the real security): read the on-chain tunnel; assert my seat
  names my wallet + my ephemeral pubkey and status is `CREATED`.
- **Fund** (each seat funds itself): `buildDepositFromGas(tx, { tunnelId, amount: STAKE })`,
  signed by the seat's own wallet key. The 2nd deposit auto-activates; **detect `TunnelActivated`
  on-chain** (poll the object status / watch the event) — do not await `match.active`.
- **Settle** (cooperative, client-side): on terminal, `buildSettlementHalf(ts)` → exchange the
  half over `relay` → `combineSettlement(...)` → `CoSignedSettlement` →
  `buildCloseFromSettlement(tx, tunnelId, coSigned)` submitted by one seat's wallet. Pot pays to
  each `party.address` per the final balances (winner `2×STAKE`, loser `0`, push `STAKE` each).

---

## 7. Per-seat bot toggle

Each browser controls **only its own seat**. A boolean "Auto (bot)" toggle:
- **On:** whenever it becomes this seat's turn (and not terminal), the hook calls
  `duelProtocol.randomMove(state, mySeat, Math.random)` and `tunnel.propose(move, ts)` after a
  short delay (so the human can watch). Flipping it on mid-hand resumes auto-play from the
  current state.
- **Off:** the human drives `Hit`/`Stand` buttons (enabled only on their turn).
The opponent's seat is driven independently on their side; locally we only render their
confirmed moves via `onConfirmed`. This is the "play yourself or let your bot play for you"
requirement.

---

## 8. SDK exposure (small, intentional)

The client consumes the SDK's compiled `dist`. `core/index.ts` **already** exports
`makeEndpoint` (via `./tunnel`) and `defaultBackend` (via `./crypto-native`) — the **only**
missing symbol is `DistributedTunnel` (its module `./distributedTunnel` is not re-exported).
So the single SDK-source touch is:
- `src/core/index.ts`: add `export * from "./distributedTunnel";` (exposes `DistributedTunnel`
  + its `Settlement`/`CoSignedSettlement`/`Transport` types). `makeEndpoint`/`defaultBackend`
  need no change.
- Rebuild `dist` via `npx tsc` and **verify `dist/core/distributedTunnel.js` is emitted** and
  re-exported by `dist/core/index.js` (the current `dist` predates this and lacks it). `dist`
  is gitignored → no repo churn.
This mirrors how the integration doc already references these symbols and leaves the upstream
files otherwise untouched.

---

## 9. UI (`pages/PvpBlackjack.tsx` + matchmaking subview)

- **Menu entry** on `Home.tsx`: a new **"Play vs Player (online)"** button, alongside the
  existing self-play entries (Play vs Dealer, Watch Bot Arena) — clearly a separate mode.
- **Matchmaking view:** "Connecting…" → "Finding an opponent…" (Quick-Match) with a
  client-side timeout + Cancel/Re-queue. Shows my wallet balance + a Fund (faucet) button if low.
- **Duel table:** reuses the existing `CardDisplay`/table styling. Shows **my hand** + **the
  opponent's hand** (revealed as their confirmed moves arrive) + the **dealer** (upcard during
  play, full hand revealed on resolve); `Hit`/`Stand` buttons (enabled on my turn); the per-seat
  **Auto (bot)** toggle; on-chain step indicators (Open · Fund · Active · Settle) with suiscan
  links; the result banner (You win / You lose / Push) and a **Rematch** (re-queue) button.

**Config:** `VITE_MP_URL` (relay base, default `ws://127.0.0.1:8080`). The relay backend
(`tunnel-manager`) must be running locally for dev (verified: `cargo run -p tunnel-manager`
with in-memory store + dummy `SUI_*`/`WALRUS_*`).

---

## 10. File structure

```
sui-tunnel-ts/src/core/index.ts        # + export DistributedTunnel / makeEndpoint / defaultBackend (+ rebuild dist)

frontend/src/games/blackjack/packages/client/src/
  lib/bjDuelProtocol.ts        # BlackjackDuelProtocol (+ deterministic card stream, basic-strategy randomMove)
  lib/bjPvpIdentity.ts         # wallet keypair (localStorage) + per-match ephemeral key (IndexedDB) + attestation sign/verify
  lib/bjRelay.ts               # /v1/mp WS client: handshake, queue, party.hello, tunnel.opened, relay transport adapter
  lib/bjPvpOnchain.ts          # buildCreateAndShareTx / buildDepositTx / buildCloseTx (wrap onchain/txbuilders)
  hooks/usePvpBlackjack.ts     # orchestrate: connect → match → open/fund/verify → DistributedTunnel play (+ bot toggle) → settle
  pages/PvpBlackjack.tsx       # matchmaking subview + duel table
  pages/Home.tsx               # + "Play vs Player (online)" entry
  (router/App wiring)          # /pvp route
  .env                         # + VITE_MP_URL
```

---

## 11. Testing

- **Unit (`bjDuelProtocol`)** — bun/node test: card-stream determinism (same seed → same cards
  on both seats); turn enforcement (wrong-turn / off-phase / terminal moves throw); dealer
  resolution (draw-to-17); head-to-head outcomes incl. both-bust, both-beat-dealer tie-break,
  exact push; `encodeState` deterministic + distinct from `blackjack.v1`; balance conservation
  (`a+b == 2×STAKE`); basic-strategy `randomMove` (hits below 17, stands at 17+, returns null
  off-turn).
- **Integration (relay, node)** — two simulated clients run a full duel through
  `DistributedTunnel` over the live relay (extends the harness already used to verify the
  backend): connect → match → exchange `party.hello` → drive moves via `propose`/`onConfirmed`
  → both reach the same terminal state and a matching `CoSignedSettlement`. No browser/chain.
- **Manual e2e** — two browser tabs on testnet: Quick-Match, fund both wallets, play a hand
  (one human + one bot, and both-bot), confirm the on-chain open/fund/activate/settle steps and
  the pot paying out to the winner's wallet.

---

## 12. v1 limitations handled
- `match.active` not emitted → detect activation on-chain after both deposits.
- `queue.timeout` not emitted → client-side queue-wait timeout/retry.
- Lobby `pubkey↔wallet` not bound server-side → don't trust presence; the on-chain seat check
  (§6) is the real security; the `party.hello` attestation is the client-side second line.
- Reconnect can evict newer presence → one socket per wallet; resume by `matchId` from IndexedDB.
- Watchtower doesn't auto-submit on-chain → moot for this flat-stake game; no server-side
  dispute reliance.

## 13. Edge cases & risks
- **Opponent disconnects mid-hand:** first cut surfaces a "match interrupted" state and lets the
  player re-queue; funds are safe (pre-activation refund / post-activation the staying player
  can recover later — recovery UI is a follow-up, not in this cut).
- **Both bots on:** the hook still alternates `propose` by turn; the match auto-plays to
  terminal and settles — a useful demo and an integration-test path.
- **Stake vs gas:** `STAKE` is tiny; gas dominates, so the "pot" is symbolic on testnet — fine
  for a first cut.
- **Determinism:** the card stream and `encodeState` must be byte-identical across seats or
  co-signing fails; covered by the determinism unit test and the cross-client integration test.
