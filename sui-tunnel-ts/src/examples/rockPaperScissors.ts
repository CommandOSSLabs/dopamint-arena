/**
 * Rock Paper Scissors Example
 *
 * Demonstrates how to use the example_rock_paper_scissors Move module for:
 * - Creating a game
 * - Joining a game
 * - Committing moves (hidden via hash)
 * - Revealing moves
 * - Settling the game
 *
 * Key Concepts:
 * - Commit-reveal scheme prevents cheating
 * - Both players must commit before either can reveal
 * - Randomness can be used for tie-breaking
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import {
  buildTarget,
  MODULES,
  RPSGameStatus,
  RPSMove,
  SUI_COIN_TYPE,
} from "../config";
import { CreateGameResult } from "../types";
import {
  bytesToHex,
  computeRPSCommitment,
  createSuiClient,
  generateSalt,
  getCreatedObjectId,
  getKeypairFromEnv,
  logError,
  logTransactionResult,
  signAndExecute,
} from "../utils";

// ============================================
// RPS GAME FUNCTIONS
// ============================================

/**
 * Create a new Rock Paper Scissors game
 *
 * @param player2 - Address of the opponent
 * @param stakeCoinId - Object ID of the SUI coin to stake
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (player 1)
 * @returns The created game ID and transaction digest
 *
 * @example
 * ```typescript
 * const result = await createRPSGame(
 *   "0x1234...player2_address",
 *   "0xabcd...coin_id"
 * );
 * console.log("Game created:", result.gameId);
 * ```
 */
export async function createRPSGame(
  player2: string,
  stakeCoinId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<CreateGameResult> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // public fun create_game(player2, stake, clock, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ROCK_PAPER_SCISSORS, "create_game"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.pure.address(player2),
      tx.object(stakeCoinId),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  const gameId = getCreatedObjectId(result.objectChanges, "RPSGame");

  if (!gameId) {
    throw new Error("Failed to get created RPSGame ID");
  }

  logTransactionResult(result, "Create RPS Game");

  return {
    gameId,
    digest: result.digest,
  };
}

/**
 * Player 2 joins an existing game
 *
 * @param gameId - The game object ID
 * @param stakeCoinId - Object ID of the SUI coin to stake (must match game stake)
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing (must be player 2)
 * @returns Transaction digest
 *
 * @example
 * ```typescript
 * await joinGame("0xgame_id...", "0xcoin_id...");
 * console.log("Joined the game!");
 * ```
 */
export async function joinGame(
  gameId: string,
  stakeCoinId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call join_game function
  // public fun join_game(game: &mut RPSGame, stake: Coin<SUI>, ctx: &TxContext)
  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ROCK_PAPER_SCISSORS, "join_game"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(gameId), tx.object(stakeCoinId)],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Join Game");

  return result.digest;
}

/**
 * Commit a move (hides the actual move)
 *
 * @param gameId - The game object ID
 * @param move - The move to commit (ROCK, PAPER, or SCISSORS)
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Object containing the salt (SAVE THIS!) and transaction digest
 *
 * @example
 * ```typescript
 * const { salt, digest } = await commitMove("0xgame_id...", RPSMove.ROCK);
 * // IMPORTANT: Save the salt! You'll need it to reveal your move
 * console.log("Committed! Salt:", bytesToHex(salt));
 * ```
 */
export async function commitMove(
  gameId: string,
  move: number,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<{ salt: Uint8Array; commitment: Uint8Array; digest: string }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  // Generate random salt
  const salt = generateSalt(32);

  // Compute commitment: blake2b256([move_byte] || salt)
  const commitment = computeRPSCommitment(move, salt);

  const tx = new Transaction();

  // Call commit_move function
  // public fun commit_move(game, commitment, clock, ctx)
  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ROCK_PAPER_SCISSORS, "commit_move"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(gameId),
      tx.pure.vector("u8", Array.from(commitment)),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Commit Move");

  console.log(`\n  IMPORTANT: Save your salt to reveal later!`);
  console.log(`  Salt: ${bytesToHex(salt)}`);
  console.log(`  Move: ${getMoveName(move)}`);

  return {
    salt,
    commitment,
    digest: result.digest,
  };
}

/**
 * Reveal a previously committed move
 *
 * @param gameId - The game object ID
 * @param move - The move that was committed
 * @param salt - The salt used when committing (from commitMove result)
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 *
 * @example
 * ```typescript
 * await revealMove("0xgame_id...", RPSMove.ROCK, savedSalt);
 * console.log("Move revealed!");
 * ```
 */
export async function revealMove(
  gameId: string,
  move: number,
  salt: Uint8Array,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<string> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call reveal_move function
  // public fun reveal_move(game: &mut RPSGame, move_choice: u8, salt: vector<u8>, ctx: &TxContext)
  tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ROCK_PAPER_SCISSORS, "reveal_move"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(gameId),
      tx.pure.u8(move),
      tx.pure.vector("u8", Array.from(salt)),
    ],
  });

  const result = await signAndExecute(suiClient, tx, signer);
  logTransactionResult(result, "Reveal Move");

  return result.digest;
}

/**
 * Settle the game after both players have revealed
 *
 * @param gameId - The game object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest and winner's coin
 *
 * @example
 * ```typescript
 * const result = await settleGame("0xgame_id...");
 * console.log("Game settled! Winner gets the pot.");
 * ```
 */
export async function settleGame(
  gameId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<{ digest: string; coinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call settle_game function
  // public fun settle_game(game: &mut RPSGame, ctx: &mut TxContext): (Coin<SUI>, GameResult)
  const [coin, gameResult] = tx.moveCall({
    target: buildTarget(MODULES.EXAMPLE_ROCK_PAPER_SCISSORS, "settle_game"),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(gameId)],
  });

  // Transfer prize to the caller (who is presumably the winner or either player)
  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress())
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Settle Game");

  return {
    digest: result.digest,
    coinId,
  };
}

/**
 * Claim win if opponent doesn't commit in time
 *
 * @param gameId - The game object ID
 * @param client - Optional SuiClient instance
 * @param keypair - Optional keypair for signing
 * @returns Transaction digest
 */
export async function cancelCommitTimeout(
  gameId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<{ digest: string; coinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call cancel_commit_timeout function
  // public fun cancel_commit_timeout(game, clock, ctx)
  const coin = tx.moveCall({
    target: buildTarget(
      MODULES.EXAMPLE_ROCK_PAPER_SCISSORS,
      "cancel_commit_timeout"
    ),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(gameId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress())
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Cancel (Commit Timeout)");

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
 * @returns Transaction digest
 */
export async function claimRevealTimeout(
  gameId: string,
  client?: SuiClient,
  keypair?: Ed25519Keypair
): Promise<{ digest: string; coinId: string | null }> {
  const suiClient = client || createSuiClient();
  const signer = keypair || getKeypairFromEnv();

  const tx = new Transaction();

  // Call claim_reveal_timeout function
  // public fun claim_reveal_timeout(game, clock, ctx)
  const coin = tx.moveCall({
    target: buildTarget(
      MODULES.EXAMPLE_ROCK_PAPER_SCISSORS,
      "claim_reveal_timeout"
    ),
    typeArguments: [SUI_COIN_TYPE],
    arguments: [tx.object(gameId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  tx.transferObjects(
    [coin],
    tx.pure.address(signer.getPublicKey().toSuiAddress())
  );

  const result = await signAndExecute(suiClient, tx, signer);
  const coinId = getCreatedObjectId(result.objectChanges, "Coin");

  logTransactionResult(result, "Claim (Reveal Timeout)");

  return {
    digest: result.digest,
    coinId,
  };
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get move name from move value
 */
export function getMoveName(move: number): string {
  switch (move) {
    case RPSMove.ROCK:
      return "Rock";
    case RPSMove.PAPER:
      return "Paper";
    case RPSMove.SCISSORS:
      return "Scissors";
    default:
      return "Unknown";
  }
}

/**
 * Get game status name from status value
 */
export function getGameStatusName(status: number): string {
  switch (status) {
    case RPSGameStatus.WAITING_COMMITS:
      return "Waiting for Commits";
    case RPSGameStatus.WAITING_REVEALS:
      return "Waiting for Reveals";
    case RPSGameStatus.COMPLETE:
      return "Complete";
    case RPSGameStatus.CANCELLED:
      return "Cancelled";
    default:
      return "Unknown";
  }
}

/**
 * Determine winner between two moves
 * Returns: 1 if move1 wins, 2 if move2 wins, 0 if tie
 */
export function determineWinner(move1: number, move2: number): number {
  if (move1 === move2) return 0; // Tie

  const beats: Record<number, number> = {
    [RPSMove.ROCK]: RPSMove.SCISSORS,
    [RPSMove.PAPER]: RPSMove.ROCK,
    [RPSMove.SCISSORS]: RPSMove.PAPER,
  };

  return beats[move1] === move2 ? 1 : 2;
}

/**
 * Generate commitment for a move (client-side helper)
 *
 * @example
 * ```typescript
 * const { commitment, salt } = generateMoveCommitment(RPSMove.ROCK);
 * // Use commitment in transaction, save salt for later reveal
 * ```
 */
export function generateMoveCommitment(move: number): {
  commitment: Uint8Array;
  salt: Uint8Array;
} {
  const salt = generateSalt(32);
  const commitment = computeRPSCommitment(move, salt);
  return { commitment, salt };
}

// ============================================
// EXAMPLE USAGE
// ============================================

/**
 * Complete RPS game flow example
 */
export async function exampleRPSFlow(): Promise<void> {
  console.log("=== Rock Paper Scissors Example ===\n");

  try {
    console.log("Game Flow:");
    console.log("1. Player 1 creates game with stake");
    console.log("2. Player 2 joins with matching stake");
    console.log("3. Both players commit their moves (hidden)");
    console.log("4. Both players reveal their moves");
    console.log("5. Game is settled, winner takes pot\n");

    console.log("Commit-Reveal Scheme:");
    console.log("- commitment = blake2b256(move_byte || random_salt)");
    console.log("- Neither player can see the other's move until both commit");
    console.log("- If commitment doesn't match reveal, transaction fails\n");

    console.log("Example Code:");
    console.log(`
// Player 1 creates game
const game = await createRPSGame(player2Address, coinId, client, player1Keypair);

// Player 2 joins
await joinGame(game.gameId, coin2Id, client, player2Keypair);

// Player 1 commits ROCK (saves salt!)
const { salt: salt1 } = await commitMove(game.gameId, RPSMove.ROCK, client, player1Keypair);

// Player 2 commits PAPER (saves salt!)
const { salt: salt2 } = await commitMove(game.gameId, RPSMove.PAPER, client, player2Keypair);

// Player 1 reveals
await revealMove(game.gameId, RPSMove.ROCK, salt1, client, player1Keypair);

// Player 2 reveals
await revealMove(game.gameId, RPSMove.PAPER, salt2, client, player2Keypair);

// Settle game - Paper beats Rock, Player 2 wins!
await settleGame(game.gameId, client, player2Keypair);
`);
  } catch (error) {
    logError(error, "exampleRPSFlow");
  }
}

// Run example if called directly
if (require.main === module) {
  exampleRPSFlow();
}
