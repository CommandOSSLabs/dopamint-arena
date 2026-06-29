/**
 * Main-thread implementation of the chain half of `MainBridge`. The worker calls these;
 * all `@mysten/sui` tx-building + the dapp-kit signers + the Sui client stay here. Mirrors
 * the funding/settle calls in `pvp/pvpMatchHook.ts` so behaviour is identical to the
 * main-thread path — only the call site (a worker over the bridge) changes.
 */
import {
  openSharedTunnelStaked,
  depositStakeStaked,
  type StakeStrategy,
} from "@/onchain/stakeTunnel";
import { closeCooperativeWithRoot, readCreatedAt } from "@/onchain/tunnelTx";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "@/onchain/mtps";
import { BulkOpenJob } from "../chain/bulkOpenJob";
import type {
  OpenTunnelParams,
  DepositStakeParams,
  CloseFallbackParams,
  MainBridge,
} from "../engineApi";

type Reads = Parameters<typeof openSharedTunnelStaked>[0]["reads"];

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
  "openTunnel" | "depositStake" | "readCreatedAt" | "closeFallback"
>;

export function makeChainBridge(deps: ChainBridgeDeps): ChainBridge {
  const stake = (): StakeStrategy => ({
    sponsoredSignExec: deps.sponsoredSignExec,
    walletSignExec: deps.signExec,
    prepareStake: deps.prepareStake,
    selectStakeCoin: deps.selectStakeCoin,
    ensureStakeBalance: deps.ensureStakeBalance,
  });
  // Route seat-A opens through the time-windowed bulk-open job (design §4.1) so many game-window
  // opens can later coalesce into one sponsored PTB under the Enoki rate limit. Today the job
  // still calls this per-match opener once per intent (the PvP many-opens builder is pending);
  // it adds only the per-sender window + early-flush + demux scaffolding, behind the flag.
  const bulkOpenJob = new BulkOpenJob(async (p: OpenTunnelParams) => {
    const tunnelId = await openSharedTunnelStaked({
      reads: deps.reads,
      partyA: { address: p.partyA.address, publicKey: p.partyA.publicKey },
      partyB: { address: p.partyB.address, publicKey: p.partyB.publicKey },
      amount: p.amount,
      label: p.label,
      ...stake(),
    });
    return { tunnelId };
  });
  return {
    openTunnel(p: OpenTunnelParams) {
      return bulkOpenJob.enqueue(p);
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
