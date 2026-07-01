// Cross-window hand-off for the centralized batched arena entry (ADR-0028, the "one PTB → all games
// explode" flow). The headless orchestrator (mounted once on wallet-connect) runs the single batched
// `enterArena` deposit and writes each game's {allocation, keypair} here; each game's PvP hook, mounted
// in its own window, reads its entry by arena game id and auto-`enterArenaMatch`es into the live match.
//
// The keypair is the per-game ephemeral whose pubkey the orchestrator baked into the tunnel at
// allocate — the SAME key must co-sign moves, so it travels with the allocation (a pubkey-only
// PartyOnchain would strand the secret). Module singleton, mirroring `sharedTunnelOpenBatcher`.
import type { KeyPair } from "sui-tunnel-ts/core/crypto";
import type { ArenaAllocation } from "./arenaEnter";

export interface ArenaEntry {
  allocation: ArenaAllocation;
  /** The per-game ephemeral key (baked into the tunnel as party A's pk at allocate; co-signs moves). */
  keypair: KeyPair;
}

// A QUEUE of pending entries per arena game id, not a single slot: N windows of the SAME game (e.g. 3
// caro tabs) each get their own bot, so the orchestrator publishes N entries under "caro" and each
// window consumes one (`consumeArenaEntry` shifts). Each entry's keypair is the one baked into ITS
// tunnel — entries are interchangeable across same-game windows (any window plays any caro bot).
const entries = new Map<string, ArenaEntry[]>();
const subscribers = new Set<() => void>();

/** Publish one allocation + signing key for a game (called per bot after the batched PTB lands).
 *  Appends to the game's queue — repeated calls for the same game stack up (one per window). */
export function setArenaEntry(arenaGameId: string, entry: ArenaEntry): void {
  const q = entries.get(arenaGameId);
  if (q) q.push(entry);
  else entries.set(arenaGameId, [entry]);
  subscribers.forEach((cb) => cb());
}

/** Peek this game's next pending entry (does not consume) — for the lazy-allocate in-flight check. */
export function getArenaEntry(arenaGameId: string): ArenaEntry | undefined {
  return entries.get(arenaGameId)?.[0];
}

/** How many pending entries a game has queued — lets the orchestrator avoid over-allocating. */
export function arenaEntryCount(arenaGameId: string): number {
  return entries.get(arenaGameId)?.length ?? 0;
}

/** Drop ALL of a game's pending entries (e.g. teardown) so a remount can't re-enter a closed match. */
export function clearArenaEntry(arenaGameId: string): void {
  if (entries.delete(arenaGameId)) subscribers.forEach((cb) => cb());
}

/** Subscribe to store changes (a game hook re-checks `getArenaEntry` when this fires). Returns an
 *  unsubscribe. Pairs with React `useSyncExternalStore` or a simple effect. */
export function subscribeArena(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Consume this game's pending arena entry and enter the match — once, and only from idle. The shared
 *  one-shot invariant every PvP hook's auto-enter effect runs: the `entered` ref guards re-entry and
 *  `clearArenaEntry` consumes the entry so a window remount can't re-enter a closed match. `isIdle` and
 *  `enter` are read live, so each hook keeps ownership of its own reactivity (when to re-attempt): pass
 *  a `useRef`'s object, the current idle check, and the hook's `enterArenaMatch` call. */
export function consumeArenaEntry(
  arenaGameId: string,
  entered: { current: boolean },
  isIdle: () => boolean,
  enter: (allocation: ArenaAllocation, keypair: KeyPair) => void,
): void {
  if (entered.current || !isIdle()) return;
  const q = entries.get(arenaGameId);
  if (!q || q.length === 0) return;
  // Take ONE entry off the game's queue so sibling windows of the same game each claim a distinct bot.
  const entry = q.shift()!;
  if (q.length === 0) entries.delete(arenaGameId);
  entered.current = true;
  subscribers.forEach((cb) => cb());
  enter(entry.allocation, entry.keypair);
}
