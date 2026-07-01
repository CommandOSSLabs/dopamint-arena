// Arena one-signature entry (ADR-0025, refining ADR-0023). Connect wallet → generate one ephemeral
// key per game → reserve one warm fleet bot per game, which PRE-CREATES the tunnel + funds seat B →
// deposit seat A into every pre-opened tunnel in ONE batched PTB (the batcher's deposit mode). The
// tunnel activates on that single signature; each game then plays genuine two-party over the relay.
import { fromHex, toHex } from "@mysten/sui/utils";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { requestTunnelOpen } from "./sharedTunnelOpenBatcher";
import type { TunnelOpenRequest } from "./tunnelOpenBatcher";
import type { PartyOnchain } from "./tunnelTx";

/** One game's allocate request (wire shape): the game id plus the user's per-game ephemeral pubkey
 *  (hex), which the fleet bakes into the tunnel as party A's `pk` at create (ADR-0025). */
export interface ArenaGameRequest {
  id: string;
  userEphPubkey: string;
}

/** One reserved bot from `POST /v1/arena/allocate` (wire shape, camelCase). */
export interface ArenaAllocation {
  game: string;
  matchId: string;
  /** The tunnel the fleet pre-created + funded seat B for; the user deposits seat A into it. */
  tunnelId: string;
  /** Tunnel party B's `pk` (verifies the bot's move signatures). */
  botEphPubkey: string;
  /** Tunnel party B's `address` (funds/receives seat B); distinct from the ephemeral pubkey. */
  botAddress: string;
  /** Per-seat stake (smallest MTPS unit) from the game's backend `GameProfile`. The fleet funded
   *  seat B with exactly this; the user's batched deposit funds seat A with the SAME amount, and the
   *  off-chain tunnel inits both balances to it. Single source of truth — the FE never hardcodes it. */
  stakeEach: number;
}

/** One opened arena game: the bot to play, the relay match, and the live tunnel. */
export interface ArenaOpened {
  game: string;
  matchId: string;
  tunnelId: string;
}

/** One entered arena match: the allocation (bot keys + live tunnel) and the ephemeral key whose pubkey
 *  is baked into THAT tunnel and co-signs its moves. Returned per request so N same-game windows each
 *  get a distinct {bot, tunnel, key} triple. */
export interface ArenaEntered {
  allocation: ArenaAllocation;
  keypair: KeyPair;
}

interface ArenaApi {
  /** Backend base URL; "" (same-origin) by default. Mirrors `resolveBackendUrl` in controlPlane. */
  apiBase?: string;
  fetchFn?: typeof fetch;
}

const backendUrl = (apiBase?: string): string =>
  apiBase ?? import.meta.env?.VITE_BACKEND_URL ?? "";

/** Reserve one warm fleet bot per game, sending the user's per-game ephemeral pubkey so the fleet
 *  pre-creates each tunnel (party A = user) + funds seat B. Games with no free bot (or whose open
 *  failed) are omitted by the backend, so the caller deposits only what it actually got back. */
export async function allocateArenaBots(
  games: ArenaGameRequest[],
  userAddress: string,
  api: ArenaApi = {},
): Promise<ArenaAllocation[]> {
  const doFetch = api.fetchFn ?? fetch;
  const res = await doFetch(`${backendUrl(api.apiBase)}/v1/arena/allocate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userAddress, games }),
  });
  if (!res.ok) throw new Error(`arena allocate failed: ${res.status}`);
  const body = (await res.json()) as { allocations: ArenaAllocation[] };
  return body.allocations;
}

/** Tell each reserved bot the user has joined (funded seat A, so its pre-opened tunnel is now
 *  active), the cue to start playing. No-op on empty. */
export async function reportArenaOpened(
  opened: Array<{ matchId: string; tunnelId: string }>,
  api: ArenaApi = {},
): Promise<void> {
  if (opened.length === 0) return;
  const doFetch = api.fetchFn ?? fetch;
  const res = await doFetch(`${backendUrl(api.apiBase)}/v1/arena/opened`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allocations: opened }),
  });
  if (!res.ok) throw new Error(`arena opened failed: ${res.status}`);
}

/**
 * One-signature arena entry (ADR-0025). `games` may REPEAT — N windows of the same game each get their
 * own bot. Mints one ephemeral key PER REQUEST, reserves a bot per request (the fleet pre-creates each
 * tunnel + funds seat B), then deposits seat A into every pre-opened tunnel in ONE batched PTB (the
 * batcher's deposit mode coalesces them — one wallet popup), and reports the user joined. `open` and
 * the API are injectable for tests; production uses the shared batcher + live `fetch`.
 *
 * Returns one {@link ArenaEntered} per SUCCESSFUL request (allocation + its baked-in keypair), so a
 * caller can hand each to `enterArenaMatch`. Games the backend couldn't serve are simply absent.
 */
export async function enterArena(
  opts: {
    games: string[];
    userAddress: string;
    /** Fallback per-seat stake if an allocation omits `stakeEach` (back-compat). Each game's
     *  deposit prefers `allocation.stakeEach` — the backend's single source of truth. */
    stakePerGame?: bigint;
    open?: (req: TunnelOpenRequest) => Promise<string>;
    coinType?: string;
    usesAddressBalance?: boolean;
  } & ArenaApi,
): Promise<ArenaEntered[]> {
  // A fresh ephemeral key PER REQUEST (games may repeat), aligned to the input order — its pubkey is
  // baked into that request's tunnel at allocate and the SAME key co-signs that match's moves.
  const keypairs = opts.games.map(() => generateKeyPair());
  const allocations = await allocateArenaBots(
    opts.games.map((game, i) => ({
      id: game,
      userEphPubkey: toHex(keypairs[i].publicKey),
    })),
    opts.userAddress,
    opts,
  );
  // Pair each returned allocation back to its request by ORDER WITHIN ITS GAME: the backend preserves
  // request order and omits games it couldn't serve, so the k-th allocation of game G is the k-th
  // request of G → its key is `keypairs[reqIdx]`. Correct for identical same-game requests (all serve →
  // in order; bot exhaustion drops the TAIL). A rare mid-run per-game omission mispairs — that window
  // then can't co-sign and surfaces an error, but no stake is lost (the deposit funds a recoverable tunnel).
  const reqIdxsByGame = new Map<string, number[]>();
  opts.games.forEach((game, i) => {
    const arr = reqIdxsByGame.get(game);
    if (arr) arr.push(i);
    else reqIdxsByGame.set(game, [i]);
  });
  const takenByGame = new Map<string, number>();
  const open = opts.open ?? requestTunnelOpen;
  const entered = await Promise.all(
    allocations.map(async (alloc): Promise<ArenaEntered | null> => {
      const k = takenByGame.get(alloc.game) ?? 0;
      takenByGame.set(alloc.game, k + 1);
      const reqIdx = reqIdxsByGame.get(alloc.game)?.[k];
      if (reqIdx == null) return null; // more allocations than requests for a game (shouldn't happen)
      const keypair = keypairs[reqIdx];
      const partyA: PartyOnchain = {
        address: opts.userAddress,
        publicKey: keypair.publicKey,
      };
      const partyB: PartyOnchain = {
        address: alloc.botAddress,
        publicKey: fromHex(alloc.botEphPubkey),
      };
      const aAmount =
        alloc.stakeEach != null ? BigInt(alloc.stakeEach) : opts.stakePerGame;
      if (aAmount == null)
        throw new Error(
          `arena: no stake for ${alloc.game} (allocation.stakeEach + stakePerGame both unset)`,
        );
      // `alloc.tunnelId` is authoritative — the deposit goes INTO it and can't change its id, so keep
      // it (the batcher resolves deposits by tunnelId, never by the shared party-A address).
      await open({
        mode: "deposit",
        tunnelId: alloc.tunnelId,
        partyA,
        partyB,
        aAmount,
        bAmount: 0n, // the fleet already funded seat B; unused in deposit mode
        coinType: opts.coinType,
        usesAddressBalance: opts.usesAddressBalance ?? true,
      });
      return { allocation: alloc, keypair };
    }),
  );
  const live = entered.filter((e): e is ArenaEntered => e != null);
  // Best-effort cue: the tunnels are already funded (deposit landed) and the fleet bot enters its move
  // loop on tunnel-open, not on this notification — so a failed/`503` "opened" report must NOT abort
  // entry and strand a funded tunnel. Log and continue so each game still auto-enters + plays.
  try {
    await reportArenaOpened(
      live.map((o) => ({
        matchId: o.allocation.matchId,
        tunnelId: o.allocation.tunnelId,
      })),
      opts,
    );
  } catch (e) {
    console.warn(
      "[arena] reportArenaOpened failed (tunnels funded; entering anyway)",
      e,
    );
  }
  return live;
}
