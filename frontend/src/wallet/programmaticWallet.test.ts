import { test } from "node:test";
import assert from "node:assert/strict";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { ProgrammaticWallet } from "./programmaticWallet";

// The client is never touched by connect/accounts/feature-surface, so a stub is fine here.
const stubClient = undefined as never;

test("exposes one account matching the injected keypair", () => {
  const kp = new Ed25519Keypair();
  const w = new ProgrammaticWallet(kp, stubClient);
  assert.equal(w.accounts.length, 1);
  assert.equal(w.accounts[0].address, kp.getPublicKey().toSuiAddress());
});

test("connect returns the account without UI", async () => {
  const kp = new Ed25519Keypair();
  const w = new ProgrammaticWallet(kp, stubClient);
  const connect = (
    w.features["standard:connect"] as {
      connect: () => Promise<{ accounts: unknown[] }>;
    }
  ).connect;
  const { accounts } = await connect();
  assert.equal(accounts.length, 1);
});

test("advertises the sui signing features dapp-kit needs", () => {
  const w = new ProgrammaticWallet(new Ed25519Keypair(), stubClient);
  assert.ok(w.features["sui:signTransaction"]);
  assert.ok(w.features["sui:signAndExecuteTransaction"]);
  assert.ok(w.chains.includes("sui:testnet"));
});

// Validates the key encoding the agent config + funding script rely on: keypair.getSecretKey()
// emits a Bech32 `suiprivkey1…` that fromSecretKey round-trips to the same address.
test("secret key round-trips via Bech32 (getSecretKey / fromSecretKey)", () => {
  const kp = new Ed25519Keypair();
  const sk = kp.getSecretKey();
  assert.match(sk, /^suiprivkey1/);
  const back = Ed25519Keypair.fromSecretKey(sk);
  assert.equal(
    back.getPublicKey().toSuiAddress(),
    kp.getPublicKey().toSuiAddress(),
  );
});
