# wallet-pool

Sealed pool of Sui accounts: create, fund (any coin type), list/filter, and sign.

## Quickstart

```ts
import {
  create,
  defaultStore,
  open,
  fund,
  list,
  viewBalance,
  getClient,
} from "wallet-pool";

const store = defaultStore(); // ~/.wallet-pool/

// 1. create a pool of 5 members + a generated master funder
const { walletPoolId, accessValue } = await create({
  network: "testnet",
  members: 5,
  master: { generate: true },
  store,
});
// ⚠️ store `accessValue` somewhere safe — it is shown ONCE.

// 2. (fund the master externally, then) distribute SUI to all members in one tx
await fund({
  store,
  walletPoolId,
  accessValue,
  network: "testnet",
  amount: 100_000_000n,
});

// 3. use a member key (hot path: decrypt-once + cached after open)
const pool = await open({
  store,
  network: "testnet",
  walletPoolId,
  accessValue,
});
const keypair = await pool.getMemberKey(1); // returns an Ed25519Keypair

// 4. observe — no access value needed for balances/listing
await viewBalance({
  store,
  walletPoolId,
  network: "testnet",
  client: getClient("testnet"),
});
await list({ store, walletPoolId, filter: { role: "member", enabled: true } });
```

- `wallet-pool-id` is **public**; `wallet-pool-access` (the access value) is **secret**.
- The master key is sealed-only — consumed solely by `fund()`.
- Default store is owner-only (`~/.wallet-pool/`, `0o700`/`0o600`); pass any `WalletPoolStore` to change it.
