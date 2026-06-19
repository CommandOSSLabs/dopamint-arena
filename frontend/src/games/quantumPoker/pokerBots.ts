/**
 * Two persistent bot identities for autonomous bot-vs-bot Quantum Poker (AUTO mode).
 *
 * Each bot has a SINGLE ed25519 keypair used both off-chain (the SDK's `KeyPair`, for state
 * co-signing) and on-chain (a `@mysten/sui` `Ed25519Keypair`, for signing the create_and_fund /
 * close txs). We assert the two derivations produce the same public key so the on-chain
 * `PartyConfig.public_key` matches the off-chain signer — the on-chain settlement signature
 * check would otherwise fail.
 *
 * Both bots ARE the on-chain parties (party_a = bot A, party_b = bot B). No wallet sits at a
 * seat, no server: the bots sign their own txs with a standalone SuiClient. Mirrors Blackjack's
 * `bjBots.ts`. Keys persist in localStorage so the connected wallet funds the bots once and the
 * stakes recycle between the two wallets over many games (only gas is spent).
 */
import { keyPairFromSecret, generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex, toHex } from "@mysten/sui/utils";

export interface BotIdentity {
  coreKey: KeyPair;
  keypair: Ed25519Keypair;
  address: string;
  publicKey: Uint8Array;
}

const STORAGE_A = "qp_bot_a";
const STORAGE_B = "qp_bot_b";

function loadOrCreateBot(storageKey: string): BotIdentity {
  let seed: Uint8Array;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(storageKey);
  } catch {
    /* ignore */
  }
  if (stored) {
    seed = fromHex(stored);
  } else {
    seed = generateKeyPair().secretKey; // 32-byte ed25519 seed
    try {
      localStorage.setItem(storageKey, toHex(seed));
    } catch {
      /* ignore */
    }
  }

  const coreKey = keyPairFromSecret(seed);
  const keypair = Ed25519Keypair.fromSecretKey(seed);
  const address = keypair.getPublicKey().toSuiAddress();
  const publicKey = coreKey.publicKey;

  // Same identity on- and off-chain, or the on-chain signature checks fail.
  if (toHex(coreKey.publicKey) !== toHex(keypair.getPublicKey().toRawBytes())) {
    throw new Error("bot off/on-chain pubkey mismatch");
  }

  return { coreKey, keypair, address, publicKey };
}

export function loadOrCreateBots(): { a: BotIdentity; b: BotIdentity } {
  return {
    a: loadOrCreateBot(STORAGE_A),
    b: loadOrCreateBot(STORAGE_B),
  };
}

/** Default top-up per bot when funding from the player's wallet: 0.05 SUI (MIST). */
export const FUND_PER_BOT_MIST = 50_000_000;

/**
 * A single transfer tx that sends `amountMist` SUI from the connected wallet's gas coin to
 * BOTH bot addresses. The player funds the bots once; the keys persist, so it covers many games
 * (stakes recycle between the two wallets at each close, only gas is spent).
 */
export function buildFundTx(
  bots: { a: BotIdentity; b: BotIdentity },
  amountMist: number = FUND_PER_BOT_MIST,
): Transaction {
  const tx = new Transaction();
  const [ca, cb] = tx.splitCoins(tx.gas, [amountMist, amountMist]);
  tx.transferObjects([ca], bots.a.address);
  tx.transferObjects([cb], bots.b.address);
  return tx;
}

/**
 * Move `amountMist` SUI from one bot to the other. The sender bot signs its own transfer
 * (no wallet) — used to rebalance gas when one bot (the one submitting create/close) drains
 * faster than the other during auto-play. Returns the tx digest.
 */
export async function transferBetweenBots(
  client: SuiJsonRpcClient,
  from: BotIdentity,
  to: BotIdentity,
  amountMist: number,
): Promise<string> {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [amountMist]);
  tx.transferObjects([coin], to.address);
  const res = await client.signAndExecuteTransaction({
    signer: from.keypair,
    transaction: tx,
    options: { showEffects: true },
  });
  if (res.effects?.status?.status !== "success") {
    throw new Error(
      `transfer failed: ${res.effects?.status?.error ?? "unknown"}`,
    );
  }
  await client.waitForTransaction({ digest: res.digest });
  return res.digest;
}

let cachedClient: SuiJsonRpcClient | null = null;
export function getSuiClient(): SuiJsonRpcClient {
  if (!cachedClient) {
    const network = (import.meta.env.VITE_SUI_NETWORK_NAME || "testnet") as
      | "testnet"
      | "mainnet"
      | "devnet"
      | "localnet";
    cachedClient = new SuiJsonRpcClient({
      url: getJsonRpcFullnodeUrl(network),
      network,
    });
  }
  return cachedClient;
}

export async function botBalances(
  client: SuiJsonRpcClient,
  bots: { a: BotIdentity; b: BotIdentity },
): Promise<{ a: bigint; b: bigint }> {
  const [ba, bb] = await Promise.all([
    client.getBalance({ owner: bots.a.address }),
    client.getBalance({ owner: bots.b.address }),
  ]);
  return { a: BigInt(ba.totalBalance), b: BigInt(bb.totalBalance) };
}
