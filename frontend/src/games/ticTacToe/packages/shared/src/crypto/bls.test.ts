import { describe, expect, it } from "bun:test";
import { sign, verify, publicKeyFromPrivate } from "./bls";
import { utils } from "@noble/bls12-381";
import { toHEX } from "@mysten/bcs";

describe("bls12-381 (min-pk)", () => {
  it("signs and verifies with a generated key", async () => {
    const priv = toHEX(utils.randomPrivateKey());
    const pub = publicKeyFromPrivate(priv);
    const msg = "abcdef01";
    const sig = await sign(msg, priv);
    expect(await verify(pub, msg, sig)).toBe(true);
  });

  it("rejects a tampered message", async () => {
    const priv = toHEX(utils.randomPrivateKey());
    const pub = publicKeyFromPrivate(priv);
    const sig = await sign("abcdef01", priv);
    expect(await verify(pub, "abcdef00", sig)).toBe(false);
  });

  it("produces a 48-byte (min-pk) public key", () => {
    const pub = publicKeyFromPrivate(toHEX(utils.randomPrivateKey()));
    expect(pub.length).toBe(96); // 48 bytes hex
  });
});
