/**
 * Coin Flip Example
 *
 * Demonstrates how to use the example_coin_flip Move module for:
 * - Creating fair coin flip games
 * - Using commit-reveal for randomness
 * - Combining reveals to generate fair outcome
 *
 * Key Concepts:
 * - Neither player knows the outcome until both reveal
 * - Combined randomness prevents manipulation
 * - Timeout protection for non-responsive players
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { buildTarget, CoinFlipChoice, MODULES, SUI_COIN_TYPE } from "../config";
import { CreateGameResult } from "../types";
import {
  bytesToHex,
  computeCommitment,
  createSuiClient,
  generateSalt,
  getCreatedObjectId,
  getKeypairFromEnv,
  logError,
  logTransactionResult,
  signAndExecute,
} from "../utils";

// ============================================
// COIN FLIP GAME STATUS
// ============================================

const GameStatus = {
  WAITING_FOR_PLAYER2: 0,
  WAITING_FOR_COMMITS: 1,
  WAITING_FOR_REVEALS: 2,
  COMPLETE: 3,
  CANCELLED: 4,
} as const;

// ============================================
// COIN FLIP FUNCTIONS
// ============================================

/**
 * Create a new coin flip game.
 * Player 1 commits their choice at creation time.
 *
 * @param player2 - Address of the opponent
 * @param choice - Player 1's choice (HEADS or TAILS)
 * @param stakeCoinId - Object ID of the SUI coin to stake
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (player 1)
 * @returns The created game ID, transaction digest, and salt (save for reveal!)
 *
 * @example
 * ```typescript
 * const result = await createCoinFlipGame(
 *   "0x1234...player2_address",
 *   CoinFlipChoice.HEADS,
 *   "0xabcd...coin_id"
 * );
 * console.log("Game created:", result.gameId);
 * // IMPORTANT: Save result.salt for reveal!
 * ```
 */
export async function createCoinFlipGame(
  player2: string,
  choice: number,
  stakeCoinId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<CreateGameResult & { salt: Uint8Array; commitment: Uint8Array }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  // Generate salt and commitment for commit-reveal
  const salt = generateSalt(32);
  const value = new Uint8Array([choice]);
  const commitment = computeCommitment(value, salt);

  const tx = new Transaction();

  // public fun create_game(player_2, choice, commitment, stake, clock, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_COIN_FLIP, "create_game"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.pure.address(player2),
      tx.pure.u8(choice),
      tx.pure.vector("u8", Array.from(commitment)),
      tx.object(stakeCoinId),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  const gameId = getCreatedObjectId(result.objectChanges, "CoinFlipGame");

  if (!gameId) {
    throw new Error("Failed to get created CoinFlipGame ID");
  }

  logTransactionResult(result, "Create Coin Flip Game");

  console.log(`\n  IMPORTANT: Save your salt to reveal later!`);
  console.log(`  Salt: ${bytesToHex(salt)}`);
  console.log(`  Choice: ${getChoiceName(choice)}`);

  return {
    gameId,
    digest: result.digest,
    salt,
    commitment,
  };
}

/**
 * Player 2 joins the game with their commitment.
 *
 * @param gameId - The game object ID
 * @param choice - Player 2's choice (HEADS or TAILS)
 * @param stakeCoinId - Object ID of the SUI coin to stake
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be player 2)
 * @returns Salt (save for reveal!) and transaction digest
 */
export async function joinCoinFlipGame(
  gameId: string,
  choice: number,
  stakeCoinId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ salt: Uint8Array; commitment: Uint8Array; digest: string }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  // Generate salt and commitment for commit-reveal
  const salt = generateSalt(32);
  const value = new Uint8Array([choice]);
  const commitment = computeCommitment(value, salt);

  const tx = new Transaction();

  // public fun join_game(game, commitment, stake, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_COIN_FLIP, "join_game"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(gameId),
      tx.pure.vector("u8", Array.from(commitment)),
      tx.object(stakeCoinId),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Join Game");

  console.log(`\n  IMPORTANT: Save your salt to reveal later!`);
  console.log(`  Salt: ${bytesToHex(salt)}`);
  console.log(`  Choice: ${getChoiceName(choice)}`);

  return {
    salt,
    commitment,
    digest: result.digest,
  };
}

/**
 * Reveal a previously committed choice.
 * Use playerNumber to specify which reveal function to call.
 *
 * @param gameId - The game object ID
 * @param choice - The choice that was committed
 * @param salt - The salt used when committing (from create/join result)
 * @param playerNumber - Which player is revealing (1 or 2)
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 */
export async function revealChoice(
  gameId: string,
  choice: number,
  salt: Uint8Array,
  playerNumber: 1 | 2 = 1,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // public fun reveal_player_1/reveal_player_2(game, value, salt, ctx)
  const target = playerNumber === 1 ? "reveal_player_1" : "reveal_player_2";
  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_COIN_FLIP, target),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(gameId),
      tx.pure.vector("u8", [choice]),
      tx.pure.vector("u8", Array.from(salt)),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, `Reveal Choice (Player ${playerNumber})`);

  return result.digest;
}

/**
 * Claim winnings after both players have revealed
 *
 * @param gameId - The game object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest and won coin ID
 */
export async function claimWinnings(
  gameId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ digest: string; coinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // public fun claim_winnings(game, ctx)
  const coin = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_COIN_FLIP, "claim_winnings"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(gameId)],
  });

  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress()),
  );

  const txResult = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(txResult.objectChanges, "Coin");

  logTransactionResult(txResult, "Claim Winnings");

  return {
    digest: txResult.digest,
    coinId,
  };
}

/**
 * Cancel game if opponent doesn't join or commit in time
 *
 * @param gameId - The game object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest and refunded coin ID
 */
export async function cancelTimeout(
  gameId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ digest: string; coinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // public fun cancel_timeout(game, clock, ctx)
  const coin = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_COIN_FLIP, "cancel_timeout"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(gameId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress()),
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Cancel Timeout");

  return {
    digest: result.digest,
    coinId,
  };
}

/**
 * Claim win if opponent doesn't reveal in time
 *
 * @param gameId - The game object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must have revealed)
 * @returns Transaction digest and won coin ID
 */
export async function claimNoReveal(
  gameId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair,
): Promise<{ digest: string; coinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // public fun claim_no_reveal(game, clock, ctx)
  const coin = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_COIN_FLIP, "claim_no_reveal"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(gameId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress()),
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Claim No Reveal");

  return {
    digest: result.digest,
    coinId,
  };
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get choice name from value
 */
export function getChoiceName(choice: number): string {
  switch (choice) {
    case CoinFlipChoice.HEADS:
      return "Heads";
    case CoinFlipChoice.TAILS:
      return "Tails";
    default:
      return "Unknown";
  }
}

/**
 * Generate commitment for a choice
 */
export function generateChoiceCommitment(choice: number): {
  commitment: Uint8Array;
  salt: Uint8Array;
} {
  const salt = generateSalt(32);
  const value = new Uint8Array([choice]);
  const commitment = computeCommitment(value, salt);
  return { commitment, salt };
}

// ============================================
// EXAMPLE USAGE
// ============================================

/**
 * Complete coin flip flow example
 */
export async function exampleCoinFlipFlow(): Promise<void> {
  console.log("=== Coin Flip Example ===\n");

  try {
    console.log("How it works:");
    console.log("1. Both players commit to a random value (hidden)");
    console.log("2. Both players reveal their values");
    console.log("3. Values are combined to produce the coin flip result");
    console.log("4. Neither player could have predicted the outcome!\n");

    console.log("Fairness guarantee:");
    console.log(
      "- Player 1 can't change their value after seeing Player 2's commit",
    );
    console.log(
      "- Player 2 can't change their value after seeing Player 1's reveal",
    );
    console.log("- Combined randomness is unpredictable to both\n");

    console.log("Example Code:");
    console.log(`
// Player 1 creates game (commits choice at creation)
const game = await createCoinFlipGame(player2Address, CoinFlipChoice.HEADS, coinId);
// Save game.salt for reveal!

// Player 2 joins (commits choice at join)
const { salt: salt2 } = await joinCoinFlipGame(game.gameId, CoinFlipChoice.TAILS, coin2Id, client, player2Keypair);

// Both players reveal (after both have committed)
await revealChoice(game.gameId, CoinFlipChoice.HEADS, game.salt, 1, client, player1Keypair);
await revealChoice(game.gameId, CoinFlipChoice.TAILS, salt2, 2, client, player2Keypair);

// Winner claims the pot
await claimWinnings(game.gameId);
`);
  } catch (error) {
    logError(error, "exampleCoinFlipFlow");
  }
}

// Run example if called directly
if (require.main === module) {
  exampleCoinFlipFlow();
}
