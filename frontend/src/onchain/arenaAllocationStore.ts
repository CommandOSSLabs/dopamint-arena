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

const entries = new Map<string, ArenaEntry>();
const subscribers = new Set<() => void>();

/** Publish a game's batched allocation + signing key (called by the orchestrator after the PTB lands). */
export function setArenaEntry(arenaGameId: string, entry: ArenaEntry): void {
  entries.set(arenaGameId, entry);
  subscribers.forEach((cb) => cb());
}

/** This game's pending arena entry, if the batched deposit allocated it. */
export function getArenaEntry(arenaGameId: string): ArenaEntry | undefined {
  return entries.get(arenaGameId);
}

/** Drop a consumed/finished entry so a window remount doesn't re-enter the same (now-closed) match. */
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
