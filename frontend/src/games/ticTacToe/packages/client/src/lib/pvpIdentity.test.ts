import { test, expect, describe } from "bun:test";
import { deriveEphemeral } from "./pvpIdentity";
import { core } from "sui-tunnel-ts";

describe("deriveEphemeral", () => {
  test("derives a 32-byte ed25519 signer + hex pubkey from a seed", () => {
    const seed = core.generateKeyPair().secretKey;
    const eph = deriveEphemeral(seed);
    expect(eph.coreKey.publicKey.length).toBe(32);
    expect(eph.coreKey.secretKey.length).toBeGreaterThanOrEqual(32);
    expect(eph.pubkeyHex.length).toBe(64); // 32 bytes hex
  });

  test("the same seed derives the same signer", () => {
    const seed = core.generateKeyPair().secretKey;
    expect(deriveEphemeral(seed).pubkeyHex).toBe(deriveEphemeral(seed).pubkeyHex);
  });
});
