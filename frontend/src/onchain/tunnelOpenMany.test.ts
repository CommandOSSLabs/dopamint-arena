import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PACKAGE_ID = "0x2";
process.env.SUI_NETWORK = "testnet";

import {
  findAllTunnelIds,
  normalizeSuiAddress,
  readTunnelPartyA,
} from "./tunnelTx.ts";

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
