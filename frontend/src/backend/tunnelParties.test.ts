import { test } from "node:test";
import assert from "node:assert/strict";
import { partiesFromTunnelObject } from "./tunnelParties";

// Shape of SuiClient.getObject({ showContent: true }).data.content for a Tunnel<T>.
const content = {
  dataType: "moveObject",
  fields: {
    party_a: {
      fields: { public_key: [1, 2, 3], signature_type: 0, address: "0xa" },
    },
    party_b: {
      fields: { public_key: [4, 5, 6], signature_type: 0, address: "0xb" },
    },
  },
};

test("partiesFromTunnelObject extracts both ed25519 public keys", () => {
  const p = partiesFromTunnelObject(content);
  assert.deepEqual(Array.from(p.partyA.publicKey), [1, 2, 3]);
  assert.equal(p.partyA.scheme, 0);
  assert.deepEqual(Array.from(p.partyB.publicKey), [4, 5, 6]);
});

test("partiesFromTunnelObject throws on a non-tunnel object", () => {
  assert.throws(() =>
    partiesFromTunnelObject({ dataType: "moveObject", fields: {} }),
  );
});
