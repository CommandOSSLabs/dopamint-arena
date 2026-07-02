// On-demand arena allocation for a single game — the "click Play → get me a bot for THIS game now"
// recipe (ADR-0025/0028), shared by every arena game's `playArena`. It is the SSoT the per-game hooks
// call so the eph-key + allocate + seat-A-deposit steps live in one place instead of copy-inlined.
//
// Unlike the connect-time batch (`enterArena` over many games, coalesced into ONE PTB by the shared
// batcher) and the add-a-game lazy path (`requestArenaGame`, which also rides the batcher), a single
// explicit Play is ONE game → ONE deposit → ONE wallet popup: no coalescing needed. So this uses a
// game-local sponsored deposit (`depositStakeStaked`) instead of the shared batcher — the same staked
// primitive `findMatch` uses, so sponsorship + top-up behave identically — and does NOT depend on the
// batcher having been configured on connect.
import { type KeyPair } from "sui-tunnel-ts/core/crypto";
import { enterArena, type ArenaAllocation } from "@/onchain/arenaEnter";
import { depositStakeStaked, type StakeStrategy } from "@/onchain/stakeTunnel";
import type { TunnelOpenRequest } from "@/onchain/tunnelOpenBatcher";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "@/onchain/mtps";
import { resolveBackendUrl } from "@/backend/controlPlane";

/** Reserve one warm fleet bot for `arenaGameId` (the fleet pre-creates the tunnel + funds seat B),
 *  deposit seat A with the caller's stake strategy, and return the live allocation plus the per-game
 *  ephemeral key baked into the tunnel at create — the caller hands both to its `enterArenaMatch` to
 *  wire the relay + engine. Returns `null` when no bot was free (the backend omits it), so the caller
 *  can surface a "try again" lobby state. `stakePerGame` is the back-compat fallback stake; the deposit
 *  prefers the allocation's `stakeEach` (backend SSoT) when present. */
export async function allocateArenaGameForPlay(opts: {
  arenaGameId: string;
  wallet: string;
  stake: StakeStrategy;
  /** Deposit label for logs/telemetry — the game's key (e.g. "regular-payments"). */
  label: string;
  stakePerGame?: bigint;
}): Promise<{ allocation: ArenaAllocation; keypair: KeyPair } | null> {
  const open = async (req: TunnelOpenRequest): Promise<string> => {
    const tunnelId = req.tunnelId;
    if (!tunnelId) throw new Error("arena deposit missing tunnelId");
    await depositStakeStaked({
      tunnelId,
      amount: req.aAmount,
      label: opts.label,
      ...opts.stake,
    });
    return tunnelId;
  };
  // `enterArena` mints the per-game ephemeral key itself and returns it baked into the allocation
  // (new API: no `makeUserParty` callback), so the caller hands both straight to `enterArenaMatch`.
  const matches = await enterArena({
    games: [opts.arenaGameId],
    userAddress: opts.wallet,
    stakePerGame: opts.stakePerGame,
    open,
    coinType: isMtpsConfigured ? MTPS_COIN_TYPE : undefined,
    apiBase: resolveBackendUrl(),
  });
  const match = matches.find((m) => m.allocation.game === opts.arenaGameId);
  return match
    ? { allocation: match.allocation, keypair: match.keypair }
    : null;
}
