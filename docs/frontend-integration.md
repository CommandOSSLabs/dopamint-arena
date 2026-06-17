# Frontend Integration Guide

How `dopamint-web` integrates with the backend (`tunnel-manager`) and the
`sui-tunnel-ts` SDK across **both lanes**. Grounded in the merged code:
- WS protocol → `backend/tunnel-manager/src/mp/protocol.rs`
- Control-plane HTTP → `backend/tunnel-manager/src/routes.rs` (ADR-0002)
- PvP engine → `sui-tunnel-ts/src/core/distributedTunnel.ts`
- On-chain builders → `sui-tunnel-ts/src/onchain/txbuilders.ts`

> All `u64` values that exceed JS safe-integer range (balances, nonce, timestamp)
> travel over the wire as **decimal strings**, and bytes (sigs, hashes) as **hex**.
> JSON field names are **camelCase**.

---

## 1. Two lanes, two responsibilities

| Lane | What the FE does |
|---|---|
| **Self-play** (1M-TPS dashboard) | The FE only **displays stats** — subscribe to the SSE feed. The self-play fleet (headless) produces the moves and pushes heartbeats; the FE does **not** drive moves or call heartbeat. |
| **PvP** (human vs human) | The FE is the **player client**: generate an ephemeral key, connect the matchmaking/relay WebSocket, run the `DistributedTunnel` engine, drive the wallet for open/fund/settle. |

The two are decoupled. Nothing in PvP touches the throughput path.

---

## 2. Stats dashboard (self-play lane) — read-only

Subscribe to Server-Sent Events; render each snapshot.

```
GET /v1/stats/live        → text/event-stream
```

Each event `data:` is a `StatsSnapshot` (camelCase):

```jsonc
{
  "tps": 0,
  "totalActions": 0,
  "activeTunnels": 0,
  "settledTunnels": 0,
  "perGame": { "<gameId>": { "tps": 0, "tunnels": 0, "totalActions": 0 } }
}
```

```ts
const es = new EventSource(`${BACKEND}/v1/stats/live`);
es.onmessage = (e) => renderDashboard(JSON.parse(e.data));
```

That is the entire FE contract for self-play. `POST /v1/sessions`,
`POST /v1/sessions/{id}/heartbeat`, and `POST /v1/sessions/{id}/settle` are called by the
self-play **fleet**, not the browser. (If the FE ever runs a self-play tunnel itself, it
would use those three — see §6 for the settle shape, which PvP shares.)

---

## 3. PvP — the model in one screen

```
 wallet  = on-chain identity  → funds the stake once, receives winnings. Signs rarely.
 ephemeral key = move signer  → per match, browser-held, signs every move (no popup).

 Browser A ── ws /v1/mp ──►  backend (matchmaking + OPAQUE relay + watchtower) ──◄ Browser B
                                         │ never signs a move, never a counterparty
 Sui (tunnel.move, unchanged): create_and_share · deposit (gated) · close_cooperative_with_root
                               raise_dispute_current_state · force_close · withdraw_*
```

**Identity rule (the one trap — do not get this wrong):**
a party is `{ address: walletAddress, publicKey: ephemeralPubkey }`. These are
**independent**. Do **not** derive the party address from the ephemeral key (the SDK's
self-play helpers do `ed25519Address(pubkey)` — the PvP client must NOT). Pass them
separately everywhere.

---

## 4. PvP — ephemeral key custody (per match)

- Generate a **fresh** ephemeral keypair **per match** (`generateKeyPair()` from the SDK's
  `core/crypto`). It is the move signer; it never holds gas, never sends a tx.
- **Persist it in IndexedDB keyed by `matchId`** (alongside the `tunnelId` once known) so a
  tab refresh resumes the match. Use IndexedDB, not `sessionStorage` (which dies on tab close).
- **True key loss** (cleared storage / different device) is unrecoverable but **safe and
  scoped to that one match**: the wallet can still refund pre-activation
  (`withdraw_before_active` / `withdraw_timeout`) or the opponent claims by forfeit. The
  player just re-queues (which mints a new key). No recovery flow is built for v1.

---

## 5. PvP — the matchmaking + relay WebSocket (`GET /v1/mp`)

One WebSocket per player. JSON control messages are externally tagged on a `type` field.

### Client → Server

| `type` | fields | purpose |
|---|---|---|
| `connect` | `wallet, pubkey, sig, nonce` | authenticate (see handshake below) |
| `queue.join` | `game` | Quick-Match |
| `queue.leave` | — | leave the queue |
| `challenge.create` | `targetWallet, game` | directed invite |
| `challenge.accept` | `matchId` | accept an invite |
| `challenge.decline` | `matchId` | decline an invite |
| `party.hello` | `matchId, ephemeralPubkey, walletSig` | exchange wallet-attested ephemeral key |
| `tunnel.opened` | `matchId, tunnelId` | opener announces the shared tunnel |
| `relay` | `matchId, payload` | **opaque** MOVE/ACK frame for the other seat |
| `watchtower.checkpoint` | `matchId, nonce, partyABalance, partyBBalance, stateHash, sigA, sigB` | latest co-signed update for the watchtower |

### Server → Client

| `type` | fields | notes |
|---|---|---|
| `challenge` | `nonce` | sent immediately on connect; sign it |
| `match.found` | `matchId, role, opponentWallet, game` | `role` is `"A"` or `"B"` |
| `challenge.incoming` | `matchId, fromWallet, game` | inbound directed invite |
| `relay` | `matchId, payload` | forwarded opaque frame |
| `error` | `code, message` | see error codes below |
| `queue.timeout` | `matchId` | **defined but not emitted in v1** (timer deferred — don't wait on it) |
| `match.active` | `matchId` | **defined but not emitted in v1** (indexer wiring deferred — detect activation yourself, see §7) |

**Error `code`s the backend can send:** `bad_message`, `bad_nonce`, `bad_signature`,
`not_authenticated`, `target_offline`, `unknown_invite`, `bad_checkpoint`,
`already_connected`.

### Connect handshake

1. Open the socket → server sends `challenge { nonce }`.
2. Reply `connect { wallet, pubkey, sig, nonce }` where `sig` is an **ed25519 signature
   over `nonce` (the UTF-8 bytes) by `pubkey`**, and `nonce` echoes the challenge.
3. On success you are registered in `presence` and may send everything else. Any other
   message before a successful `connect` is rejected with `not_authenticated`.

> **v1 auth caveat (read this).** The backend does a **raw ed25519** verify of `sig` over
> the nonce bytes and does **not** bind `pubkey` to the claimed `wallet`. Browser wallets
> sign personal messages with Sui's **intent-wrapped** scheme (not raw ed25519), so a
> wallet signature will **not** verify here. **For v1, sign the nonce with the ephemeral
> key** (raw ed25519 via the SDK's `sign`), and send the ephemeral pubkey as `pubkey` + the
> wallet address as `wallet`. Real wallet-bound lobby auth is a follow-up (needs server-side
> Sui `verifyPersonalMessage` + the pubkey↔wallet binding). Until then lobby identity is
> **self-asserted** — never treat presence as proof of fund control; the on-chain seat
> check in §7 is the real security.

---

## 6. PvP — wiring the `DistributedTunnel` engine to the relay

The engine is transport-agnostic: it talks to a `Transport { send, onFrame }`. Frames are
opaque `Uint8Array`s (UTF-8 JSON under the hood), so the relay adapter just moves them in
and out of the `relay.payload` string.

```ts
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel"; // path per SDK exports
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";

// Adapter: DistributedTunnel <-> the /v1/mp `relay` messages for ONE match.
function makeRelayTransport(ws: WebSocket, matchId: string) {
  let onFrame: (f: Uint8Array) => void = () => {};
  // Route only this match's inbound relay frames into the engine.
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "relay" && m.matchId === matchId) {
      onFrame(new TextEncoder().encode(m.payload)); // payload is UTF-8 JSON
    }
  });
  return {
    send: (frame: Uint8Array) =>
      ws.send(JSON.stringify({
        type: "relay",
        matchId,
        payload: new TextDecoder().decode(frame),
      })),
    onFrame: (cb: (f: Uint8Array) => void) => { onFrame = cb; },
  };
}

const cryptoBackend = defaultBackend();
const tunnel = new DistributedTunnel(
  protocol,                            // your game's TS Protocol<State, Move>
  {
    tunnelId,                          // from `tunnel.opened`
    self:     makeEndpoint(cryptoBackend, myWalletAddress, myEphemeralKeyPair, /*controlled*/ true),
    opponent: makeEndpoint(cryptoBackend, opponentWalletAddress, { publicKey: opponentEphemeralPubkey, scheme: 0 }, /*controlled*/ false),
    selfParty: role,                   // "A" or "B" from `match.found`
    // moveCodec: optional; default identity codec works when Move is a JSON-native value
  },
  makeRelayTransport(ws, matchId),
  initialBalances,                     // { a: stakeA, b: stakeB } — must sum to the locked total
);

// Make a move (your turn). The engine signs your half, emits a MOVE; state advances on ACK.
tunnel.propose(move, BigInt(Date.now())); // the proposer chooses the timestamp

// Fired after every confirmed co-signed update — use it to drive UI + (optionally) the watchtower.
tunnel.onConfirmed = (u) => {
  renderBoard(tunnel.state);
  // optional: ws.send(JSON.stringify({ type: "watchtower.checkpoint", matchId, ...fromUpdate(u) }));
};
```

Engine guarantees you can rely on:
- The receiver **re-applies** every move on its own state and signs only if the re-derived
  `{stateHash, nonce, balances}` match the frame — so an illegal/out-of-turn move from the
  other side (or a tampering relay) is rejected, it never advances state.
- Your `propose()` advances **only** after a valid ACK (`onConfirmed` fires).
- `tunnel.propose()` throws if it isn't your turn (your `protocol.applyMove` enforces turn
  order) or if a proposal is already awaiting ACK — surface these as UI guards.

---

## 7. PvP — on-chain lifecycle (wallet side)

Build PTBs with the SDK's `onchain/txbuilders.ts`, sign with the **wallet** (not the
ephemeral key), submit via your wallet adapter. `signatureType` is `0` for ed25519.

### Open (once per match — the opener / seat A, or the arena)
```ts
import { buildCreateAndShare } from "sui-tunnel-ts/onchain/txbuilders";
const tx = new Transaction();
buildCreateAndShare(tx, {
  partyA: { address: walletA, publicKey: ephPubkeyA, signatureType: 0 },
  partyB: { address: walletB, publicKey: ephPubkeyB, signatureType: 0 },
  timeoutMs: TIMEOUT_MS,
  penaltyAmount: STAKE,          // penalty = stake → abandonment forfeits the pot
});
// submit; read the shared Tunnel object id from tx effects → that is `tunnelId`
// then announce: ws.send({ type: "tunnel.opened", matchId, tunnelId })
```
> `create` binds nothing to the sender, so whoever pays the (trivial) create gas is fine.

### Fund (each player funds its OWN seat — gated)
```ts
import { buildDeposit, buildDepositFromGas } from "sui-tunnel-ts/onchain/txbuilders";
const tx = new Transaction();
buildDepositFromGas(tx, { tunnelId, amount: STAKE });   // SUI; or buildDeposit with a Coin<T>
// sender MUST be this player's wallet (deposit is gated to party.address)
```
The **second** deposit auto-activates the tunnel on-chain (`TunnelActivated`).

> **Detect activation yourself in v1** (the server's `match.active` is not emitted yet):
> after both deposits, read the tunnel object's status, or watch for your own deposit + the
> activation event. Don't block on a `match.active` message.

### Before depositing — verify the seat (the real security)
Read the on-chain tunnel and confirm **your** seat names **your** wallet + **your** attested
ephemeral pubkey, status `CREATED`, before you deposit. Combined with the opponent's
`party.hello.walletSig` — the opponent **wallet's** Sui personal-message signature over
`(matchId ‖ ephemeralPubkey)`, which you verify **client-side** with `@mysten/sui`'s
`verifyPersonalMessage` against `opponentWallet` from `match.found` — this is the "second
line of defense" that makes the untrusted relay safe. (This is the one place a real wallet
signature is used and checked in v1; it's verified in the browser, so the raw-vs-intent
mismatch from §5 doesn't apply.)

### Settle — win by play / genuine tie (both co-sign)
Terminal state → both ephemeral keys co-sign the settlement (collect the other half over the
relay), then `POST` it. The backend submits `close_cooperative_with_root` + archives the
transcript to Walrus. Same endpoint self-play uses:
```
POST /v1/sessions/{sessionId}/settle      Authorization: Bearer <statsToken>
{
  "settlement": { "tunnelId", "partyABalance", "partyBBalance", "finalNonce", "timestamp", "transcriptRoot" },  // u64s as strings, root hex
  "sigA": "0x..", "sigB": "0x..",
  "transcript": [ /* the off-chain move log for Walrus */ ]
}
```
Collect the two halves with the engine:
```ts
const half = tunnel.buildSettlementHalf(BigInt(Date.now())); // { settlement, sigSelf }
// exchange halves over relay, then:
const settled = tunnel.combineSettlement(half.settlement, half.sigSelf, otherHalfSig);
// → settled.sigA / settled.sigB / settled.settlement feed the /settle body
```
(`finalNonce = onchainNonce + 1`, default `onchainNonce = 0` for a tunnel that never
checkpointed on-chain — the normal case.)

### Win by forfeit (opponent abandons) — one player, two wallet txs
The staying player claims the pot directly (no backend needed):
```ts
import { buildRaiseDisputeCurrentState, buildForceClose } from "sui-tunnel-ts/onchain/txbuilders";
// tx1: buildRaiseDisputeCurrentState(tx, { tunnelId })   // starts the timeout
// ...wait for the timeout...
// tx2: buildForceClose(tx, { tunnelId })                 // penalty = stake → claimant takes the pot
```
Surface this as a single **"Claim winnings"** button (it costs two wallet txs with a wait
between — set expectations in the UI).

### No-show refund (opponent never funded)
```ts
import { buildWithdrawBeforeActive } from "sui-tunnel-ts/onchain/txbuilders";
// buildWithdrawBeforeActive(tx, { tunnelId, recipient: myWallet })   // other side still zero
// or buildWithdrawTimeout(...) after the created-state timeout
```

---

## 8. End-to-end sequence (Quick Match)

```
both: open ws /v1/mp → challenge → connect (signed nonce)
p1.queue.join(game) ─┐
p2.queue.join(game) ─┴► match.found{role, opponentWallet, game} to both
both: party.hello (wallet-attested ephemeral pubkey) → each verifies the other's attestation
opener: buildCreateAndShare(walletA+ephA, walletB+ephB, timeout, penalty=stake)
        → read tunnelId from effects → tunnel.opened{tunnelId}
each player: verify own on-chain seat (own wallet + own ephemeral pubkey, status CREATED)
p1 wallet: deposit(stake)   p2 wallet: deposit(stake)  → TunnelActivated (detect on-chain)
loop (human-paced):
   mover: tunnel.propose(move, ts) ─relay MOVE► opponent re-applies+co-signs ─relay ACK► onConfirmed
win by play:  both buildSettlementHalf → combine → POST /settle → close + Walrus → winner paid to wallet
genuine tie:  both co-sign the tie state → POST /settle → both refunded
abandonment:  stayer: raise_dispute_current_state → (timeout) → force_close → winner takes the pot
```

---

## 9. Outcomes & UI rules (v1)

- Three outcomes only: **win-by-play**, **win-by-forfeit** (the "Claim winnings" flow), and
  **genuine-refund** (a real tie, or no moves). **No player-facing dispute or draw button.**
- Winnings always land in the player's **real wallet** (the tunnel pays `party.address`).
- The wallet signs **once** in the happy path (the deposit). Moves are popup-free.

---

## 10. Known v1 limitations the FE must account for

| Limitation | FE impact / what to do |
|---|---|
| `pubkey ↔ wallet` binding not enforced server-side | Don't trust lobby presence as identity proof; rely on the on-chain seat check (§7) before depositing. Sign `connect` with the wallet for forward-compat. |
| `match.active` not emitted | Detect tunnel activation on-chain after both deposits; don't await the message. |
| `queue.timeout` not emitted | Implement your own client-side queue-wait timeout/retry UI. |
| Reconnect can evict a newer presence entry | Avoid opening two sockets for one wallet; on reconnect, re-`connect` and re-`queue.join` / resume by `matchId` from IndexedDB. |
| Disconnect doesn't drain the queue | A stale opponent can appear "matched but absent"; give the user a leave/re-queue path. |
| Watchtower captures but does not yet auto-submit on-chain | For a v1 flat-balance game this is moot; don't rely on server-side dispute defense. |
| New PvP game | Needs a new TS `Protocol` + UI and **zero backend change** — the relay is game-agnostic (keyed on the `game` string). |

---

## 11. Quick reference — what the FE calls

| Need | Mechanism |
|---|---|
| Live stats dashboard | `GET /v1/stats/live` (SSE) |
| Find/start a match | `ws /v1/mp`: `connect` → `queue.join` or `challenge.create` |
| Exchange ephemeral keys | `party.hello` (verify the opponent's `walletSig`) |
| Open the tunnel | wallet PTB `buildCreateAndShare` → `tunnel.opened` |
| Fund | wallet PTB `buildDeposit` / `buildDepositFromGas` (own seat) |
| Play | `DistributedTunnel.propose()` ↔ `relay` frames ↔ `onConfirmed` |
| Settle (win/tie) | engine `buildSettlementHalf`/`combineSettlement` → `POST /sessions/{id}/settle` |
| Claim a forfeit | wallet PTB `buildRaiseDisputeCurrentState` → (timeout) → `buildForceClose` |
| Refund a no-show | wallet PTB `buildWithdrawBeforeActive` / `buildWithdrawTimeout` |
