import { Transaction } from "@mysten/sui/transactions";
import type { SuiClient } from "./suiClient";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  buildOpenAndFundMany,
  type TunnelOpenSpec,
} from "../../../sui-tunnel-ts/src/onchain/createAndFund";
import { buildCloseWithRootFromSettlement } from "../../../sui-tunnel-ts/src/onchain/txbuilders";
import { execute } from "../../../sui-tunnel-ts/src/onchain/lifecycle";
import { getCreatedObjectIds } from "../../../sui-tunnel-ts/src/utils";
import type { CoSignedSettlementWithRoot } from "../../../sui-tunnel-ts/src/core/tunnel";
import type { Seats } from "./match";

/**
 * Maps a `Seats` descriptor into a `TunnelOpenSpec` for `buildOpenAndFundMany`.
 * `PartyArgs.signatureType` is the numeric scheme id stored in the Move contract;
 * `KeyPair.scheme` carries the same value.
 */
export function openSpec(seats: Seats): TunnelOpenSpec {
  const party = (p: Seats["partyA"]) => ({
    address: p.address,
    publicKey: p.keyPair.publicKey,
    signatureType: p.keyPair.scheme,
  });
  return {
    partyA: party(seats.partyA),
    partyB: party(seats.partyB),
    aAmount: seats.balances.a,
    bAmount: seats.balances.b,
    timeoutMs: 3_600_000n,
  };
}

/**
 * Opens N tunnels in one PTB and returns the created shared-object ids (in
 * creation order, matching the input `specs` order).
 */
export async function openTunnels(
  client: SuiClient,
  funder: Ed25519Keypair,
  specs: TunnelOpenSpec[],
): Promise<string[]> {
  const tx = new Transaction();
  buildOpenAndFundMany(tx, specs);
  const res = await execute(client, funder, tx, { waitForFinality: true });
  return getCreatedObjectIds(res.objectChanges as any[], "::tunnel::Tunnel<");
}

/**
 * Cooperatively closes a single tunnel from a co-signed settlement.
 * Returns the transaction digest.
 */
export async function settleTunnel(
  client: SuiClient,
  funder: Ed25519Keypair,
  tunnelId: string,
  settlement: CoSignedSettlementWithRoot,
): Promise<string> {
  const tx = new Transaction();
  buildCloseWithRootFromSettlement(tx, tunnelId, settlement);
  const res = await execute(client, funder, tx, { waitForFinality: true });
  return res.digest;
}
