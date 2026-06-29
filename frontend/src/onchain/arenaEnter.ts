// Arena one-signature entry (ADR-0025, refining ADR-0023). Connect wallet → generate one ephemeral
// key per game → reserve one warm fleet bot per game, which PRE-CREATES the tunnel + funds seat B →
// deposit seat A into every pre-opened tunnel in ONE batched PTB (the batcher's deposit mode). The
// tunnel activates on that single signature; each game then plays genuine two-party over the relay.
import { fromHex, toHex } from "@mysten/sui/utils";
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
}

/** One opened arena game: the bot to play, the relay match, and the live tunnel. */
export interface ArenaOpened {
  game: string;
  matchId: string;
  tunnelId: string;
}

/** Mint the user's party A for one game's tunnel: `address` is the connected wallet (funds seat A,
 *  receives winnings); `publicKey` is a fresh per-game ephemeral that co-signs moves. Called BEFORE
 *  allocate (ADR-0025) — the pubkey is sent so the fleet can bake it into the tunnel at create. */
export type MakeUserParty = (game: string) => Promise<PartyOnchain>;

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
 * One-signature arena entry (ADR-0025). Generates a per-game ephemeral key, reserves a bot per game
 * (the fleet pre-creates each tunnel + funds seat B), then deposits seat A into every pre-opened
 * tunnel in ONE batched PTB (the batcher's deposit mode coalesces them — one wallet popup), and
 * reports the user joined. `open` and the API are injectable for tests; production uses the shared
 * batcher + live `fetch`.
 */
export async function enterArena(
  opts: {
    games: string[];
    userAddress: string;
    stakePerGame: bigint;
    makeUserParty: MakeUserParty;
    open?: (req: TunnelOpenRequest) => Promise<string>;
    coinType?: string;
    usesAddressBalance?: boolean;
  } & ArenaApi,
): Promise<ArenaOpened[]> {
  // A fresh ephemeral key per game, BEFORE allocate — its pubkey is baked into the tunnel at create.
  const parties = new Map<string, PartyOnchain>();
  await Promise.all(
    opts.games.map(async (game) => {
      parties.set(game, await opts.makeUserParty(game));
    }),
  );
  const allocations = await allocateArenaBots(
    opts.games.map((game) => ({
      id: game,
      userEphPubkey: toHex(parties.get(game)!.publicKey),
    })),
    opts.userAddress,
    opts,
  );
  const open = opts.open ?? requestTunnelOpen;
  const opened = await Promise.all(
    allocations.map(async (alloc) => {
      const partyA = parties.get(alloc.game)!;
      const partyB: PartyOnchain = {
        address: alloc.botAddress,
        publicKey: fromHex(alloc.botEphPubkey),
      };
      const tunnelId = await open({
        mode: "deposit",
        tunnelId: alloc.tunnelId,
        partyA,
        partyB,
        aAmount: opts.stakePerGame,
        bAmount: 0n, // the fleet already funded seat B; unused in deposit mode
        coinType: opts.coinType,
        usesAddressBalance: opts.usesAddressBalance ?? true,
      });
      return { game: alloc.game, matchId: alloc.matchId, tunnelId };
    }),
  );
  await reportArenaOpened(
    opened.map((o) => ({ matchId: o.matchId, tunnelId: o.tunnelId })),
    opts,
  );
  return opened;
}
