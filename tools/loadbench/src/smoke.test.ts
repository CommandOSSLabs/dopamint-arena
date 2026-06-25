import { test, expect } from "bun:test";
import { readEnvLocal } from "./env";
import { runFullMatch } from "./runMatch";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

const env = readEnvLocal();
const gated = env.TUNNEL_PACKAGE_ID ? test : test.skip;

gated("blackjack local-channel match opens, plays, and settles on the local stack", async () => {
  process.env.PACKAGE_ID = env.PACKAGE_ID;
  process.env.SUI_NETWORK = env.SUI_NETWORK;
  const client = new SuiClient({ url: env.SUI_RPC_URL || getFullnodeUrl("localnet") });
  const { secretKey } = decodeSuiPrivateKey(env.SUI_SETTLER_KEY);
  const funder = Ed25519Keypair.fromSecretKey(secretKey);
  const r = await runFullMatch("blackjack", "local", "onchain", { client, funder });
  expect(r.moves).toBeGreaterThan(0);
  expect(r.settleMs).toBeGreaterThan(0);
}, 120_000);

test("offchain local-channel match plays with no chain (no stack needed)", async () => {
  const r = await runFullMatch("blackjack", "local", "offchain", {});
  expect(r.moves).toBeGreaterThan(0);
  expect(r.openMs).toBe(0);
  expect(r.settleMs).toBe(0);
});
