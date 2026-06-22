/**
 * Two persistent on-chain bot identities for autonomous Quantum Poker self-play.
 * Mirrors battleship/ttt: each bot owns ONE ed25519 seed used both off-chain
 * (SDK KeyPair, co-signs tunnel state) and on-chain (@mysten/sui Ed25519Keypair,
 * signs open/close). Keys persist in localStorage so funding once covers many
 * tunnels — stakes are returned at each cooperative close, only gas is spent.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex, toHex } from "@mysten/sui/utils";
import { requestSuiFromFaucetV2, getFaucetHost } from "@mysten/sui/faucet";
import {
  generateKeyPair,
  keyPairFromSecret,
  type KeyPair,
} from "sui-tunnel-ts/core/crypto";

export interface QuantumPokerBot {
  coreKey: KeyPair;
  keypair: Ed25519Keypair;
  address: string;
  publicKey: Uint8Array;
}

/** Below this gas balance (0.02 SUI) a bot can't reliably open another tunnel. */
export const MIN_PLAY_MIST = 20_000_000n;
/** Default top-up per bot when funding from the connected wallet: 0.1 SUI. */
export const FUND_PER_BOT_MIST = 100_000_000;

const STORAGE_A = "quantum_poker_bot_a";
const STORAGE_B = "quantum_poker_bot_b";

export interface BotReadClient {
  getBalance(input: { owner: string }): Promise<{ totalBalance: string }>;
}

function loadOrCreateBot(storageKey: string): QuantumPokerBot {
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
    seed = generateKeyPair().secretKey;
    try {
      localStorage.setItem(storageKey, toHex(seed));
    } catch {
      /* ignore */
    }
  }
  const coreKey = keyPairFromSecret(seed);
  const keypair = Ed25519Keypair.fromSecretKey(seed);
  const address = keypair.getPublicKey().toSuiAddress();
  if (toHex(coreKey.publicKey) !== toHex(keypair.getPublicKey().toRawBytes())) {
    throw new Error("bot off/on-chain pubkey mismatch");
  }
  return { coreKey, keypair, address, publicKey: coreKey.publicKey };
}

export function loadOrCreateQuantumPokerBots(): {
  A: QuantumPokerBot;
  B: QuantumPokerBot;
} {
  return { A: loadOrCreateBot(STORAGE_A), B: loadOrCreateBot(STORAGE_B) };
}

export function buildFundBotsTx(
  bots: { A: QuantumPokerBot; B: QuantumPokerBot },
  perBotMist: number = FUND_PER_BOT_MIST,
): Transaction {
  const tx = new Transaction();
  const [coinA, coinB] = tx.splitCoins(tx.gas, [perBotMist, perBotMist]);
  tx.transferObjects([coinA], bots.A.address);
  tx.transferObjects([coinB], bots.B.address);
  return tx;
}

export async function botBalances(
  client: BotReadClient,
  bots: { A: QuantumPokerBot; B: QuantumPokerBot },
): Promise<{ a: bigint; b: bigint }> {
  const [ba, bb] = await Promise.all([
    client.getBalance({ owner: bots.A.address }),
    client.getBalance({ owner: bots.B.address }),
  ]);
  return { a: BigInt(ba.totalBalance), b: BigInt(bb.totalBalance) };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function faucetStatus(recipient: string): Promise<string> {
  try {
    const res = await requestSuiFromFaucetV2({
      host: getFaucetHost("testnet"),
      recipient,
    });
    return res.status === "Success" ? "ok" : JSON.stringify(res.status);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function fundBotsFromFaucet(
  client: BotReadClient,
  bots: { A: QuantumPokerBot; B: QuantumPokerBot },
): Promise<{ a: string; b: string }> {
  const [a, b] = await Promise.all([
    faucetStatus(bots.A.address),
    faucetStatus(bots.B.address),
  ]);
  for (let i = 0; i < 10; i++) {
    const bal = await botBalances(client, bots);
    if (bal.a >= MIN_PLAY_MIST && bal.b >= MIN_PLAY_MIST) break;
    await wait(1500);
  }
  return { a, b };
}
