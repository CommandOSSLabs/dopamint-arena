import { test, expect, describe } from "bun:test";
import { deriveMe } from "./pvpIdentity";
import { core } from "sui-tunnel-ts";

describe("deriveMe", () => {
  test("on-chain and off-chain public keys agree for the same seed", () => {
    const seed = core.generateKeyPair().secretKey;
    const me = deriveMe(seed);
    expect(me.coreKey.publicKey).toEqual(me.keypair.getPublicKey().toRawBytes());
    expect(me.address).toBe(me.keypair.getPublicKey().toSuiAddress());
    expect(me.pubkeyHex.length).toBe(64); // 32 bytes hex
  });

  test("the same seed derives a stable identity", () => {
    const seed = core.generateKeyPair().secretKey;
    expect(deriveMe(seed).address).toBe(deriveMe(seed).address);
  });
});
