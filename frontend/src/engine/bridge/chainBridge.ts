/**
 * Main-thread implementation of the chain half of `MainBridge`. The worker calls these;
 * all `@mysten/sui` tx-building + the dapp-kit signers + the Sui client stay here. Mirrors
 * the funding/settle calls in `pvp/pvpMatchHook.ts` so behaviour is identical to the
 * main-thread path — only the call site (a worker over the bridge) changes.
 */
import {
  openSharedTunnelStakedMany,
  openSelfPlayStaked,
  depositStakeStaked,
  type StakeStrategy,
} from "@/onchain/stakeTunnel";
import { closeCooperativeWithRoot, readCreatedAt } from "@/onchain/tunnelTx";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "@/onchain/mtps";
import { BulkOpenJob } from "../chain/bulkOpenJob";
import type {
  OpenTunnelParams,
  OpenSelfPlayParams,
  DepositStakeParams,
  CloseFallbackParams,
  MainBridge,
} from "../engineApi";

type Reads = Parameters<typeof openSharedTunnelStakedMany>[0]["reads"];

export interface ChainBridgeDeps {
  reads: Reads;
  signExec: StakeStrategy["walletSignExec"];
  sponsoredSignExec: StakeStrategy["sponsoredSignExec"];
  selectStakeCoin: StakeStrategy["selectStakeCoin"];
  prepareStake: StakeStrategy["prepareStake"];
  ensureStakeBalance: StakeStrategy["ensureStakeBalance"];
}

type ChainBridge = Pick<
  MainBridge,
  | "openTunnel"
  | "openSelfPlay"
  | "cancelOpen"
  | "depositStake"
  | "readCreatedAt"
  | "closeFallback"
>;

export function makeChainBridge(deps: ChainBridgeDeps): ChainBridge {
  const stake = (): StakeStrategy => ({
    sponsoredSignExec: deps.sponsoredSignExec,
    walletSignExec: deps.signExec,
    prepareStake: deps.prepareStake,
    selectStakeCoin: deps.selectStakeCoin,
    ensureStakeBalance: deps.ensureStakeBalance,
  });
  // Route seat-A opens through the time-windowed bulk-open job (design §4.1): a sender's window of
  // game opens coalesces into ONE sponsored PTB via the PvP many-open builder, so a flush costs one
  // Enoki sponsor+execute pair instead of N. The builder returns tunnel ids in INPUT ORDER, which
  // the job demuxes back to each intent.
  const bulkOpenJob = new BulkOpenJob(async (batch: OpenTunnelParams[]) => {
    const ids = await openSharedTunnelStakedMany({
      reads: deps.reads,
      specs: batch.map((p) => ({
        partyA: { address: p.partyA.address, publicKey: p.partyA.publicKey },
        partyB: { address: p.partyB.address, publicKey: p.partyB.publicKey },
        amount: p.amount,
        label: p.label,
      })),
      ...stake(),
    });
    return ids.map((tunnelId) => ({ tunnelId }));
  });
  return {
    openTunnel(p: OpenTunnelParams, intentId?: string) {
      return bulkOpenJob.enqueue(p, intentId);
    },
    // Self-play opens are NOT batched: each is a single `create_and_fund` of BOTH the player's own
    // bot seats (one wallet, one signature) with no opponent to coalesce against, so it opens
    // directly via the funding-strategy helper (no bulk-open window).
    async openSelfPlay(p: OpenSelfPlayParams) {
      const tunnelId = await openSelfPlayStaked({
        reads: deps.reads,
        partyA: { address: p.partyA.address, publicKey: p.partyA.publicKey },
        partyB: { address: p.partyB.address, publicKey: p.partyB.publicKey },
        aAmount: p.aAmount,
        bAmount: p.bAmount,
        label: p.label,
        ...stake(),
      });
      return { tunnelId };
    },
    // Orphan-tunnel cancel (design §4.1): the worker calls this from its match teardown so a
    // still-queued open is dropped before the window flushes. async to give the worker an awaitable
    // ack (engineClient.disposeWindow relies on it landing before terminate); the job no-ops if the
    // intent already flushed.
    async cancelOpen(intentId: string) {
      bulkOpenJob.cancel(intentId);
    },
    async depositStake(p: DepositStakeParams) {
      await depositStakeStaked({
        tunnelId: p.tunnelId,
        amount: p.amount,
        label: p.label,
        ...stake(),
      });
    },
    readCreatedAt(tunnelId: string) {
      return readCreatedAt(deps.reads, tunnelId);
    },
    async closeFallback(p: CloseFallbackParams) {
      // MTPS mode holds 0 SUI, so a wallet-signed close would strand the stake — use the
      // sponsored signer there, mirroring pvpMatchHook's settle fallback.
      await closeCooperativeWithRoot({
        signExec: (isMtpsConfigured
          ? deps.sponsoredSignExec
          : deps.signExec) as never,
        tunnelId: p.tunnelId,
        settlement: p.settlement,
        coinType: p.coinType ?? (isMtpsConfigured ? MTPS_COIN_TYPE : undefined),
      });
    },
  };
}
