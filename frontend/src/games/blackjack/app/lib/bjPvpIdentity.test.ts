import { test, expect } from "bun:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { attestEphemeral, verifyAttestation } from "./bjPvpIdentity";

test("attestation verifies for the right wallet and matchId, rejects tampering", async () => {
  const wallet = new Ed25519Keypair();
  const addr = wallet.getPublicKey().toSuiAddress();
  const matchId = "match_abc";
  const ephPubHex = "aa".repeat(32);

  const sig = await attestEphemeral(wallet, matchId, ephPubHex);
  expect(await verifyAttestation(matchId, ephPubHex, sig, addr)).toBe(true);
  // wrong matchId / wrong eph / wrong wallet all fail
  expect(await verifyAttestation("other", ephPubHex, sig, addr)).toBe(false);
  expect(await verifyAttestation(matchId, "bb".repeat(32), sig, addr)).toBe(
    false,
  );
  const other = new Ed25519Keypair().getPublicKey().toSuiAddress();
  expect(await verifyAttestation(matchId, ephPubHex, sig, other)).toBe(false);
});
