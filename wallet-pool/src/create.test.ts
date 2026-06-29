import { test } from "node:test";
import assert from "node:assert/strict";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { create } from "./create";
import { unseal } from "./envelope";
import { aadFor, parseBlob } from "./blob";
import { generateKeyPair } from "./crypto";
import { WalletPoolError } from "./errors";
import type { SealedMembers } from "./types";

function memStore() {
  const data = new Map<string, Uint8Array>();
  return {
    read: async (id: string) => data.get(id) ?? null,
    write: async (id: string, b: Uint8Array) => {
      data.set(id, b);
    },
    list: async () => [...data.keys()],
    delete: async (id: string) => {
      data.delete(id);
    },
  };
}

test("create writes a sealed pool with N members + master", async () => {
  const store = memStore();
  const res = await create({
    network: "testnet",
    members: 3,
    master: { generate: true },
    store,
  });
  assert.equal(res.memberCount, 3);
  assert.match(res.walletPoolId, /^wp_/);
  const blob = parseBlob((await store.read(res.walletPoolId))!);
  assert.equal(blob.index.length, 4);
  assert.equal(blob.index.filter((e) => e.role === "master").length, 1);
  assert.equal(blob.index.filter((e) => e.role === "member").length, 3);
  const members = JSON.parse(
    new TextDecoder().decode(
      unseal(blob.crypto, res.accessValue, aadFor(blob)),
    ),
  ) as SealedMembers;
  assert.equal(members.members.length, 3);
});

test("imported master seed lands at correct address", async () => {
  const seed = generateKeyPair().secretKey;
  const expected = Ed25519Keypair.fromSecretKey(seed)
    .getPublicKey()
    .toSuiAddress();
  const store = memStore();
  const res = await create({
    network: "testnet",
    members: 1,
    master: { seed },
    store,
  });
  const blob = parseBlob((await store.read(res.walletPoolId))!);
  assert.equal(blob.index.find((e) => e.role === "master")!.address, expected);
});

test("create with passphrase can be unsealed", async () => {
  const store = memStore();
  const res = await create({
    network: "testnet",
    members: 2,
    master: { generate: true },
    access: { passphrase: "correct horse battery staple" },
    store,
  });
  const blob = parseBlob((await store.read(res.walletPoolId))!);
  assert.equal(blob.crypto.mode, "passphrase");
  const members = JSON.parse(
    new TextDecoder().decode(
      unseal(blob.crypto, res.accessValue, aadFor(blob)),
    ),
  ) as SealedMembers;
  assert.equal(members.members.length, 2);
});

test("create rejects invalid member counts", async () => {
  const store = memStore();
  await assert.rejects(
    () =>
      create({
        network: "testnet",
        members: 0,
        master: { generate: true },
        store,
      }),
    WalletPoolError,
  );
  await assert.rejects(
    () =>
      create({
        network: "testnet",
        members: 10_001,
        master: { generate: true },
        store,
      }),
    WalletPoolError,
  );
  await assert.rejects(
    () =>
      create({
        network: "testnet",
        members: NaN,
        master: { generate: true },
        store,
      }),
    WalletPoolError,
  );
});
