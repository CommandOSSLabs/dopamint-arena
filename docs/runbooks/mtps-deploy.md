# MTPS Token Deploy Runbook

Publish the hardened `mtps` coin package (ADR-0015) and bring its metadata online.

The `coin_registry` OTW flow is **two transactions**: `publish` registers the currency object,
and a one-time `finalize_registration` promotes it into the shared registry. Skipping the second
step leaves `admin_mint`/`burn` working but the token's symbol/name/icon **unresolved** in wallets
and explorers.

## Before you begin

> ⚠️ **The deploy key is the mint key.** `AdminCap` is `key`-only and non-transferable: whoever
> signs `publish` receives it and is the *only* address that can ever call `admin_mint`. Publish
> with **the backend faucet's key**, not a personal/CI key. Rotating the key later means a redeploy.

1. Switch the Sui CLI to the target env and confirm the active address is the backend faucet key:
   ```bash
   sui client switch --env testnet
   sui client active-address   # must equal the backend faucet address
   ```
2. Ensure the active address has gas.

## 1. Publish

```bash
cd contracts/mtps
sui client publish --gas-budget 200000000 --json | tee /tmp/mtps-publish.json
```

Capture from the output:

- **`packageId`** — the published package id → `MTPS_PACKAGE_ID`.
- The created **`Currency`** object id (owned by the registry) → `CURRENCY_OBJECT_ID`.
- The created **`AdminCap`** and **`MetadataCap`** object ids (owned by the faucet address).

The coin type is `${MTPS_PACKAGE_ID}::mtps::MTPS`.

## 2. Finalize registration (required, one-time)

Promotes the parked `Currency` into the shared registry so metadata resolves:

```bash
sui client ptb \
  --assign currency @${CURRENCY_OBJECT_ID} \
  --move-call 0x2::coin_registry::finalize_registration "<${MTPS_PACKAGE_ID}::mtps::MTPS>" @0xc currency
```

Verify the metadata (symbol `MTPS`, the favicon icon) now resolves in an explorer or via RPC.

## 3. Update environment ids

Point the apps at the new package (see ADR-0015 follow-ups):

- `VITE_MTPS_*` (frontend)
- `TUNNEL_COIN_TYPE` = `${MTPS_PACKAGE_ID}::mtps::MTPS` (backend/SDK)

## Updating metadata later

The `MetadataCap` is retained (not burned), so symbol/name/description/icon can be changed
post-deploy without a redeploy — sign the relevant `coin_registry` update call with the
`MetadataCap`. Use this to swap the dev favicon for a production-stable icon URL when promoting
beyond testnet.
