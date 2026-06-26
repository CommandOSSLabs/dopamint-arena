import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PACKAGE_ID = "0x2";
process.env.SUI_NETWORK = "testnet";

import {
  findAllTunnelIds,
  normalizeSuiAddress,
  openAndFundMany,
  readTunnelPartyA,
} from "./tunnelTx.ts";
import { Transaction } from "@mysten/sui/transactions";

const COIN = "0xabc::mtps::MTPS";

test("findAllTunnelIds returns every created Tunnel object id, skips others", () => {
  const changes = [
    { type: "created", objectType: `0xpkg::tunnel::Tunnel<${COIN}>`, objectId: "0xt1" },
    { type: "mutated", objectType: `0xpkg::tunnel::Tunnel<${COIN}>`, objectId: "0xZZZ" },
    { type: "created", objectType: "0x2::coin::Coin", objectId: "0xc1" },
    { type: "created", objectType: `0xpkg::tunnel::Tunnel<${COIN}>`, objectId: "0xt2" },
  ];
  assert.deepEqual(findAllTunnelIds(changes), ["0xt1", "0xt2"]);
});

test("findAllTunnelIds tolerates non-array input", () => {
  assert.deepEqual(findAllTunnelIds(undefined), []);
});

test("normalizeSuiAddress lower-cases and 0x-pads to 32 bytes", () => {
  assert.equal(normalizeSuiAddress("0xAB"), "0x" + "ab".padStart(64, "0"));
  assert.equal(
    normalizeSuiAddress("CD".padStart(64, "0")),
    "0x" + "cd".padStart(64, "0"),
  );
});

test("readTunnelPartyA reads party_a.address from object content", async () => {
  const reads = {
    waitForTransaction: async () => {},
    getTransactionBlock: async () => ({}),
    getObject: async (input: { id: string }) => ({
      data: {
        content: {
          fields: {
            party_a: { fields: { address: "0xAA" } },
            party_b: { fields: { address: "0xBB" } },
          },
        },
      },
    }),
  } as unknown as Parameters<typeof readTunnelPartyA>[0];
  assert.equal(await readTunnelPartyA(reads, "0xt1"), "0xAA");
});

const party = (address: string) => ({ address, publicKey: new Uint8Array(32) });

test("openAndFundMany builds ONE tx and maps each tunnel to its party-A", async () => {
  let built: Transaction | null = null;
  let signExecCalls = 0;
  const reads = {
    waitForTransaction: async () => {},
    getTransactionBlock: async () => ({
      // order intentionally shuffled vs the specs to prove correlation isn't positional
      objectChanges: [
        { type: "created", objectType: `0xpkg::tunnel::Tunnel<${COIN}>`, objectId: "0xtB" },
        { type: "created", objectType: `0xpkg::tunnel::Tunnel<${COIN}>`, objectId: "0xtA" },
      ],
    }),
    getObject: async (input: { id: string }) => ({
      data: {
        content: {
          fields: {
            party_a: {
              fields: { address: input.id === "0xtA" ? "0xA1" : "0xB1" },
            },
          },
        },
      },
    }),
  } as unknown as Parameters<typeof openAndFundMany>[0]["reads"];

  const map = await openAndFundMany({
    reads,
    signExec: async (tx) => {
      built = tx;
      signExecCalls += 1;
      return { digest: "0xd" };
    },
    coinType: COIN,
    stakeCoinId: "0xstake",
    specs: [
      { partyA: party("0xA1"), partyB: party("0xA2"), aAmount: 10n, bAmount: 20n },
      { partyA: party("0xB1"), partyB: party("0xB2"), aAmount: 30n, bAmount: 40n },
    ],
  });

  assert.equal(signExecCalls, 1, "exactly one signExec (one PTB) for two opens");
  assert.equal(map.get(normalizeSuiAddress("0xA1")), "0xtA");
  assert.equal(map.get(normalizeSuiAddress("0xB1")), "0xtB");
  assert.ok(built, "a transaction was built");
});

test("openAndFundMany throws when created tunnel count != spec count", async () => {
  const reads = {
    waitForTransaction: async () => {},
    getTransactionBlock: async () => ({
      objectChanges: [
        { type: "created", objectType: `0xpkg::tunnel::Tunnel<${COIN}>`, objectId: "0xt1" },
      ],
    }),
    getObject: async () => ({
      data: { content: { fields: { party_a: { fields: { address: "0xA1" } } } } },
    }),
  } as unknown as Parameters<typeof openAndFundMany>[0]["reads"];

  await assert.rejects(
    () =>
      openAndFundMany({
        reads,
        signExec: async () => ({ digest: "0xd" }),
        coinType: COIN,
        stakeCoinId: "0xstake",
        specs: [
          { partyA: party("0xA1"), partyB: party("0xA2"), aAmount: 10n, bAmount: 20n },
          { partyA: party("0xB1"), partyB: party("0xB2"), aAmount: 30n, bAmount: 40n },
        ],
      }),
    /expected 2 tunnels, got 1/,
  );
});
