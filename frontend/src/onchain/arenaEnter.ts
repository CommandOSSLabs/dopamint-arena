// Arena one-signature entry (ADR-0023). Connect wallet → reserve one warm fleet bot per game →
// open + fund-own-seat for every allocated game in ONE batched PTB (the seat-A batcher mode) →
// tell each bot its tunnel id so it deposits seat B. The user signs once; each game then plays
// genuine two-party against its bot over the relay.
import { fromHex } from "@mysten/sui/utils";
import { requestTunnelOpen } from "./sharedTunnelOpenBatcher";
import type { TunnelOpenRequest } from "./tunnelOpenBatcher";
import type { PartyOnchain } from "./tunnelTx";

/** One reserved bot from `POST /v1/arena/allocate` (wire shape, camelCase). */
export interface ArenaAllocation {
  game: string;
  matchId: string;
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
 *  receives winnings); `publicKey` is a fresh per-match ephemeral that co-signs moves. */
export type MakeUserParty = (
  game: string,
  matchId: string,
) => Promise<PartyOnchain>;

interface ArenaApi {
  /** Backend base URL; "" (same-origin) by default. Mirrors `resolveBackendUrl` in controlPlane. */
  apiBase?: string;
  fetchFn?: typeof fetch;
}

const backendUrl = (apiBase?: string): string =>
  apiBase ?? import.meta.env?.VITE_BACKEND_URL ?? "";

/** Reserve one warm fleet bot per game. Games with no free bot are omitted by the backend, so the
 *  caller opens only what it actually got back. */
export async function allocateArenaBots(
  games: string[],
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

/** Tell each reserved bot the tunnel the user just opened, so it deposits seat B. No-op on empty. */
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
 * One-signature arena entry. Allocates a bot per game, opens + funds seat A for every allocation in
 * ONE batched PTB (the batcher coalesces them — one wallet popup), then reports the opened tunnels.
 * `open` and the API are injectable for tests; production uses the shared batcher + live `fetch`.
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
  const allocations = await allocateArenaBots(
    opts.games,
    opts.userAddress,
    opts,
  );
  const open = opts.open ?? requestTunnelOpen;
  const opened = await Promise.all(
    allocations.map(async (alloc) => {
      const partyA = await opts.makeUserParty(alloc.game, alloc.matchId);
      const partyB: PartyOnchain = {
        address: alloc.botAddress,
        publicKey: fromHex(alloc.botEphPubkey),
      };
      const tunnelId = await open({
        partyA,
        partyB,
        aAmount: opts.stakePerGame,
        bAmount: 0n, // the bot funds seat B server-side; ignored in seatA mode
        fundMode: "seatA",
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
