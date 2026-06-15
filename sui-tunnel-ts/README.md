# Sui Tunnel TypeScript SDK

TypeScript SDK for interacting with the [Sui Tunnel Framework](../sui_tunnel/) smart contracts. Provides type-safe functions for all example modules including escrow, payment channels, coin flip, rock-paper-scissors, streaming payments, atomic swaps, dutch auctions, and multi-hop payments.

## Installation

```bash
pnpm install
pnpm build
```

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required environment variables:

```env
PACKAGE_ID=0x...             # Your deployed sui_tunnel package ID
SUI_NETWORK=testnet          # Network NAME (not a URL): mainnet, testnet, devnet, localnet
PRIVATE_KEY=suiprivkey1...   # Sui secret key (suiprivkey...) used to sign on-chain transactions
# Example flows also read role-specific keys, e.g. BUYER_PRIVATE_KEY, SELLER_PRIVATE_KEY,
# SENDER_PRIVATE_KEY, PARTY_A_PRIVATE_KEY, PARTY_B_PRIVATE_KEY
```

> Note: the off-chain framework (`core`/`sim`/`agents`/`bench`) needs **no** env vars — it
> generates ephemeral keys and never touches the chain. `PACKAGE_ID`/`PRIVATE_KEY` are only
> needed for the on-chain example flows and the `onchain` lifecycle builders.

## Usage

### Import the SDK

```typescript
import {
  // Escrow
  createEscrow,
  confirmAndRelease,

  // Rock Paper Scissors
  createRPSGame,
  commitMove,
  revealMove,

  // Streaming Payments
  createStream,
  withdraw,

  // Atomic Swaps
  createSwapLock,
  claimSwap,

  // Dutch Auctions
  createAuction,
  buy,

  // Coin Flip
  createCoinFlipGame,

  // Payment Channels
  openChannel,
  closeChannelCooperative,

  // Multi-Hop Payments
  createHTLC,
  claimHTLC,
} from "sui-tunnel-ts";
```

### Example: Escrow Flow

```typescript
import { createEscrow, markDelivered, confirmAndRelease } from "sui-tunnel-ts";

// Buyer creates escrow
const { escrowId } = await createEscrow(
  sellerAddress, // seller address
  "Purchase item", // description
  paymentCoinId, // payment coin object ID
);

// Seller marks as delivered
await markDelivered(escrowId);

// Buyer confirms and releases funds
await confirmAndRelease(escrowId);
```

### Example: Atomic Swap

```typescript
import {
  createSwapLock,
  claimSwap,
  generateSecretAndHash,
} from "sui-tunnel-ts";

// Alice generates a secret
const { secret, hash } = generateSecretAndHash();

// Alice locks funds with hash
const { swapId: aliceSwapId } = await createSwapLock(
  aliceKeypair,
  bobAddress,
  amount,
  hash,
  expiresAt,
);

// Bob locks funds with same hash (shorter timeout)
const { swapId: bobSwapId } = await createSwapLock(
  bobKeypair,
  aliceAddress,
  amount,
  hash,
  expiresAt - buffer,
);

// Alice claims Bob's lock (reveals secret)
await claimSwap(aliceKeypair, bobSwapId, secret);

// Bob uses revealed secret to claim Alice's lock
await claimSwap(bobKeypair, aliceSwapId, secret);
```

## Run All Examples

```bash
pnpm build
pnpm start
```

This runs demonstration flows for all 8 example applications.

## Available Modules

| Module              | Description                                  |
| ------------------- | -------------------------------------------- |
| `escrow`            | Conditional payments with dispute resolution |
| `rockPaperScissors` | Commit-reveal game with fair randomness      |
| `coinFlip`          | Provably fair coin flip game                 |
| `streamingPayment`  | Time-based payment unlocking                 |
| `atomicSwap`        | Trustless cross-party asset exchange         |
| `dutchAuction`      | Descending price sale                        |
| `paymentChannel`    | Bidirectional payment channels               |
| `multiHopPayment`   | Lightning-style HTLC routing                 |

## Types

All Move structs are mirrored as TypeScript interfaces in `src/types.ts`, including:

- `Tunnel`, `PartyConfig`, `StateCommitment` - Core tunnel types
- `Escrow`, `RPSGame`, `CoinFlipGame` - Game/application types
- `PaymentStream`, `SwapLock`, `DutchAuction` - Financial types
- `HTLC`, `Route`, `Hop`, `FeePolicy` - Multi-hop routing types
- `Seed`, `Commitment`, `Reveal` - Randomness types
- `RefereeConfig`, `Dispute`, `Vote` - Dispute resolution types

## High-throughput off-chain framework (1M+ effective TPS)

Beyond the on-chain example wrappers, the SDK includes an experimental framework for driving
**millions of off-chain, dual-signed, mutually-verified tunnel state transitions per second**
("effective TPS"). Opening/closing a tunnel are on-chain transactions; everything between is
off-chain. See [`docs/DESIGN_REVIEW.md`](docs/DESIGN_REVIEW.md),
[`docs/PERFORMANCE_REPORT.md`](docs/PERFORMANCE_REPORT.md), and
[`docs/QUANTUM_POKER.md`](docs/QUANTUM_POKER.md).

Modules (namespaced exports from the package root):

| Namespace   | What                                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`      | byte-exact wire format, sync ed25519 (native + `@noble` backends), commit-reveal, verifiable randomness, the in-memory `OffchainTunnel` engine, bulk keys |
| `protocols` | generic `Protocol<State,Move>` + Payments, Blackjack, TicTacToe, Chat, **Quantum Poker**                                                                  |
| `sim`       | simulator, activity generator, and a multi-core worker `runCluster`                                                                                       |
| `telemetry` | counters + rate reports, JSON/CSV export                                                                                                                  |
| `agents`    | autonomous behavior-typed agents, matchmaking, `AgentSwarm` (open → interact → settle)                                                                    |
| `onchain`   | PTB builders for every tunnel entry point + dispute/timeout recovery, gas sharding, signer pool, live lifecycle                                           |
| `recovery`  | `Watchtower` — auto dispute/force-close for abandoned tunnels                                                                                             |
| `proof`     | transcript accumulator + Merkle root; pluggable storage (local / in-memory / Walrus hooks)                                                                |
| `bench`     | reproducible benchmark harness + report                                                                                                                   |
| `zk`        | card-in-deck Groth16 integration for Quantum Poker fairness (dispute-time)                                                                                |

Correctness is anchored by cross-language golden tests: the off-chain wire format,
commit-reveal hashing, shuffle, and ZK public-input encoding are all proven **byte-identical
to Move** (`sui_tunnel/tests/{wire_format,randomness_xcheck,zk_inputs_xcheck}_tests.move`),
including an on-chain check that an SDK-signed update is accepted by `signature::verify`.

```bash
pnpm test          # 140+ unit + cross-language tests (node:test via tsx)
pnpm typecheck

# end-to-end off-chain demo (no chain needed): agents → telemetry → transcript → settle
node --import tsx src/examples/offchainDemo.ts

# benchmark (Deliverable 10): reproducible, prints peak/avg TPS, sigs/s, bandwidth, settlement %
node --import tsx src/bench/cli.ts --agents 200 --tunnels 1000 --updates-per-tunnel 300
node --import tsx src/bench/cli.ts --tunnels 1000 --updates-per-tunnel 200 \
  --behaviors payment,poker,chat,blackjack,tictactoe --json report.json
```

## License

Apache-2.0
