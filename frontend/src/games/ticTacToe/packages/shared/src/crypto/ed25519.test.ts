import { describe, expect, it } from "bun:test";
import { generateKeypair, sign, verify } from "./ed25519";

describe("ed25519", () => {
  it("generates a keypair and verifies its own signature", async () => {
    const { privateKeyHex, publicKeyHex } = generateKeypair();
    const msg = "deadbeef";
    const sig = await sign(msg, privateKeyHex);
    expect(await verify(publicKeyHex, msg, sig)).toBe(true);
  });

  it("rejects a tampered message", async () => {
    const { privateKeyHex, publicKeyHex } = generateKeypair();
    const sig = await sign("deadbeef", privateKeyHex);
    expect(await verify(publicKeyHex, "deadbee0", sig)).toBe(false);
  });
});
