import { randomUUID } from "node:crypto";
import type { SuiClient } from "./suiClient";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Ed25519Keypair as KP } from "@mysten/sui/keypairs/ed25519";
import { makeSeats, playMatch, type MatchResult } from "./match";
import { pairLocalChannel } from "./channels/localChannel";
import { connectRelaySeat } from "./channels/relayChannel";
import { kitFor, gameStake } from "./games";
import { openSpec, openTunnels, settleTunnel } from "./onchain";
import { relayWsUrl } from "./relayProcess";
import type { Transport } from "../../../sui-tunnel-ts/src/core/distributedTunnel";

export type Phased = MatchResult & { openMs: number; playMs: number; settleMs: number };

export async function runFullMatch(
  game: string,
  channel: "local" | "relay",
  anchor: "onchain" | "offchain",
  ctx: { client?: SuiClient; funder?: Ed25519Keypair },
): Promise<Phased> {
  const id = randomUUID();
  const seats = makeSeats(id, { a: gameStake(game), b: gameStake(game) }, 0n);
  let openMs = 0;
  if (anchor === "onchain") {
    if (!ctx.client || !ctx.funder) throw new Error("onchain anchor requires client+funder");
    const t0 = performance.now();
    const [tunnelId] = await openTunnels(ctx.client, ctx.funder, [openSpec(seats)]);
    if (!tunnelId) throw new Error("open produced no tunnel id");
    seats.tunnelId = tunnelId;
    // Fetch the on-chain created_at so settlement timestamps satisfy
    //   tunnel.created_at <= timestamp <= clock.now.
    // Our local clock runs slightly ahead of the consensus clock at tx execution,
    // so we read the canonical value rather than relying on Date.now().
    const obj = await ctx.client.getObject({ id: tunnelId, options: { showContent: true } });
    const onchainCreatedAt = BigInt((obj.data?.content as any)?.fields?.created_at ?? 0);
    if (onchainCreatedAt > 0n) seats.createdAt = onchainCreatedAt;
    openMs = performance.now() - t0;
  }
  // offchain: keep the synthetic seats.tunnelId (= derived hex from id); no chain touched.

  let transports: [Transport, Transport];
  const closers: Array<() => void> = [];
  if (channel === "local") {
    transports = pairLocalChannel();
  } else {
    const token = `bench-${id}`;
    const [sa, sb] = await Promise.all([
      connectRelaySeat({ url: relayWsUrl(), game: token, keypair: new KP() }),
      connectRelaySeat({ url: relayWsUrl(), game: token, keypair: new KP() }),
    ]);
    closers.push(sa.close, sb.close);
    const byRole = (r: "A" | "B") => (sa.role === r ? sa.transport : sb.transport);
    transports = [byRole("A"), byRole("B")];
  }

  const t1 = performance.now();
  const res = await playMatch(kitFor(game), seats, transports, { maxMoves: 1000 });
  const playMs = performance.now() - t1;
  for (const c of closers) c();

  let settleMs = 0;
  if (anchor === "onchain") {
    const t2 = performance.now();
    await settleTunnel(ctx.client!, ctx.funder!, seats.tunnelId, res.settlement);
    settleMs = performance.now() - t2;
  }
  return { ...res, openMs, playMs, settleMs };
}
