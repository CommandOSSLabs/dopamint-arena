# wallet-pool runbook

Operational guide for creating, funding, using, and managing sealed pools of Sui accounts with the `wallet-pool` package.

## What this runbook covers

- Building the package.
- Creating a pool.
- Funding the master account.
- Distributing coins to pool members.
- Opening a pool and signing transactions with member keys.
- Listing, filtering, and observing wallets.
- Exporting, importing, deleting, and listing pools.
- Running the testnet end-to-end helper.
- Common errors and how to fix them.

## Core concepts

- **Pool file**: one sealed, portable file per pool. It contains a public header/index and an AES-256-GCM payload that holds the master seed and member seeds.
- **`wallet-pool-id`**: public identifier (`wp_…`). It is safe to share, commit, or use in URLs.
- **`wallet-pool-access` / access value**: the secret used to decrypt the payload. Treat it like a private key — store it in a secret manager, never commit it.
- **Master**: ordinal `0`, sealed-only. It is used only by `fund()`. You cannot retrieve the master's keypair through `getMemberKey()`.
- **Members**: ordinal `1..N`, used for signing. A member keypair is returned as a Mysten `Ed25519Keypair`.
- **Store**: the persistence layer. The default store is owner-only at `~/.wallet-pool/` (`0o700` directory, `0o600` files). You can pass any `WalletPoolStore` implementation.

## Prerequisites

- Node.js (see `.nvmrc`).
- pnpm (see `packageManager` in root `package.json`).
- (Optional) The Sui CLI if you want to fund the master from a local keystore instead of a faucet.

## Build the package

```bash
cd wallet-pool
pnpm install
pnpm build       # emits dist/
pnpm typecheck   # optional
pnpm test        # optional; unit tests only
```

## 1. Create a pool

### 1.1 Generated master + generated access value

```ts
import { create, defaultStore } from "wallet-pool";

const store = defaultStore(); // ~/.wallet-pool/

const { walletPoolId, accessValue, network, memberCount } = await create({
  network: "testnet",
  members: 5,
  master: { generate: true },
  store,
});

console.log("public :", walletPoolId);
console.log("secret :", accessValue); // save this in your secret manager
```

`create()` returns the access value **once**. If you lose it, the pool cannot be opened.

### 1.2 Passphrase-protected pool

```ts
const { walletPoolId, accessValue } = await create({
  network: "testnet",
  members: 5,
  master: { generate: true },
  access: { passphrase: "correct horse battery staple" },
  store,
});
```

Passphrase pools use scrypt (`N=16384, r=8, p=1`). The derived scrypt key is cached for the process/session, so repeated `open()`/`fund()` calls only pay the scrypt cost once.

### 1.3 Import an existing master seed

```ts
const masterSeed = new Uint8Array(32); // your 32-byte ed25519 seed
const { walletPoolId, accessValue } = await create({
  network: "testnet",
  members: 5,
  master: { seed: masterSeed },
  store,
});
```

### 1.4 Label a pool

```ts
await create({
  network: "testnet",
  members: 5,
  master: { generate: true },
  label: "arena-bot-pool-1",
  store,
});
```

## 2. Find the master address

You need the master address to fund it from an exchange, the Sui CLI, or a faucet.

```ts
import { parseBlob } from "wallet-pool";

const bytes = await store.read(walletPoolId);
if (!bytes) throw new Error("pool not found");
const blob = parseBlob(bytes);
const master = blob.index.find((e) => e.role === "master");
console.log("master address:", master?.address);
```

## 3. Fund the master

The master must hold enough SUI to pay for `fund()` transactions.

### 3.1 Fund from the Sui CLI

```bash
sui client transfer-sui \
  --to <MASTER_ADDRESS> \
  --sui-coin-object-id <YOUR_GAS_COIN_ID> \
  --amount 1000000000 \
  --gas-budget 5000000
```

Amounts are in MIST. `1000000000` = 1 SUI.

### 3.2 Fund from the testnet faucet

```bash
curl -X POST https://faucet.testnet.sui.io/gas \
  -H "Content-Type: application/json" \
  -d '{"FixedAmountRequest":{"recipient":"<MASTER_ADDRESS>"}}'
```

Faucet delivery can take 30–120 seconds and may be rate-limited.

## 4. Fund pool members

`fund()` reads the pool, decrypts the master, builds one PTB, and transfers the requested amount to each enabled member.

### 4.1 Fund all members with SUI

```ts
import { fund } from "wallet-pool";

const { digest } = await fund({
  store,
  walletPoolId,
  accessValue,
  network: "testnet",
  amount: 100_000_000n, // 0.1 SUI per member, in MIST
});
```

The master must hold at least `amount * memberCount + GAS_BUDGET` SUI. `GAS_BUDGET` is `50_000_000` MIST (0.05 SUI headroom).

### 4.2 Fund a subset of members

```ts
await fund({
  store,
  walletPoolId,
  accessValue,
  network: "testnet",
  amount: 100_000_000n,
  to: ["0x<member-A>", "0x<member-B>"],
});
```

Disabled members and non-member addresses are excluded automatically.

### 4.3 Fund with a custom coin type

```ts
await fund({
  store,
  walletPoolId,
  accessValue,
  network: "testnet",
  coinType: "0x1234...::mycoin::MYCOIN",
  amount: 1_000n,
});
```

For non-SUI coins:

- The master must hold a single coin object with balance ≥ `amount * memberCount`.
- The master must still hold at least `GAS_BUDGET` SUI to pay gas.
- If the master only has fragmented coins, merge them first.

### 4.4 Skip waiting for effects

```ts
const { digest } = await fund({
  // ...
  awaitEffects: false,
});
```

When `awaitEffects` is `false`, `fund()` does not update `fundedAmounts`/`lastFundedAt` because it does not wait for the transaction to succeed. Default is `true`.

### 4.5 Use a custom RPC client or URL

```ts
import { getClient } from "wallet-pool";

await fund({
  // ...
  client: getClient("testnet", "https://your.rpc.url"),
  // or
  rpcUrl: "https://your.rpc.url",
});
```

## 5. Open a pool and sign with a member

### 5.1 Open with default caching

```ts
import { open } from "wallet-pool";

const pool = await open({
  store,
  network: "testnet",
  walletPoolId,
  accessValue,
});
```

Default caching (`cache: "default"`) pre-warms an in-memory LRU+TTL cache with all member keypairs. `getMemberKey()` is then a cache lookup after the first call.

### 5.2 Get a member keypair

```ts
const keypair = await pool.getMemberKey(1); // by ordinal
const keypair = await pool.getMemberKey("0x<member-address>"); // by address
```

`getMemberKey()` throws:

- `MasterNotRetrievableError` if you pass the master ordinal/address.
- `AccountDisabledError` if the member is disabled.

Each successful call increments `useCount` and updates `lastUsedAt` on the member entry, persisting the change to the store.

### 5.3 Sign and execute a transaction

```ts
import { Transaction } from "@mysten/sui/transactions";

const tx = new Transaction();
// ... build tx ...

const { digest } = await pool.signAndExecute({
  by: 1,
  transaction: tx,
  awaitEffects: true, // default
});
```

You can also pass your own `SuiClient`:

```ts
await pool.signAndExecute({ by: 1, transaction: tx, client: myClient });
```

### 5.4 Opt out of caching

Use this when you want to minimize key material lifetime in memory.

```ts
const pool = await open({
  store,
  network: "testnet",
  walletPoolId,
  accessValue,
  cache: "none",
});
```

### 5.5 Wipe keys from memory

```ts
pool.wipe();
```

This clears the in-process cache and overwrites the loaded secrets array. It does not delete the pool file.

## 6. Enable or disable a member

This mutates the public index; no access value is required.

```ts
import { setEnabled } from "wallet-pool";

await setEnabled({
  store,
  walletPoolId,
  by: 3, // or member address
  enabled: false,
});
```

Disabled members are excluded from `fund()` and cannot be retrieved with `getMemberKey()`.

## 7. List and filter wallets

### 7.1 Basic list

```ts
import { list } from "wallet-pool";

const members = await list({
  store,
  walletPoolId,
  filter: { role: "member", enabled: true },
});
```

### 7.2 Static filters

```ts
await list({
  store,
  walletPoolId,
  filter: {
    role: "member",
    address: { prefix: "0xabc" },
    ordinalGte: 1,
    ordinalLte: 10,
    label: "vip",
    enabled: true,
    funded: true,
  },
});
```

### 7.3 Live-balance filters

Balance filters require `liveBalances: true` and a `client`.

```ts
import { getClient } from "wallet-pool";

const rows = await list({
  store,
  walletPoolId,
  filter: {
    role: "member",
    nonzero: true,
    sufficientForGas: true,
    balanceGte: { amount: 50_000_000n }, // SUI by default
  },
  liveBalances: true,
  client: getClient("testnet"),
});
```

Other live filters:

- `holdsCoin: "0x123...::mycoin::MYCOIN"` — balance > 0 for that coin.
- `balanceGte: { coinType: "...", amount: 100n }` — custom coin threshold.
- `sufficientForGas: true` — SUI balance ≥ `50_000_000` MIST.

Live filters request only the coin types needed for the filter, not all coin types.

### 7.4 Sort and paginate

```ts
const page = await list({
  store,
  walletPoolId,
  filter: { role: "member" },
  sort: { key: "balance", dir: "desc" },
  pagination: { limit: 10, offset: 0 },
  liveBalances: true,
  client: getClient("testnet"),
});
```

Sort keys: `balance`, `ordinal`, `lastUsedAt`, `fundedAmount`, `address`. Default direction is ascending.

### 7.5 Selection helpers

```ts
import { pick, random, lru, RoundRobin } from "wallet-pool";

const first = pick(rows);
const any = random(rows);
const stalest = lru(rows); // smallest lastUsedAt

const rr = new RoundRobin();
const a = rr.next(rows);
const b = rr.next(rows);
```

## 8. View balances

`viewBalance()` does not need the access value.

```ts
import { viewBalance, getClient } from "wallet-pool";

const balances = await viewBalance({
  store,
  walletPoolId,
  network: "testnet",
  by: "all", // default
  coinType: "0x2::sui::SUI", // default
  client: getClient("testnet"),
});

for (const [address, balance] of balances) {
  console.log(address, balance);
}
```

Other `by` values:

```ts
by: 1; // member ordinal
by: "0x<member-address>"; // member address
```

If the ordinal or address is not in the pool, `viewBalance()` throws `WalletPoolError`.

## 9. Export, import, delete, and list pools

### 9.1 Export a pool

```ts
import { exportPool } from "wallet-pool";

const blobBytes = await exportPool({ store, walletPoolId });
// write to disk, S3, database, etc.
```

The exported bytes are the sealed portable blob. They are inert without the access value.

### 9.2 Import a pool

```ts
import { importPool } from "wallet-pool";

const { walletPoolId } = await importPool({ store, blob: blobBytes });
```

If a pool with the same id already exists, it is overwritten.

### 9.3 List pools

```ts
import { listPools } from "wallet-pool";

const ids = await listPools({ store });
```

### 9.4 Delete a pool

```ts
import { deletePool } from "wallet-pool";

await deletePool({ store, walletPoolId });
```

Deleting a missing pool is idempotent (does not throw).

## 10. Run the testnet end-to-end helper

A helper script is provided at `wallet-pool/scripts/e2e.ts`. It creates a pool, funds the master from your local `sui client` gas, funds the members, opens the pool, lists live balances, and exports/imports the blob.

Requirements:

- `sui` CLI installed and active on `testnet`.
- Your `sui client` keystore has gas.

```bash
cd wallet-pool
npx tsx scripts/e2e.ts
```

The script will pick the first gas coin from `sui client gas` and transfer 1 SUI to the generated master address.

## Security notes

- **Access value is a secret**. It decrypts every member seed. Store it in a secret manager (1Password, AWS Secrets Manager, HashiCorp Vault, etc.). Never log it, commit it, or expose it in an API response.
- **Pool file permissions**: default store creates `~/.wallet-pool/` with mode `0o700` and pool files with `0o600`. If you move a pool file manually, preserve these permissions.
- **Master is sealed-only**: `getMemberKey()` rejects ordinal `0`. The only way to use the master is through `fund()`.
- **Key material lifetime**: `open()` decrypts the payload once and caches member keypairs in memory. Use `cache: "none"` or `pool.wipe()` to reduce lifetime. Note that JavaScript strings and `Uint8Array`s cannot be securely zeroed; this is an inherent runtime limitation.
- **AAD binding**: the AES-GCM AAD is bound to `version:walletPoolId:network`. Tampering with any of these fields causes decryption to fail.

## Troubleshooting

| Symptom                                                             | Cause                                                                                 | Fix                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `WrongAccessValueError`                                             | Access value is wrong, or the pool file was tampered with, or the AAD does not match. | Verify the access value and that you are using the correct `walletPoolId` and `network`.                         |
| `PoolNotFoundError`                                                 | The pool file does not exist in the store.                                            | Check `walletPoolId` and `store` path. Use `listPools()` to see available pools.                                 |
| `InsufficientFundsError`                                            | Master SUI balance is too low for `fund()`.                                           | Fund the master with more SUI. For non-SUI coins, also ensure the master has at least `50_000_000` MIST for gas. |
| `NetworkMismatchError`                                              | The `network` argument does not match the pool's stored network.                      | Pass the same network used in `create()`.                                                                        |
| `AccountDisabledError`                                              | The member is disabled.                                                               | Call `setEnabled(..., enabled: true)` or use a different member.                                                 |
| Faucet never delivers                                               | Testnet faucet is rate-limited or slow.                                               | Use the Sui CLI to transfer SUI from a funded address, or use `scripts/e2e.ts`.                                  |
| Non-SUI fund fails with "no single coin >= ..."                     | The master's coin balance is split across multiple objects.                           | Merge the coins into one object before calling `fund()`.                                                         |
| `list()` throws "balance filters require liveBalances and a client" | You used a balance filter without `liveBalances: true` and a `client`.                | Pass both, or remove the balance filter.                                                                         |

## See also

- `wallet-pool/README.md` — quickstart.
- `wallet-pool/src/index.ts` — public API exports.
- `docs/superpowers/plans/2026-06-29-wallet-pool.md` — implementation plan.
