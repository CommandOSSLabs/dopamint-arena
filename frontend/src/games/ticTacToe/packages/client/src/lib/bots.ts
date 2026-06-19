/**
 * Two persistent bot identities for autonomous bot-vs-bot tic-tac-toe.
 *
 * Each bot has a SINGLE ed25519 keypair used both off-chain (the SDK's `core.KeyPair`,
 * for state co-signing) and on-chain (a `@mysten/sui` `Ed25519Keypair`, for signing the
 * create/deposit/close txs). We assert the two derivations produce the same public key so
 * the on-chain `PartyConfig.public_key` matches the off-chain signer — the on-chain
 * settlement signature check would otherwise fail.
 *
 * No wallet, no server: the bots sign their own txs with the client's own SuiClient.
 */
import { core } from "sui-tunnel-ts";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { requestSuiFromFaucetV2, getFaucetHost } from "@mysten/sui/faucet";
import { fromHEX, toHEX } from "@mysten/sui/utils";

export interface BotIdentity {
  coreKey: ReturnType<typeof core.keyPairFromSecret>;
  keypair: Ed25519Keypair;
  address: string;
  publicKey: Uint8Array;
}

const STORAGE_X = "ttt_bot_x";
const STORAGE_O = "ttt_bot_o";

function loadOrCreateBot(storageKey: string): BotIdentity {
  let seed: Uint8Array;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(storageKey);
  } catch {
    /* ignore */
  }
  if (stored) {
    seed = fromHEX(stored);
  } else {
    seed = core.generateKeyPair().secretKey; // 32-byte ed25519 seed
    try {
      localStorage.setItem(storageKey, toHEX(seed));
    } catch {
      /* ignore */
    }
  }

  const coreKey = core.keyPairFromSecret(seed);
  const keypair = Ed25519Keypair.fromSecretKey(seed);
  const address = keypair.getPublicKey().toSuiAddress();
  const publicKey = coreKey.publicKey;

  // Same identity on- and off-chain, or the on-chain signature checks fail.
  if (toHEX(coreKey.publicKey) !== toHEX(keypair.getPublicKey().toRawBytes())) {
    throw new Error("bot off/on-chain pubkey mismatch");
  }

  return { coreKey, keypair, address, publicKey };
}

export function loadOrCreateBots(): { x: BotIdentity; o: BotIdentity } {
  return {
    x: loadOrCreateBot(STORAGE_X),
    o: loadOrCreateBot(STORAGE_O),
  };
}

/** Default top-up per bot when funding from the player's wallet: 0.05 SUI (MIST). */
export const FUND_PER_BOT_MIST = 50_000_000;
/**
 * Top-up for bot X (MIST): 0.5 SUI. Bot X (party A) signs create/deposit/close AND the chunked
 * `update_state` PTBs that checkpoint every co-signed state on-chain, so it spends far more
 * gas than bot O. The multi-game protocol (up to 100 games/tunnel) needs this headroom.
 */
export const FUND_X_MIST = 500_000_000;

/**
 * A single transfer tx that sends SUI from the connected wallet's gas coin to BOTH bot
 * addresses. Used instead of the (rate-limited) faucet — the player funds the bots once; the
 * keys persist, so it covers many games (deposits are refunded, only gas is spent). Bot X gets
 * a larger top-up (`xMist`) because it pays for the per-tunnel `update_state` batches.
 */
export function buildFundTx(
  bots: { x: BotIdentity; o: BotIdentity },
  oMist: number = FUND_PER_BOT_MIST,
  xMist: number = FUND_X_MIST,
): Transaction {
  const tx = new Transaction();
  const [cx, co] = tx.splitCoins(tx.gas, [xMist, oMist]);
  tx.transferObjects([cx], bots.x.address);
  tx.transferObjects([co], bots.o.address);
  return tx;
}

/**
 * Move `amountMist` SUI from one bot to the other. The sender bot signs its own transfer
 * (no wallet) — used to rebalance gas when one bot (the one submitting create/deposit/close)
 * drains faster than the other during auto-play. Returns the tx digest.
 */
export async function transferBetweenBots(
  client: SuiClient,
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

let cachedClient: SuiClient | null = null;
export function getSuiClient(): SuiClient {
  if (!cachedClient) {
    cachedClient = new SuiClient({ url: import.meta.env.VITE_SUI_NETWORK });
  }
  return cachedClient;
}

export async function botBalances(
  client: SuiClient,
  bots: { x: BotIdentity; o: BotIdentity },
): Promise<{ x: bigint; o: bigint }> {
  const [bx, bo] = await Promise.all([
    client.getBalance({ owner: bots.x.address }),
    client.getBalance({ owner: bots.o.address }),
  ]);
  return { x: BigInt(bx.totalBalance), o: BigInt(bo.totalBalance) };
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
 * Request faucet SUI for both bots. Per-address errors (e.g. rate limits) are caught and
 * returned as a status string rather than thrown, so the UI can surface them. After the
 * requests, poll balances a few times so the caller can refresh once funds have landed.
 */
export async function fundBots(
  client: SuiClient,
  bots: { x: BotIdentity; o: BotIdentity },
): Promise<{ x: string; o: string }> {
  const [x, o] = await Promise.all([
    faucetStatus(bots.x.address),
    faucetStatus(bots.o.address),
  ]);

  // Poll until both balances are positive or we time out (faucet delivery is async).
  for (let i = 0; i < 10; i++) {
    const b = await botBalances(client, bots);
    if (b.x > 0n && b.o > 0n) break;
    await wait(1500);
  }

  return { x, o };
}
