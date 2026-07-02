// Late/lazy arena allocation (ADR-0028): fund a single game whose window is opened MID-SESSION, after
// the connect-time batch (`useArenaAutoEnter`). The add-a-game action (`Desktop` addWindowTo/addAll)
// calls this; it reuses the SAME shared `TunnelOpenBatcher` that ArenaAutoEnter configured on connect,
// so deposits for windows added in the same tick coalesce into one wallet popup. The resulting
// `setArenaEntry` wakes that game's window consumer (via `subscribeArena`) to `enterArenaMatch`. No-op
// if already allocated or in flight, or with no wallet (then the connect batch covers it on connect).
import { enterArena } from "@/onchain/arenaEnter";
import { setArenaEntry } from "@/onchain/arenaAllocationStore";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "@/onchain/mtps";
import { resolveBackendUrl } from "@/backend/controlPlane";

/** WINDOWS with an allocate in flight (keyed by window instance id, NOT game), so a re-fire for the
 *  same window can't double-deposit before its store entry lands. Keying by window is what lets N
 *  windows of the SAME game each get their own bot — game-keyed dedup would allocate only the first. */
const inFlight = new Set<string>();

/** Allocate + deposit seat A for ONE game window opened after the connect-time batch. Idempotent per
 *  window (in-flight guard). Requires the connected wallet's address; a reopen retries on failure. */
export async function requestArenaGame(
  windowId: string,
  arenaGameId: string,
  ownerAddress: string,
): Promise<void> {
  if (inFlight.has(windowId)) return;
  inFlight.add(windowId);
  try {
    // `enterArena` mints the ephemeral key, allocates the bot, deposits seat A, and returns the
    // {allocation, keypair}; publish it under the game so THIS window's consumer pops it.
    const matches = await enterArena({
      games: [arenaGameId],
      userAddress: ownerAddress,
      coinType: isMtpsConfigured ? MTPS_COIN_TYPE : undefined,
      apiBase: resolveBackendUrl(),
    });
    for (const m of matches) setArenaEntry(m.allocation.game, m);
  } catch (e) {
    // No free bot / deposit rejected — the window just shows its normal lobby; a reopen retries.
    console.warn(
      `[arena] late allocate failed for ${arenaGameId} (${windowId})`,
      e,
    );
  } finally {
    inFlight.delete(windowId);
  }
}
