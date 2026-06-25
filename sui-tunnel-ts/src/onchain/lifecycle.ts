/**
 * On-chain bookend orchestration (Deliverable 4 / decision: "engineer + close a sample").
 *
 * Open and close are shared-object consensus transactions — the visible wall-clock ceiling.
 * This module keeps them off the hot path and makes them throughput-friendly: submit
 * WITHOUT awaiting full finality by default, parse the shared Tunnel id from effects, and
 * drive cooperative close / dispute recovery directly from the off-chain engine's signed
 * artifacts. It also adapts the txbuilders into a {@link RecoveryExecutor} for the watchtower.
 *
 * These functions talk to a live `SuiClient`; they are typed and documented but exercised
 * against a deployed package / localnet, not in unit tests (the pure pieces — txbuilders,
 * gas planning, recovery decisions — are unit-tested).
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { CoSignedSettlement, CoSignedUpdate } from "../core/tunnel";
import { Party } from "../protocol/Protocol";
import { RecoveryAction, RecoveryExecutor } from "../recovery/watchtower";
import * as tb from "./txbuilders";

export interface ExecOptions {
  /** Await full finality before resolving (default false — throughput-oriented). */
  waitForFinality?: boolean;
}

export interface ExecResult {
  digest: string;
  effects: unknown;
  objectChanges: unknown;
}

/** Sign + execute a transaction. By default does NOT await full finality. */
export async function execute(
  client: SuiClient,
  signer: Ed25519Keypair,
  tx: Transaction,
  opts: ExecOptions = {}
): Promise<ExecResult> {
  const res = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  });
  // A committed-but-Move-aborted tx resolves at the RPC layer with status "failure" — it
  // does NOT throw. Surface it so callers (e.g. the watchtower) don't mistake an aborted
  // recovery for a successful one and stop monitoring a tunnel that was never recovered.
  const status = (
    res.effects as { status?: { status?: string; error?: string } } | undefined
  )?.status;
  if (status?.status === "failure") {
    throw new Error(
      `transaction ${res.digest} failed on-chain: ${
        status.error ?? "unknown Move abort"
      }`
    );
  }
  if (opts.waitForFinality) {
    await client.waitForTransaction({ digest: res.digest });
  }
  return {
    digest: res.digest,
    effects: res.effects,
    objectChanges: res.objectChanges,
  };
}

/** Parse the created shared Tunnel<T> object id from a tx's objectChanges. */
export function parseTunnelId(objectChanges: unknown): string | null {
  if (!Array.isArray(objectChanges)) return null;
  for (const c of objectChanges as Array<Record<string, unknown>>) {
    if (
      c.type === "created" &&
      typeof c.objectType === "string" &&
      c.objectType.includes("::tunnel::Tunnel<")
    ) {
      return c.objectId as string;
    }
  }
  return null;
}

export interface OpenParams {
  partyA: tb.PartyArgs;
  partyB: tb.PartyArgs;
  timeoutMs: bigint;
  penaltyAmount?: bigint;
  coinType?: string;
}

/**
 * Create + share a tunnel (1 consensus tx). The shared object id is returned from effects.
 * Deposits are separate txs (deposit is keyed to ctx.sender), submitted by each party — see
 * {@link depositAs}. create+share+deposits = ~3 consensus txs per tunnel (DESIGN_REVIEW B2).
 */
export async function createTunnel(
  client: SuiClient,
  funder: Ed25519Keypair,
  p: OpenParams,
  opts: ExecOptions = {}
): Promise<{ tunnelId: string; digest: string }> {
  const tx = new Transaction();
  tb.buildCreateAndShare(tx, {
    partyA: p.partyA,
    partyB: p.partyB,
    timeoutMs: p.timeoutMs,
    penaltyAmount: p.penaltyAmount ?? 0n,
    coinType: p.coinType,
  });
  const res = await execute(client, funder, tx, opts);
  const tunnelId = parseTunnelId(res.objectChanges);
  if (!tunnelId) throw new Error("could not find created Tunnel id in effects");
  return { tunnelId, digest: res.digest };
}

/** Deposit `amount` (from gas) into `tunnelId`, signed by a party's own keypair. */
export async function depositAs(
  client: SuiClient,
  partySigner: Ed25519Keypair,
  tunnelId: string,
  amount: bigint,
  opts: ExecOptions = {}
): Promise<string> {
  const tx = new Transaction();
  tb.buildDepositFromGas(tx, { tunnelId, amount });
  const res = await execute(client, partySigner, tx, opts);
  return res.digest;
}

/** Cooperative close from the off-chain engine's settlement artifact (1 consensus tx). */
export async function closeCooperative(
  client: SuiClient,
  signer: Ed25519Keypair,
  tunnelId: string,
  settlement: CoSignedSettlement,
  opts: ExecOptions = {},
  coinType?: string
): Promise<string> {
  const tx = new Transaction();
  tb.buildCloseFromSettlement(tx, tunnelId, settlement, coinType);
  const res = await execute(client, signer, tx, opts);
  return res.digest;
}

/**
 * Settle a representative SAMPLE of tunnels (decision: prove the close path without paying
 * to close every tunnel). Returns the digests of the closes that were submitted.
 */
export async function sampleClose(
  client: SuiClient,
  signer: Ed25519Keypair,
  tunnels: { tunnelId: string; settlement: CoSignedSettlement }[],
  sampleSize: number,
  opts: ExecOptions = {},
  coinType?: string,
  signers?: Ed25519Keypair[]
): Promise<string[]> {
  const n = Math.min(sampleSize, tunnels.length);
  // With a pool of distinct signers, round-robin them and submit concurrently so the
  // closes use INDEPENDENT gas coins instead of serializing on one signer's single coin
  // version (the gas-sharding design — see gas.ts). A single signer stays serial: one gas
  // coin cannot be spent by concurrent txs safely.
  if (signers && signers.length > 1) {
    return Promise.all(
      tunnels
        .slice(0, n)
        .map((t, i) =>
          closeCooperative(
            client,
            signers[i % signers.length],
            t.tunnelId,
            t.settlement,
            opts,
            coinType
          )
        )
    );
  }
  const digests: string[] = [];
  for (let i = 0; i < n; i++) {
    digests.push(
      await closeCooperative(
        client,
        signer,
        tunnels[i].tunnelId,
        tunnels[i].settlement,
        opts,
        coinType
      )
    );
  }
  return digests;
}

/**
 * Build a {@link RecoveryExecutor} for the watchtower from live tx submission. The closures
 * supply, per tunnel: the signer to use, the latest co-signed update (for raise_dispute),
 * which party we are, and the recovery recipient address.
 */
export function makeRecoveryExecutor(
  client: SuiClient,
  ctx: {
    signerFor: (tunnelId: string) => Ed25519Keypair;
    latestUpdate: (tunnelId: string) => CoSignedUpdate | null;
    partyFor: (tunnelId: string) => Party;
    recipientFor: (tunnelId: string) => string;
    coinType?: string;
  }
): RecoveryExecutor {
  return async (tunnelId: string, action: Exclude<RecoveryAction, "none">) => {
    const tx = new Transaction();
    switch (action) {
      case "raise_dispute": {
        // decideRecovery chose raise_dispute precisely BECAUSE a newer co-signed state
        // exists. If the store can't produce it, fail loudly — silently falling back to
        // disputing the stale on-chain state would finalize an outdated balance split.
        const u = ctx.latestUpdate(tunnelId);
        if (!u) {
          throw new Error(
            `raise_dispute requires the latest co-signed update for ${tunnelId}, but latestUpdate() returned null`
          );
        }
        tb.buildRaiseDisputeFromUpdate(
          tx,
          tunnelId,
          u,
          ctx.partyFor(tunnelId),
          ctx.coinType
        );
        break;
      }
      case "resolve_dispute": {
        // A counterparty disputed with a STALE state; override it by submitting our latest
        // dual-signed state (must be strictly newer than the disputed on-chain nonce).
        const u = ctx.latestUpdate(tunnelId);
        if (!u) {
          throw new Error(
            `resolve_dispute requires the latest co-signed update for ${tunnelId}, but latestUpdate() returned null`
          );
        }
        tb.buildResolveDispute(tx, tunnelId, u, ctx.coinType);
        break;
      }
      case "raise_dispute_current_state":
        tb.buildRaiseDisputeCurrentState(tx, {
          tunnelId,
          coinType: ctx.coinType,
        });
        break;
      case "force_close":
        tb.buildForceClose(tx, { tunnelId, coinType: ctx.coinType });
        break;
      case "withdraw_timeout":
        tb.buildWithdrawTimeout(tx, {
          tunnelId,
          recipient: ctx.recipientFor(tunnelId),
          coinType: ctx.coinType,
        });
        break;
    }
    await execute(client, ctx.signerFor(tunnelId), tx);
  };
}
