/**
 * Two persistent on-chain bot identities for autonomous bot-vs-bot Battleship.
 *
 * Mirrors the tic-tac-toe/caro model (`ticTacToe/app/lib/bots.ts`): each bot owns
 * a SINGLE ed25519 keypair used both off-chain (the SDK `KeyPair`, for co-signing
 * tunnel state) and on-chain (a `@mysten/sui` `Ed25519Keypair`, for signing the
 * create/fund/close txs). We assert the two derivations share a public key so the
 * on-chain `PartyConfig.public_key` matches the off-chain signer — the settlement
 * signature check would otherwise fail.
 *
 * The keys persist in localStorage, so funding the bots ONCE covers many matches:
 * stakes are returned at each cooperative close, only gas is spent. No wallet is
 * needed — the bots sign their own txs.
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

export interface BattleshipBot {
  /** Off-chain co-signing key for `OffchainTunnel.selfPlay`. */
  coreKey: KeyPair;
  /** On-chain signer for create/fund/close txs. */
  keypair: Ed25519Keypair;
  address: string;
  publicKey: Uint8Array;
}

/** Below this gas balance (0.02 SUI in MIST) a bot can't reliably open/close another match. */
export const MIN_PLAY_MIST = 20_000_000n;

/** Default top-up per bot when funding from the connected wallet: 0.1 SUI (MIST). */
export const FUND_PER_BOT_MIST = 100_000_000;

const STORAGE_A = "battleship_bot_a";
const STORAGE_B = "battleship_bot_b";

/** Minimal client surface used here — satisfied by dapp-kit's SuiClient. */
export interface BotReadClient {
  getBalance(input: { owner: string }): Promise<{ totalBalance: string }>;
}

function loadOrCreateBot(storageKey: string): BattleshipBot {
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

  // Same identity on- and off-chain, or the on-chain signature checks fail.
  if (toHex(coreKey.publicKey) !== toHex(keypair.getPublicKey().toRawBytes())) {
    throw new Error("bot off/on-chain pubkey mismatch");
  }

  return { coreKey, keypair, address, publicKey: coreKey.publicKey };
}

export function loadOrCreateBattleshipBots(): {
  A: BattleshipBot;
  B: BattleshipBot;
} {
  return { A: loadOrCreateBot(STORAGE_A), B: loadOrCreateBot(STORAGE_B) };
}

/**
 * A single transfer tx that sends `perBotMist` SUI from the connected wallet's gas coin to BOTH
 * bot addresses. Funds the bots from the player's wallet instead of the (rate-limited) faucet;
 * the keys persist, so one top-up covers many matches (stakes are refunded, only gas is spent).
 */
export function buildFundBotsTx(
  bots: { A: BattleshipBot; B: BattleshipBot },
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
  bots: { A: BattleshipBot; B: BattleshipBot },
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

/**
 * Request testnet faucet SUI for both bots, then poll until both balances are
 * positive (faucet delivery is async). Per-address errors (e.g. rate limits) are
 * returned as a status string rather than thrown, so the UI can surface them.
 */
export async function fundBotsFromFaucet(
  client: BotReadClient,
  bots: { A: BattleshipBot; B: BattleshipBot },
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
