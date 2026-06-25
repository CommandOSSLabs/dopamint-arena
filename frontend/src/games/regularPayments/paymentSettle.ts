import type { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import type { PaymentMove, PaymentsState } from "sui-tunnel-ts/protocol/payments";
import type { Transcript } from "sui-tunnel-ts/proof/transcript";
import { settleViaBackend } from "@/backend/settle";
import { closeCooperativeWithRoot, type SignExec } from "@/onchain/tunnelTx";

export type PaymentTunnel = OffchainTunnel<PaymentsState, PaymentMove>;

export async function settlePaymentTunnel(opts: {
  tunnel: PaymentTunnel;
  transcript: Transcript;
  tunnelId: string;
  createdAt: bigint;
  fallbackSignExec: SignExec;
  /** Coin type `T` for the on-chain fallback close; defaults to SUI. */
  coinType?: string;
}): Promise<string | undefined> {
  const settlement = opts.tunnel.buildSettlementWithRoot(
    opts.createdAt,
    opts.transcript.root(),
    0n,
  );
  return settleViaBackend({
    tunnelId: opts.tunnelId,
    settlement,
    transcript: opts.transcript.rawEntries(),
    label: "regular-payments",
    fallbackClose: () =>
      closeCooperativeWithRoot({
        signExec: opts.fallbackSignExec,
        tunnelId: opts.tunnelId,
        settlement,
        coinType: opts.coinType,
      }),
  });
}