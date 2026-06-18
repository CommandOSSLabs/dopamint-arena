/**
 * Local bot identities for the bot-vs-bot Tic-Tac-Toe window: each is ONE persisted ed25519 seed
 * used both off-chain (SDK `KeyPair`, for co-signing moves) and on-chain (`Ed25519Keypair`, for
 * signing the open/close txs). Seat X is the funder/signer — it opens+funds both seats and submits
 * the close, signed locally via the SuiClient, so there is NO wallet popup and the bot can loop
 * autonomously. Faucet-funded; throwaway testnet keys.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { requestSuiFromFaucetV2, getFaucetHost } from "@mysten/sui/faucet";
import { generateKeyPair, keyPairFromSecret } from "sui-tunnel-ts/core/crypto";
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";

/** Just the balance read we need — avoids depending on a specific @mysten/sui client type. */
type BalanceReader = {
  getBalance: (args: { owner: string }) => Promise<{ totalBalance: string }>;
};

export interface TttBot {
  coreKey: ReturnType<typeof keyPairFromSecret>; // off-chain move co-signer
  keypair: Ed25519Keypair; // on-chain signer
  address: string;
}

function loadBot(storageKey: string): TttBot {
  let seed: Uint8Array;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) seed = fromHex(stored);
    else {
      seed = generateKeyPair().secretKey;
      localStorage.setItem(storageKey, toHex(seed));
    }
  } catch {
    seed = generateKeyPair().secretKey;
  }
  const coreKey = keyPairFromSecret(seed);
  const keypair = Ed25519Keypair.fromSecretKey(seed);
  return { coreKey, keypair, address: keypair.getPublicKey().toSuiAddress() };
}

/** Load (or create + persist) the two bot seats. X is the funder/signer. */
export function loadTttBots(): { x: TttBot; o: TttBot } {
  return { x: loadBot("ttt_arena_bot_x.v1"), o: loadBot("ttt_arena_bot_o.v1") };
}

/** Ensure seat X holds enough SUI to fund a game (gas + both stakes); faucet + poll if low. */
export async function ensureFunded(
  client: BalanceReader,
  address: string,
  minMist: bigint,
): Promise<void> {
  const balance = async () => {
    try {
      return BigInt((await client.getBalance({ owner: address })).totalBalance);
    } catch {
      return 0n;
    }
  };
  if ((await balance()) >= minMist) return;
  await requestSuiFromFaucetV2({
    host: getFaucetHost("testnet"),
    recipient: address,
  });
  for (let i = 0; i < 12; i++) {
    if ((await balance()) >= minMist) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
