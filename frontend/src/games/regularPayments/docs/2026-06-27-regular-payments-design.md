# Regular Payments — Tunnel Mart (VinMart-style grocery checkout)

> **Status:** Approved — **bot-server arena path shipped** (`feat/regular-payments-bot`)  
> **Date:** 2026-06-27  
> **Last updated:** 2026-07-02
> **Scope:** **Regular Payments** — a consumer checkout app in the arena payment workspace.  
> **Package:** `frontend/src/games/regularPayments/`  
> **Register id:** `regular-payments` (retire `micro-payments`)  
> **Does NOT cover:** Agent micropayments (app #2), agent allowance / subscriptions (app #3).

**Coding patterns (styling, props, layout):** [2026-06-28-coding-patterns.md](./2026-06-28-coding-patterns.md)

---

## 0. Design pivot (2026-06-29)

Three decisions supersede parts of the original 2026-06-26 draft. **Do not implement from the
retired sections** (marked below).

| Topic | Original draft | **Current target** |
|-------|----------------|-------------------|
| Checkout payment | Micro-payment **stream on Pay now** | **Each cart pick = off-chain co-signed step**; Pay now **settles only** |
| Engine | `OffchainTunnel.selfPlay` (both keys in browser) | **`DistributedTunnel` + `/v1/mp` relay**; user = seat A, **shop bot = seat B** |
| Lobby CTA | **Go shop** (user opens tunnel) | **Find shop** (matchmaking → bot joins WS) |
| TPS peak | During Pay now stream | During **shopping** (item picks; auto mode batches steps) |
| Who opens tunnel | User wallet at Go shop (self-play) | **Shop bot (seat B) opens** — *provisional; confirm when bot WIP lands* |
| UI / styling | — | **Walrus Memory design system** — `frontend/src/designSystem/`, shadcn/ui, `/design-system` |

**Shipped (2026-07):** `useRegularPaymentsSession` drives **`DistributedTunnel` + `/v1/mp`** against
the colocated fleet shop bot (`regular_payments` / `ShopPosStrategy`). Arena entry uses
`allocateArenaGameForPlay` (ADR-0025/0028) — same pattern as blackjack, bomb-it, etc.

**Retired:** `OffchainTunnel.selfPlay` / `openAndFundSelfPlay` — do not reintroduce.

**IDs (maintainers):** UI registry id = `regular-payments` (hyphen). Backend arena id =
`regular_payments` (underscore) — `profile_for`, `FLEET_COLOCATED_GAMES`, `registerSession`,
`allocateArenaGameForPlay`.

---

## 1. Problem & goals

The arena needs a **payment-first showcase** that reads as everyday commerce (grocery / GoPay-style
checkout), not NFT vending or arcade games. Regular Payments demonstrates:

- **Deposit-first wallet** — shopper locks a budget in a bilateral tunnel.
- **Catalog shopping** — pick items by category; each pick moves value A→B off-chain.
- **High off-chain throughput** — each verified co-signed tunnel step = 1 action (TPS).
- **Minimal on-chain surface** — open + fund + settle only; no per-pick chain txs.

### Goals

| Goal | Detail |
|------|--------|
| Product truth | VinMart / GoPay: connect wallet → find shop → pick items → pay → receipt |
| TPS metering | 1 verified `tunnel.step` / `onConfirmed` = 1 action (heartbeat contract, ADR-0002) |
| Arena consistency | Walrus Memory design system (`frontend/src/designSystem/`, shadcn/ui, `/design-system` showcase) |
| Clean codebase | `regularPayments` package; **do not extend** `microrPayments` (NFT, machine grid) |
| Honest counterparty | Real two-party tunnel vs shop bot over relay (ADR-0020 direction) |

### Non-goals

- NFT mint or gacha rewards
- New Move module deploy — use core `tunnel::Tunnel<T>`
- Subscription / allowance flows (separate apps)
- Merging agent micropayments / allowance into this UI

---

## 2. Core concept

**Tunnel Mart** is a floating arena widget (`workspace: "payment"`, `catalog: true`).

```
Party A  =  Shopper (user wallet + per-match ephemeral key)
Party B  =  Store POS (shop bot — managed key on server fleet)
```

Each shopping trip (target):

1. **Lobby** — **Find shop** → `allocateArenaGameForPlay({ arenaGameId: "regular_payments" })` →
   backend reserves fleet bot + tunnel; shopper deposits seat A (`stake_each` from `profile_for`).
2. **Fund** — fleet pre-opens tunnel and funds seat B; shopper funds seat A in the allocate PTB.
3. **Shop** — each **add to cart** = `payments.v1` step `{ from: "A", amount: catalogPrice }` over relay;
   bot co-signs if valid. **Remove** = B→A refund (bot cooperates — detail TBD in bot WIP).
4. **Pay now** — **settle only** (transcript already contains all payment steps).
5. **Thank you** — receipt; return to lobby.

**Pay now does not run a micro-payment stream.** That flow is retired.

### Catalog

Product list (`PRODUCTS` in `utils/catalog.ts`) is maintained by the team as the shared price
truth for FE + shop bot. Moves must match catalog prices (`verifyMove` on FE; mirror on bot).

---

## 3. Architecture

### 3.1 Layers (target)

| Layer | Responsibility | Target |
|-------|----------------|--------|
| **UI** | Lobby / Shop / Thank you | `components/RegularPayments*` |
| **Hook** | Session lifecycle, screens, telemetry | `useRegularPaymentsSession` |
| **Session core** | Cart math, `verifyMove`, pure helpers | `utils/sessionCore.ts` (+ tests) |
| **Protocol** | Off-chain transitions | `sui-tunnel-ts` **`payments.v1`** |
| **Engine** | Co-signed steps | `DistributedTunnel` + `MpClient` relay transport |
| **Counterparty** | Seat B co-sign | Shop bot (`fleet-serve` / agent kit — WIP) |
| **Open / fund** | On-chain | Bot opens (target) → shopper deposits budget → bot deposits dust |
| **Settle** | Close + transcript | `POST /settle` + `close_cooperative_with_root` fallback |
| **Telemetry** | TPS | `registerSession` + `sendHeartbeat` (`game: "regular_payments"`) |

### 3.2 Retired (self-play — do not restore)

| Layer | Was |
|-------|-----|
| Engine | `OffchainTunnel.selfPlay` |
| Open | `openAndFundSelfPlay` (one wallet, both seats) |
| Cart step | `tunnel.step` with both keys local (~200 TPS; not relay+bot) |

### 3.3 On-chain vs off-chain (target)

| Phase | Chain | Who | Count per trip |
|-------|-------|-----|----------------|
| Find shop | — | User + matchmaking | 0 |
| Open tunnel | On-chain | **Shop bot (B)** — *pending WIP confirm* | 1 create tx |
| Fund shopper | On-chain | User wallet (A) | 1 deposit tx |
| Fund shop dust | On-chain | Bot (B) | 1 deposit tx |
| Add to cart | Off-chain | A proposes → relay → B co-signs | 1 step per pick |
| Remove from cart | Off-chain | B proposes refund → A co-signs | 1 step per remove (TBD) |
| Pay now | On-chain | User `/settle` | 1 close tx |

**Move module:** core `sui_tunnel::tunnel` — not `example_payment_channel.move`.

### 3.4 Economics (defaults)

| Field | Value | Notes |
|-------|-------|-------|
| `depositBudget` (party A) | **500 MTPS** | `DEPOSIT_BUDGET` = `mtps(500)`; matches `REGULAR_PAYMENTS.stake_each` |
| `depositB` (activation dust) | **1** base unit | Shop seat; not shop capital |
| Catalog prices | ~0.01–0.02 MTPS | High step count per full cart |

`TICK_COUNT` / `MICRO_UNIT` / Pay-now stream constants are **retired** for the target flow
(may remain in repo until cleanup).

---

## 4. Screen flow & UI states

### 4.1 Screen machine (target)

```
lobby ──(Find shop, match+open+fund)──► shop ──(Pay now, settle only)──► thankYou ──(3s|Go lobby)──► lobby
  ▲                                    │
  └──────── Back (UI only) ────────────┘
```

| Screen | Purpose |
|--------|---------|
| `lobby` | Intro, **Find shop** (matchmaking + funding) |
| `shop` | Catalog, cart, live budget, TPS during picks |
| `thankYou` | Receipt, **Go lobby**, 3s auto-return |

### 4.2 Lobby (target)

- Title **Tunnel Mart** / Regular Payments
- **Find shop** — disabled until wallet connected
- States: idle → matching → funding → error
- CTA label **Find shop** (`findShop` in hook)

### 4.3 Shop

**Header (`RegularPaymentsShopHeader`)**

- ← **Back** → lobby (**UI only**; no settle)
- Category chips: Fresh | Snacks | Drinks
- Budget remaining (`font-mono`)
- **TPS** chip — rolling 1s window **while picking items** (not Pay now)

**Body (`RegularPaymentsShopBody`)**

- Product grid; tap → add line + off-chain payment step

**Cart (`RegularPaymentsShopCart`)**

- Item count, total, **Pay now** → settle → thank you
- Progress reflects cart / balance moved during shop (not a pay-stream bar)

**Back behavior (locked):** UI-only → lobby; no settle; cart policy unchanged from interim.

### 4.4 Thank you

- Thank-you copy + optional receipt (items, total, settle digest link)
- **Go lobby** + 3s auto-return
- New trip → new Find shop / fresh tunnel

### 4.5 ~~Pay stream UX~~ (retired)

Pay now no longer runs an off-chain stream. Catalog + cart are locked only while `settling`.

---

## 5. Sequence diagrams

### 5.1 Happy path (shipped — arena + fleet)

```mermaid
sequenceDiagram
    participant U as Shopper (A)
    participant BE as Backend arena
    participant WS as /v1/mp relay
    participant Bot as Shop bot (B)
    participant S as Backend /settle

    U->>BE: Find shop — allocateArenaGameForPlay
    BE->>Bot: reserve match + open tunnel (B funded)
    BE->>U: allocation + tunnelId
    U->>BE: deposit seat A (stake_each)
    U->>WS: joinMatch + hello (eph key)
    Bot->>WS: hello (fleet eph key)
    U->>U: shop — pick items
    loop each add to cart
        U->>WS: propose { from: A, amount: catalogPrice }
        WS->>Bot: MOVE
        Bot->>Bot: RegularPayments catalog check
        Bot->>WS: co-sign ACK
        WS->>U: onConfirmed
        Note over U: TPS++ (relay+bot RTT ~15–18/s)
    end
    U->>WS: { t: stop }
    Bot->>WS: settleHalf
    U->>S: Pay now — coSignCloseFromPeerRoot → POST /settle
    S->>S: close_cooperative_with_root
    U->>U: thankYou → lobby
```

**Settle is cooperative close only** — not `endMatch` (poker) and not `isTerminal` for `payments.v1`.

### 5.2 Interim self-play (retire)

```mermaid
sequenceDiagram
    participant U as Shopper UI
    participant OC as OffchainTunnel (selfPlay)

    U->>U: Go shop — openAndFundSelfPlay
    loop each add to cart
        OC->>OC: step A→B (both keys local)
    end
    U->>U: Pay now — settle only
```

### 5.3 Back without pay

```mermaid
sequenceDiagram
    participant U as Shopper UI

    U->>U: shop (tunnel open)
    U->>U: Back → lobby (render only)
    Note over U: No settle.
```

---

## 6. TPS analytics

### 6.1 Unit of work

- **1 action** = 1 verified co-signed step after confirmation
- Heartbeat: throttled `sendHeartbeat` with `actionsDelta`

### 6.2 Registration

```typescript
registerSession({
  userAddress,
  game: "regular_payments", // underscore — backend arena id
  tunnels: [{ tunnelId, partyA, partyB }],
});
```

### 6.3 Display

| Surface | Metric |
|---------|--------|
| Shop header chip | Rolling 1s TPS **during shopping** |
| Telemetry panel | Same heartbeat path as other arena apps |

### 6.4 Throughput (shipped)

- **Lane:** relay + bot (genuine two-party). ~15–18 TPS per pick stream is RTT-limited; ~200 TPS was
  self-play (both keys local) — not comparable.
- **Manual picks:** `AUTO_ADD_INTERVAL_MS` pacing; fly-to-cart every pick.
- **Auto mode (P5):** `AUTO_BURST_BUDGET_MS` time-budget loop + `sleep(0)` between picks — **not**
  `requestAnimationFrame`. Cart/balance UI flushes every `AUTO_UI_BATCH_STEPS` confirms;
  `cartFlyCue` patches every pick for animation. `pickInFlight` gates Pay now.

Constants: `utils/constants.ts`. Session logic: `hooks/useRegularPaymentsSession.ts`.

### 6.5 Future levers

- Browser Web Worker for tunnel client (see `docs/design/frontend-tunnel-client-worker.md` on remote branch)
- Cart remove = B-initiated refund move (stubbed in FE today)
- `fleet-serve` shop bots at scale beyond colocated cap

---

## 7. Protocol & session core

### 7.1 Protocol — `payments.v1`

```typescript
// Per cart add (shopper initiates)
{ from: "A", amount: product.priceMtps }

// Per cart remove (shop initiates — bot cooperates)
{ from: "B", amount: line.priceMtps }
```

Invariants:

- `balanceA + balanceB === total` at every step
- Shopper (A) initiates purchase moves; shop (B) co-signs
- Bot rejects moves that fail protocol + catalog rules (relay is opaque)

### 7.2 Session core (pure)

| Function | Role |
|----------|------|
| `addCartLine` / `removeCartLine` | Cart structure |
| `cartTotal(cart)` | Sum line prices |
| `verifyMove(state, move, catalog)` | Catalog price + balance guards |

Co-locate `sessionCore.test.ts`. Retired: `stepPaymentStream`, `ticksForTotal` for Pay-now stream.

---

## 8. Development principles

See **[2026-06-28-coding-patterns.md](./2026-06-28-coding-patterns.md)**.

---

## 9. On-chain API reference

### Open + fund (target)

Owned by **bot WIP**. Expected shape (provisional):

- Bot (B): `buildCreateAndShare` — registers partyA = shopper, partyB = shop
- Shopper (A): `buildDeposit` — `DEPOSIT_BUDGET`
- Bot (B): `buildDeposit` — `DEPOSIT_B_DUST`

House-opens precedent: blackjack PvP (`usePvpBlackjack` — dealer opens). Final contract = bot WIP.

### Open (interim self-play — retire)

```
openAndFundSelfPlay() → tunnel::create_and_fund_with_id<T>()
```

### Settle (unchanged)

```
buildSettlementWithRoot(createdAt, transcript.root(), 0n)
  → POST /settle (label: "regular-payments")
  → fallback: closeCooperativeWithRoot()
```

### Off-chain (target)

```
new PaymentsProtocol()
DistributedTunnel(..., MpClient transport)
tunnel.propose({ from: "A", amount: priceMtps }, ...)
```

---

## 10. Testing

| Layer | File | Proves |
|-------|------|--------|
| Session core | `utils/sessionCore.test.ts` | Cart, `verifyMove` |
| Catalog | shared `PRODUCTS` | Valid prices / categories |
| Hook | integration after bot WIP | Find shop → pick → settle |
| Protocol | SDK `payments.test.ts` | Conservation |
| Bot kit | `agent/games/regularPayments/kit.test.ts` | A proposes; B never initiates purchases |

---

## 11. Implementation phases

| Phase | Deliverable | Status |
|-------|-------------|--------|
| **P0** | Design doc + `regular-payments` registry | Done |
| **P1** | Types, utils, session core | Done |
| **P2** | Grocery shop UI (lobby / shop / thank you) | Done |
| **P3** | Cart pick = off-chain co-signed step (relay+bot) | Done |
| **P4** | Pay now = cooperative settle (`stop` → `settleHalf`) | Done |
| **P5** | Auto burst TPS + batched UI + shop telemetry | Done |
| **P6** | Fleet bot + `RegularPayments` protocol (Rust) | Done |
| **P7** | Arena FIND SHOP (`DistributedTunnel` + `MpClient`) | Done |
| **P8** | Remove self-play path | Done (retired) |
| **P9** | Cart remove (B refund move) | Planned |

---

## 12. Locked decisions

| Question | Decision |
|----------|----------|
| App id | `regular-payments` |
| Replace micro payments | Yes — grocery checkout, no NFT/machine UX |
| When payment steps run | **On each cart pick** (not Pay now stream) |
| Pay now | **Settle only** |
| Protocol | `payments.v1` |
| Target engine | `DistributedTunnel` + relay (not self-play) |
| Lobby CTA (target) | **Find shop** |
| Shopper seat | **A** |
| Shop bot seat | **B** |
| Who opens tunnel | **Fleet** pre-opens at allocate; shopper funds A |
| Back from shop | UI only → lobby; no settle |
| TPS window | During **shopping** |
| Auto throughput | Time-budget burst + batched UI (`AUTO_UI_BATCH_STEPS`) |
| Pick validation | FE `verifyMove` + Rust `RegularPayments` / `is_catalog_amount` |
| Settle wire | `{ t: "stop" }` → `settleHalf` → `/settle` (label `regular-payments`) |
| Backend scope | Additive: `regular_payments` in `FLEET_COLOCATED_GAMES` + `profile_for` only |
| Theme / components | Walrus Memory design system — per [coding-patterns doc](./2026-06-28-coding-patterns.md) §3 |
| Thank you | 3s auto-return + Go lobby |

### Retired (2026-06-29)

| Question | Old decision |
|----------|--------------|
| Pay now micro-stream | ~~500 ticks / ~5s stream on Pay now~~ |
| Cart as local-only UI | ~~0 tunnel steps until Pay now~~ |
| v1 engine | ~~`OffchainTunnel.selfPlay` as long-term choice~~ |
| v2 relay | ~~Deferred~~ — now target architecture |

---

## 13. Related docs

- [2026-06-28-coding-patterns.md](./2026-06-28-coding-patterns.md) — FE coding standards (design system §3)
- `frontend/src/designSystem/` — token tables (`tokens.ts`), live gallery (`DesignSystemPage.tsx` at `/design-system`)
- `frontend/src/styles/index.css` — global `--wal-*` tokens and `.wal-*` helper classes
- `docs/guide/frontend-integration.md` — `/v1/mp` relay contract
- `backend/docs/decisions/0020-bot-fleet-topology-shared-core.md` — bot fleet direction
- `docs/design/frontend-tunnel-client-worker.md` — browser worker (remote branch; optional later)
- `sui-tunnel-ts/src/protocol/payments.ts` — protocol reference
- ADR-0010 (MTPS), ADR-0007 (settle), ADR-0013 (address balance stake)

---

## 14. Payment app roadmap (context)

Regular Payments is **app #1** of three planned payment-category apps:

| App | Protocol | Co-sign per charge |
|-----|----------|-------------------|
| **Regular Payments** (this) | `payments.v1` | Yes (shopper + shop bot) |
| Agent micropayments | `example_agent_micropayments` | Yes (M2M) |
| Agent allowance | `example_agent_allowance` | No (pull / cap) |

Do not merge these into one UI.

---

## 15. Maintainer quick reference

### Backend (isolated per game — does not change other games' profiles)

| Knob | Value |
|------|-------|
| `profile_for` | `rust/fleet/core/src/play_match.rs` → `REGULAR_PAYMENTS` (`stake_each: 500`) |
| Fleet dispatch | `colocated.rs` → `"regular_payments" => play_regular_payments` |
| Protocol | `rust/protocols/payments/src/regular_payments.rs` + `catalog.rs` |
| Bot strategy | `ShopPosStrategy` — co-signs A moves; never initiates purchases |
| Deploy gate | `FLEET_COLOCATED_GAMES` includes `regular_payments` (`infra/src/components/Backend.ts`) |
| Local dev | `backend/tunnel-manager/.env.example` |

### Frontend entrypoints

| File | Role |
|------|------|
| `hooks/useRegularPaymentsSession.ts` | Session SSoT: arena, tunnel, auto loop, settle |
| `utils/sessionCore.ts` | `verifyMove`, cart math (unit-tested) |
| `utils/catalog.ts` | Price allowlist — must match Rust `catalog.rs` |
| `onchain/arenaPlay.ts` | Shared `allocateArenaGameForPlay` (not game-specific) |

### Per-pick contract

1. `verifyMove(state, { from: "A", amount: product.priceMtps }, PRODUCTS)` on FE.
2. `tunnel.propose(move, moveTs++)` over relay.
3. Bot applies `RegularPayments::apply_move` (catalog price guard on seat A).
4. `onConfirmed` → telemetry + TPS; cart updated in memory (batched in auto burst).

### Settle contract

1. `channel.sendPeer({ t: "stop" })`.
2. Await bot `settleHalf` (`sig` + `transcriptRoot`).
3. `coSignCloseFromPeerRoot` → `settleViaBackend` / `closeCooperativeWithRoot`.
4. **No mock digest.** Errors restore `phase: "shopping"`.

### PR / commit checklist

- Registry id (`regular-payments`) ≠ arena id (`regular_payments`) — both intentional.
- Catalog changes require FE + Rust + agent kit alignment.
- `pnpm exec tsc --noEmit` in `frontend/`; `sessionCore.test.ts` via `tsx`.