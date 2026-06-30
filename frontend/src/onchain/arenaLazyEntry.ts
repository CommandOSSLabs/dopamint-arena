// Late/lazy arena allocation (ADR-0028): fund a single game whose window is opened MID-SESSION, after
// the connect-time batch (`useArenaAutoEnter`). The add-a-game action (`Desktop` addWindowTo/addAll)
// calls this; it reuses the SAME shared `TunnelOpenBatcher` that ArenaAutoEnter configured on connect,
// so deposits for windows added in the same tick coalesce into one wallet popup. The resulting
// `setArenaEntry` wakes that game's window consumer (via `subscribeArena`) to `enterArenaMatch`. No-op
// if already allocated or in flight, or with no wallet (then the connect batch covers it on connect).
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { enterArena, type MakeUserParty } from "@/onchain/arenaEnter";
import { getArenaEntry, setArenaEntry } from "@/onchain/arenaAllocationStore";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "@/onchain/mtps";
import { resolveBackendUrl } from "@/backend/controlPlane";
import type { PartyOnchain } from "@/onchain/tunnelTx";

/** Games with an allocate in flight, so a window remount (or a sibling consumer) can't double-deposit
 *  the same game before its store entry lands. Cleared when the allocate settles. */
const inFlight = new Set<string>();

/** Allocate + deposit seat A for one arena game opened after the connect-time batch. Idempotent: a
 *  no-op if the game already has a store entry or an allocate is in flight. Requires the connected
 *  wallet's address; safe to call repeatedly (e.g. from a mount effect). */
export async function requestArenaGame(
  arenaGameId: string,
  ownerAddress: string,
): Promise<void> {
  if (getArenaEntry(arenaGameId) || inFlight.has(arenaGameId)) return;
  inFlight.add(arenaGameId);
  try {
    // One ephemeral key, baked into the tunnel at allocate and reused to co-sign moves (stash it).
    let keypair: KeyPair | undefined;
    const makeUserParty: MakeUserParty = async () => {
      keypair = generateKeyPair();
      const party: PartyOnchain = {
        address: ownerAddress,
        publicKey: keypair.publicKey,
      };
      return party;
    };
    const allocations = await enterArena({
      games: [arenaGameId],
      userAddress: ownerAddress,
      makeUserParty,
      coinType: isMtpsConfigured ? MTPS_COIN_TYPE : undefined,
      apiBase: resolveBackendUrl(),
    });
    const alloc = allocations[0];
    if (alloc && keypair) setArenaEntry(alloc.game, { allocation: alloc, keypair });
  } catch (e) {
    // No free bot / deposit rejected — the window just shows its normal lobby; a reopen retries.
    console.warn(`[arena] late allocate failed for ${arenaGameId}`, e);
  } finally {
    inFlight.delete(arenaGameId);
  }
}
