# Quantum Poker Bot Server

Status: in progress
Last updated: 2026-06-17

## Scope

Quantum Poker stays on the generic Sui Tunnel architecture:

- Game rules live in `QuantumPokerProtocol`.
- Each move becomes a canonical `sui_tunnel::state_update`.
- The bot server is a counterparty signer and validator, not a game-specific
  Move adjudicator.
- Happy-path settlement uses `sui_tunnel::tunnel::entry_close_cooperative`.
- Production bot card secrets must be derived from Sui randomness captured during
  the real open/deposit phase, not from local `Math.random` or Web Crypto alone.

This differs from the Blackjack POC. Blackjack signs a custom
`GameActionDataHex` and settles through a custom `black_jack::tunnel`. Quantum
Poker must sign the generic tunnel wire message so it remains compatible with
the shared tunnel package.

## Implementation Phases

### Phase 1: Distributed Signing Core

Extract the signing flow from `OffchainTunnel.step()`:

- prepare a protocol transition from current state + move
- build the canonical `StateUpdate`
- serialize the exact message signed by both parties
- let client and bot sign independently
- verify and assemble a `CoSignedUpdate`

`OffchainTunnel.step()` remains as the self-play wrapper over these helpers.

### Phase 2: Bot Server Skeleton

Create a small Bun/TypeScript server modeled after Blackjack's server shape:

```text
frontend/src/games/quantumPoker/packages/server/
  src/index.ts
  src/router.ts
  src/serverConfig.ts
  src/routes/health.ts
  src/routes/session.ts
  src/routes/open.ts
  src/routes/move.ts
  src/routes/settle.ts
  src/services/botWalletPool.ts
  src/services/sessionStore.ts
  src/services/quantumPokerBot.ts
```

The first server store is in-memory. Persistence moves to Postgres before real
funds are used.

### Phase 3: Session And Move APIs

`POST /api/quantum-poker/session`

- Client sends user address/public key and stake.
- Server allocates a bot wallet.
- Server returns bot party config and initial tunnel/session parameters.

`POST /api/quantum-poker/move`

- Prepare mode: client sends a user move; server validates the transition and
  returns the canonical tunnel `state_update` bytes that the wallet must sign.
- Commit mode: client sends `proposalId + userSignature`; server verifies the
  user signature, signs as bot, stores the update, and returns the latest
  co-signed update.
- Bot-generated moves are blocked until the session has Sui randomness from the
  real open/deposit flow. The server must not substitute local CSPRNG output and
  call it production randomness.

Replay guards:

- reject stale nonces
- reject mismatched state hashes
- reject duplicate nonce with different bytes
- allow idempotent retry for the exact same co-signed update

### Phase 4: Real Tunnel Open And Deposit

Use the root `sui_tunnel::tunnel` package with a configurable gameplay coin:

1. Create tunnel with party A = user and party B = bot.
2. Deposit stake as `$BUCK`/`Coin<T>` where `T = GAME_COIN_TYPE` (for example
   `0x...::test_buck::TEST_BUCK` from the Blackjack POC).
3. SUI is only the transaction gas coin. It must not be treated as the poker
   stake unless `GAME_COIN_TYPE` is explicitly set to `0x2::sui::SUI` for a
   dev-only test.
4. User deposits stake from wallet.
5. Bot server deposits stake with the allocated bot wallet, or via sponsorship.
6. Capture a Sui native randomness seed using the Sui Random object (`0x8`) in
   the same funding/open control plane.
7. Gameplay begins only after the tunnel is activated and the session randomness
   seed is available.

The native Sui Random output is public entropy. It should be mixed with bot
private entropy and tunnel/session context to derive bot slot secrets, then those
secrets are still committed/revealed through `QuantumPokerProtocol`. The game
must keep the existing commit-reveal model because raw public randomness would
reveal hidden cards too early.

Implementation artifacts:

- Move bridge: `sui_tunnel::sui_randomness::entry_emit_quantum_poker_seed`.
- SDK builder: `buildEmitQuantumPokerRandomnessSeed`.
- Tunnel funding extension: `tunnel::create_and_fund` plus SDK
  `buildCreateAndFund` / `buildOpenAndFundMany`.
- Server derivation: `createSuiSeededBotRng`, which mixes the Sui seed with a
  deterministic bot signature and tunnel/session context.

Open funding choices are still explicit:

- bot wallets self-funded
- backend sponsorship
- future user-funded party A + bot-funded party B flow

Current implementation uses the sponsored/demo path:

- `POST /api/quantum-poker/open` uses the allocated bot wallet as funder.
- The PTB selects bot-owned `$BUCK` coin objects by `GAME_COIN_TYPE`, splits two
  stake coins, then calls `tunnel::create_and_fund<GAME_COIN_TYPE>` to create,
  deposit both stakes, and activate the tunnel.
- The bot wallet still pays gas in SUI.
- The same PTB calls
  `sui_randomness::entry_emit_quantum_poker_seed` using the returned tunnel `ID`.
- The server updates the session with the real tunnel object id, resets the
  Quantum Poker state to that tunnel id, and stores the Sui randomness seed.

This is real tunnel open/deposit on-chain, but it is not yet the final
user-funded payment flow. For production, add a second mode where the user funds
party A from their wallet and the bot server funds party B from its wallet.
Bot wallets must hold enough `$BUCK` before using the current sponsored/demo
path.

### Phase 5: Settlement

At terminal state:

- Prepare mode: server returns canonical `sui_tunnel::settlement` bytes for the
  wallet to sign.
- Commit mode: server verifies the user signature, signs as bot, and submits
  `entry_close_cooperative`.
- The current route assumes normal cooperative close where `onchainNonce = 0`
  unless the request explicitly overrides it.

Later work can use `close_cooperative_with_root` and transcript archival.

## Current Status

- [x] Distributed signing helpers extracted
- [x] Distributed signing tests added
- [x] Bot server skeleton added
- [x] Session API added
- [x] Move API prepare/commit added for user moves
- [x] Sui randomness Move bridge and SDK builder added
- [x] Sui-seeded bot RNG derivation added
- [x] Sponsored real open/deposit route stores Sui randomness seed into sessions
- [x] Server open/settle use configurable `$BUCK`/`Coin<T>` stake type instead
      of hard-coded SUI
- [x] Core `sui_tunnel` package deployed on Sui testnet
- [x] Real `/open` smoke verified against deployed tunnel package + BUCK
- [ ] Sui-randomness-backed bot move generation manually verified end-to-end
- [x] Real tunnel open/deposit wired for server-funded demo path
- [ ] User-funded party A + bot-funded party B open/deposit mode added
- [x] Cooperative settlement prepare/commit route wired
- [ ] Settlement route manually verified against a deployed package
- [ ] Persistent store added

## Testnet BUCK Deployment

Deployed on Sui testnet on 2026-06-17 with the active Sui CLI address
`0x80dfb8fb4ecc9a6ae9b2a3dbd1ff9bfd2ff3a1c83b26f86976e18977de925ba7`.

- Test BUCK source:
  `frontend/src/games/quantumPoker/packages/move/test_buck`.
- Package:
  `0xcf5072b41897975f85e09c37b45a2098451704ee4819ef572919980a6dba2ce1`.
- Shared manager:
  `0x07375e26345426909820a636309667eb643cbc8038db53f932df9bc1f44c0c6b`.
- Coin type:
  `0xcf5072b41897975f85e09c37b45a2098451704ee4819ef572919980a6dba2ce1::test_buck::TEST_BUCK`.
- Publish tx:
  `4npjNsEazSARYzGah46DsPBkMjRDukP93PEenyJqhCUS`.

Mint command:

```sh
sui client call \
  --package 0xcf5072b41897975f85e09c37b45a2098451704ee4819ef572919980a6dba2ce1 \
  --module test_buck \
  --function mint \
  --args \
    0x07375e26345426909820a636309667eb643cbc8038db53f932df9bc1f44c0c6b \
    100000000000 \
    <recipient-address> \
  --gas-budget 20000000
```

Already funded:

- Active CLI address received initial supply plus an extra `100000000000` raw
  BUCK. Extra mint tx: `DdSESfSmYwNct3eQdUxJvFsHMjMmwtXL9Bm3LzLvDo8k`.
- Dev bot-0
  `0x7573c697fa68450f04fa0dee2d39dcdc8a5ccf5db547f3e47638a6f8eeeec110`
  received `100000000000` raw BUCK and `100000000` MIST gas. Mint tx:
  `4UhhksTThLwPZ4fUTgs8qXpEDq9qrHXAZzKMRDtZDat9`; SUI transfer tx:
  `GoLDsxyTWk4wfNF918eSgfX2mRNZ7uBg2YHQrmJ5wkry`.

## Testnet Sui Tunnel Deployment

Deployed on Sui testnet on 2026-06-17 with the active Sui CLI address
`0x80dfb8fb4ecc9a6ae9b2a3dbd1ff9bfd2ff3a1c83b26f86976e18977de925ba7`.

- Package:
  `0x3584c81d9e0b24f44fda3e48a745d5b49c354283e39fcfb484a16fdc5d5b5eea`.
- UpgradeCap:
  `0x7458b7d8ad7fae2ca629befb90eb2591730a183b621eeee1c668587b82cf8c42`.
- Publish tx:
  `5FfkYGhZYUTWShJP2S28EKBdHiubhSpf8HL7ByZk7msd`.
- Modules:
  `errors`, `hop`, `quantum_poker`, `quantum_poker_referee`, `randomness`,
  `referee`, `signature`, `sui_randomness`, `tunnel`, `zk_verifier`.

The full repo package with `sources/examples/*` exceeded Sui's package object
limit on testnet (`139489 > 102400` bytes), so the deployed artifact was built
from a temporary package containing only top-level core modules.

Verified real open/deposit smoke:

- Server session:
  `qp-cd2a9f6f-5dc4-4a54-8153-67e35a60d080`.
- Tunnel:
  `0xd7ee315cbb50bc49e3d8bc8b3ab28149433bb7d894386ba7b8dd6f8c1a3da712`.
- Open tx:
  `DRbu5KpMRxwG1B5atXpjn9ZbQywg8TsDqp7sk3HtGpK`.
- On-chain type:
  `Tunnel<0xcf5072b41897975f85e09c37b45a2098451704ee4819ef572919980a6dba2ce1::test_buck::TEST_BUCK>`.
- On-chain state:
  active (`status = 1`), balance `10000`, party deposits `5000/5000`.
- Events observed:
  `TunnelCreated`, two `TunnelDeposit`, `TunnelActivated`,
  `QuantumPokerRandomnessSeed`.

## Progress Log

### 2026-06-17

- Added distributed signing helpers in `sui-tunnel-ts/src/core/tunnel.ts`:
  `prepareProtocolStep`, `signPreparedStep`, `verifyStateUpdateSignature`,
  `verifyPreparedStepSignature`, and `completePreparedStep`.
- Rewired `OffchainTunnel.step()` to use the same helpers, preserving self-play
  behavior while exposing the network-signing path for a bot server.
- Added parity tests proving split client/server signatures produce the same
  `CoSignedUpdate` as local self-play, and reject mismatched party signatures.
- Added the Quantum Poker bot server skeleton under
  `frontend/src/games/quantumPoker/packages/server`.
- Added `GET /api/health` and `POST /api/quantum-poker/session`.
- Added an Ed25519 bot wallet pool, in-memory session store, and dev-key fallback
  gated by `ALLOW_DEV_BOT_KEYS`.
- Verified the server boots with Bun and returns a mock tunnel session with bot
  party config. Real tunnel open/deposit is intentionally not wired yet.
- Added `POST /api/quantum-poker/move` prepare/commit flow for user moves:
  prepare returns canonical `state_update` bytes, commit verifies the user
  signature, bot co-signs, and session state advances.
- Added JSON codecs for `PokerMove`, `StateUpdate`, `CoSignedUpdate`, and public
  state summaries so HTTP responses do not leak bot local secrets or break on
  `BigInt`/`Uint8Array`.
- Blocked bot-generated moves until Sui native randomness is wired through the
  real open/deposit flow.
- Added `sui_tunnel::sui_randomness`, a thin Move bridge around Sui native
  `Random`, to emit Quantum Poker session randomness seed events.
- Added `buildEmitQuantumPokerRandomnessSeed` in the TS on-chain tx builders.
- Added `createSuiSeededBotRng`; once a session stores the Sui seed event, bot
  moves derive private slot secrets from Sui seed + deterministic bot signature
  instead of local RNG.
- Added `tunnel::create_and_fund`, focused Move tests, and SDK builders so one
  PTB can create, fund, activate, and return the tunnel `ID` for composition.
- Added `POST /api/quantum-poker/open`: the bot wallet executes a real
  server-funded open/fund PTB, emits Sui randomness in the same PTB, and stores
  the real tunnel id + seed into the session.
- Added `POST /api/quantum-poker/settle`: prepare returns canonical settlement
  bytes for user signing; commit verifies the user signature, bot co-signs, and
  submits `entry_close_cooperative`.
- Switched the server-funded open/settle path from hard-coded `SUI` stake to
  configurable `GAME_COIN_TYPE`/`COIN_TYPE`, matching the Blackjack `$BUCK`
  pattern. SUI remains the gas coin; `$BUCK` funds the tunnel balances.
- Added and deployed `quantum_poker_test_buck` on testnet, then minted BUCK to
  the active CLI wallet and dev bot-0 for real tunnel smoke testing.
- Published the core `sui_tunnel` package on testnet and configured the bot
  server env example with its package id.
- Smoke-tested `POST /api/quantum-poker/open` against the deployed package; it
  created and activated a BUCK-backed tunnel and emitted Sui randomness in the
  same transaction.
