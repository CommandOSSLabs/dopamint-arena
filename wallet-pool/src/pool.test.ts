import { test } from "node:test";
import assert from "node:assert/strict";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { SuiClient } from "@mysten/sui/client";
import { open, setEnabled } from "./pool";
import { seal } from "./envelope";
import { aadFor, encodeMembers, serializeBlob } from "./blob";
import {
  generateKeyPair,
  generateAccessValue,
  generateWalletPoolId,
  ed25519Address,
} from "./crypto";
import {
  WrongAccessValueError,
  MasterNotRetrievableError,
  AccountDisabledError,
  PoolNotFoundError,
  NetworkMismatchError,
} from "./errors";
import type { PoolBlob } from "./types";

function memStore(initial: Record<string, Uint8Array> = {}) {
  const data = new Map(Object.entries(initial));
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

function makePool(nMembers: number) {
  const master = generateKeyPair();
  const members = Array.from({ length: nMembers }, (_, i) => ({
    ordinal: i + 1,
    kp: generateKeyPair(),
  }));
  const access = generateAccessValue();
  const id = generateWalletPoolId();
  const index = [
    {
      role: "master" as const,
      address: ed25519Address(master.publicKey),
      ordinal: 0,
      createdAt: 0,
      enabled: true,
      useCount: 0,
      lastUsedAt: 0,
    },
    ...members.map((m) => ({
      role: "member" as const,
      address: ed25519Address(m.kp.publicKey),
      ordinal: m.ordinal,
      createdAt: 0,
      enabled: true,
      useCount: 0,
      lastUsedAt: 0,
    })),
  ];
  const sealed = encodeMembers(
    master.secretKey,
    members.map((m) => ({ ordinal: m.ordinal, secret: m.kp.secretKey })),
  );
  const blob: PoolBlob = {
    version: 1,
    walletPoolId: id,
    network: "testnet",
    createdAt: 0,
    coinTypes: ["0x2::sui::SUI"],
    crypto: seal(
      new TextEncoder().encode(JSON.stringify(sealed)),
      access,
      "generated",
      aadFor({ version: 1, walletPoolId: id, network: "testnet" }),
    ),
    index,
  };
  return { id, access, blob, members };
}

test("open + getMemberKey returns keypair matching address", async () => {
  const { id, access, blob, members } = makePool(2);
  const p = await open({
    store: memStore({ [id]: serializeBlob(blob) }),
    network: "testnet",
    walletPoolId: id,
    accessValue: access,
  });
  const kp = await p.getMemberKey(members[0].ordinal);
  assert.equal(
    kp.getPublicKey().toSuiAddress(),
    ed25519Address(members[0].kp.publicKey),
  );
});

test("getMemberKey rejects master", async () => {
  const { id, access, blob } = makePool(1);
  const p = await open({
    store: memStore({ [id]: serializeBlob(blob) }),
    network: "testnet",
    walletPoolId: id,
    accessValue: access,
  });
  await assert.rejects(() => p.getMemberKey(0), MasterNotRetrievableError);
});

test("getMemberKey rejects disabled account", async () => {
  const { id, access, blob, members } = makePool(1);
  const store = memStore({ [id]: serializeBlob(blob) });
  await setEnabled({
    store,
    walletPoolId: id,
    by: members[0].ordinal,
    enabled: false,
  });
  const p = await open({
    store,
    network: "testnet",
    walletPoolId: id,
    accessValue: access,
  });
  await assert.rejects(
    () => p.getMemberKey(members[0].ordinal),
    AccountDisabledError,
  );
});

test("wrong access value fails to open", async () => {
  const { id, blob } = makePool(1);
  await assert.rejects(
    () =>
      open({
        store: memStore({ [id]: serializeBlob(blob) }),
        network: "testnet",
        walletPoolId: id,
        accessValue: generateAccessValue(),
      }),
    WrongAccessValueError,
  );
});

test("missing pool throws PoolNotFoundError", async () => {
  await assert.rejects(
    () =>
      open({
        store: memStore(),
        network: "testnet",
        walletPoolId: "wp_missing",
        accessValue: generateAccessValue(),
      }),
    PoolNotFoundError,
  );
});

test("signAndExecute uses member signer and awaits effects", async () => {
  const { id, access, blob, members } = makePool(1);
  const p = await open({
    store: memStore({ [id]: serializeBlob(blob) }),
    network: "testnet",
    walletPoolId: id,
    accessValue: access,
  });
  let usedSigner: Ed25519Keypair | undefined;
  let awaitedDigest: string | undefined;
  const fakeClient = {
    signAndExecuteTransaction: async (input: {
      signer: Ed25519Keypair;
      transaction: unknown;
      options: unknown;
    }) => {
      usedSigner = input.signer;
      return { digest: "0xdeadbeef" };
    },
    waitForTransaction: async (input: { digest: string }) => {
      awaitedDigest = input.digest;
    },
  } as unknown as SuiClient;
  const res = await p.signAndExecute({
    by: members[0].ordinal,
    transaction: { kind: "test" },
    client: fakeClient,
    awaitEffects: true,
  });
  assert.equal(res.digest, "0xdeadbeef");
  assert.equal(
    usedSigner?.getPublicKey().toSuiAddress(),
    ed25519Address(members[0].kp.publicKey),
  );
  assert.equal(awaitedDigest, "0xdeadbeef");
});

test("signAndExecute awaits effects by default", async () => {
  const { id, access, blob, members } = makePool(1);
  const p = await open({
    store: memStore({ [id]: serializeBlob(blob) }),
    network: "testnet",
    walletPoolId: id,
    accessValue: access,
  });
  let awaitedDigest: string | undefined;
  const fakeClient = {
    signAndExecuteTransaction: async () => ({ digest: "0xdef" }),
    waitForTransaction: async (input: { digest: string }) => {
      awaitedDigest = input.digest;
    },
  } as unknown as SuiClient;
  await p.signAndExecute({
    by: members[0].ordinal,
    transaction: { kind: "test" },
    client: fakeClient,
  });
  assert.equal(awaitedDigest, "0xdef");
});

test("wipe clears cache and member secrets", async () => {
  const { id, access, blob, members } = makePool(1);
  const p = await open({
    store: memStore({ [id]: serializeBlob(blob) }),
    network: "testnet",
    walletPoolId: id,
    accessValue: access,
  });
  await p.getMemberKey(members[0].ordinal);
  p.wipe();
  await assert.rejects(
    () => p.getMemberKey(members[0].ordinal),
    /member secret missing/,
  );
});

test("network mismatch throws NetworkMismatchError", async () => {
  const { id, access, blob } = makePool(1);
  await assert.rejects(
    () =>
      open({
        store: memStore({ [id]: serializeBlob(blob) }),
        network: "mainnet",
        walletPoolId: id,
        accessValue: access,
      }),
    NetworkMismatchError,
  );
});
