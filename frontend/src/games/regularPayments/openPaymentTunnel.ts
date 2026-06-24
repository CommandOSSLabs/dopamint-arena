import {
  MTPS_COIN_TYPE,
  isMtpsAddressBalance,
  isMtpsConfigured,
} from "@/onchain/mtps";
import { withSponsorFallback } from "@/onchain/sponsor";
import {
  openAndFundSelfPlay,
  type PartyOnchain,
  type SignExec,
  type SuiReads,
} from "@/onchain/tunnelTx";
import {
  DEPOSIT_A_MIST,
  DEPOSIT_B_MIST,
  OPEN_TOTAL_MIST,
  PAYMENT_SHOP_STAKE_SUI,
} from "./constants";

type OpenDeps = {
  reads: SuiReads;
  signExec: SignExec;
  sponsoredSignExec: SignExec;
  selectStakeCoin: (min: bigint) => Promise<string>;
  prepareStake: (need: bigint) => Promise<string>;
  ensureStakeBalance: (need: bigint) => Promise<void>;
};

/**
 * Open a self-play payment tunnel. User wallet funds party A (purchase budget) plus the
 * 1-MIST party-B activation dust in one `create_and_fund` tx.
 */
export async function openPaymentTunnel(
  deps: OpenDeps,
  partyA: PartyOnchain,
  partyB: PartyOnchain,
): Promise<string> {
  const base = {
    reads: deps.reads,
    partyA,
    partyB,
    aAmount: DEPOSIT_A_MIST,
    bAmount: DEPOSIT_B_MIST,
  };

  if (isMtpsConfigured) {
    if (isMtpsAddressBalance) await deps.ensureStakeBalance(OPEN_TOTAL_MIST);
    return openAndFundSelfPlay({
      ...base,
      signExec: deps.sponsoredSignExec,
      coinType: MTPS_COIN_TYPE,
      ...(isMtpsAddressBalance
        ? {
            stakeFromBalance: {
              amount: OPEN_TOTAL_MIST,
              coinType: MTPS_COIN_TYPE,
            },
          }
        : { stakeCoinId: await deps.prepareStake(OPEN_TOTAL_MIST) }),
    });
  }

  // Phase-1 SUI test: sender-pays open when MTPS env is unset. When MTPS *is* set the gas
  // sponsor only accepts `Tunnel<MTPS>` — a SUI open must not route through `/v1/sponsor`.
  if (PAYMENT_SHOP_STAKE_SUI) {
    return openAndFundSelfPlay({
      ...base,
      signExec: deps.signExec,
    });
  }

  return withSponsorFallback(
    async () => {
      const stakeCoinId = await deps.selectStakeCoin(OPEN_TOTAL_MIST);
      return openAndFundSelfPlay({
        ...base,
        signExec: deps.sponsoredSignExec,
        stakeCoinId,
      });
    },
    () =>
      openAndFundSelfPlay({
        ...base,
        signExec: deps.signExec,
      }),
    "regular-payments open",
  );
}