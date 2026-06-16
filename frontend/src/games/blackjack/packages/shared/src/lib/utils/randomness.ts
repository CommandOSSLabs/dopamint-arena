// import "server-only";
import { fromHEX, toHEX } from "@mysten/bcs";
import { blake2b } from "@noble/hashes/blake2b";

export function drewCard({
  for: playerOrDealer,
  hands,
  seed,
}: {
  for: "player" | "dealer";
  hands: {
    player: number[];
    dealer: number[];
    deck: number[];
  };
  seed: Uint8Array | string;
}) {
  const seedBytes: Uint8Array = typeof seed === "string" ? fromHEX(seed) : seed;
  const [card_index, new_seed] = deriveRandomU8InRange(
    seedBytes,
    0,
    hands.deck.length
  );
  const card = swapRemove(hands.deck, card_index);
  if (playerOrDealer === "player") {
    hands.player.push(card);
  } else {
    hands.dealer.push(card);
  }
  return toHEX(new_seed);
}

function swapRemove<T>(arr: T[], index: number): T {
  if (index < 0 || index >= arr.length) {
    throw new Error("Index out of bounds");
  }
  const lastIdx = arr.length - 1;
  [arr[index], arr[lastIdx]] = [arr[lastIdx], arr[index]];
  return arr.pop()!;
}
export function deriveRandomU8InRange(
  inputBytes: Uint8Array,
  greaterThanOrEqualTo: number,
  lessThan: number
): [number, Uint8Array] {
  // Hash the input bytes using blake2b
  const rehash = blake2b(inputBytes, { dkLen: 32 });

  // Convert the rehash to a BigInt
  const value = hexToU256(toHEX(rehash));

  // Calculate the range and the random number within that range
  const range = BigInt(lessThan - greaterThanOrEqualTo);
  const randomNumber = Number(value % range) + greaterThanOrEqualTo;

  // Return the random number and the rehash
  return [randomNumber, rehash];
}

function hexToU256(hexString: string) {
  if (typeof hexString !== "string") {
    throw new TypeError("Input must be a string");
  }

  // Ensure the hex string starts with "0x"
  if (!hexString.startsWith("0x")) {
    hexString = "0x" + hexString;
  }

  // Convert to BigInt
  const bigIntValue = BigInt(hexString);

  return bigIntValue;
}
