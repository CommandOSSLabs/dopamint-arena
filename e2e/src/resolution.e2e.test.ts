// Regression: the v1-pinned `sui-tunnel-ts` source, loaded under tsx + the
// loader bridge, must resolve `@mysten/sui` to the e2e project's v2 copy, and
// `@mysten/sui/client` must route through the rename shim. Catches a future
// dep bump that reintroduces a v1 leak. No chain, no devstack.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// Exercises @mysten/sui/transactions from inside the SDK.
import { buildCreateAndShare } from 'sui-tunnel-ts/onchain/txbuilders';
// Its module imports the renamed v1 symbols from @mysten/sui/client; importing
// it proves the /client -> shim bridge links.
import { getCreatedObjectIds } from 'sui-tunnel-ts/utils';

test('v2-mirror: v1-pinned SDK resolves @mysten/sui to the e2e v2 copy + /client shim links', () => {
  process.env.PACKAGE_ID ||=
    '0x0000000000000000000000000000000000000000000000000000000000000002';

  const a = new Ed25519Keypair();
  const b = new Ed25519Keypair();
  const tx = new Transaction();
  buildCreateAndShare(tx, {
    partyA: { address: a.toSuiAddress(), publicKey: a.getPublicKey().toRawBytes(), signatureType: 0 },
    partyB: { address: b.toSuiAddress(), publicKey: b.getPublicKey().toRawBytes(), signatureType: 0 },
    timeoutMs: 86_400_000n,
    penaltyAmount: 0n,
  });

  // A tx built by the SDK is an instance of the e2e v2 Transaction class.
  assert.ok(tx instanceof Transaction, 'SDK-built tx is not the e2e v2 Transaction (v1 leak)');
  // The SDK emitted its moveCall against the v2 builder.
  assert.match(tx.serialize(), /entry_create_and_share/);
  // The /client shim linked (else utils.ts could not import getFullnodeUrl/SuiClient).
  assert.equal(typeof getCreatedObjectIds, 'function');
});
