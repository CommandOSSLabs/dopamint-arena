// frontend/src/games/quantumPoker/pokerSettle.ts
// Cooperative close for a poker self-play tunnel: build the root-anchored
// settlement, both seats co-sign in-process, then submit via the gas-sponsored
// backend /settle (Walrus). Fall back to a party-paid on-chain close if /settle
// is down. Mirrors useBattleshipAuto's settle path.
import type { Transcript } from "sui-tunnel-ts/proof/transcript";
import { getControlPlaneClient } from "@/backend/controlPlane";
import { coSignedToSettleBody } from "@/backend/settleRequest";
import {
  closeCooperativeWithRoot,
  type SignExec,
} from "@/onchain/tunnelTx";
import type { PokerTunnel } from "./pokerSelfPlay";

export interface PokerSettleResult {
  txDigest: string;
  proofUrl: string | null;
}

export async function settlePokerTunnel(opts: {
  tunnel: PokerTunnel;
  transcript: Transcript;
  tunnelId: string;
  createdAt: bigint;
  fallbackSignExec: SignExec;
  /** Coin type `T` for the on-chain fallback close; defaults to SUI. Pass MTPS for the
   *  gas-sponsored stake model (the backend /settle reads the type off the tunnel itself). */
  coinType?: string;
}): Promise<PokerSettleResult> {
  const settlement = opts.tunnel.buildSettlementWithRoot(
    opts.createdAt,
    opts.transcript.root(),
    0n,
  );
  try {
    const r = await getControlPlaneClient().settle(
      opts.tunnelId,
      coSignedToSettleBody(settlement, opts.transcript.rawEntries()),
    );
    return { txDigest: r.txDigest, proofUrl: r.proofUrl };
  } catch (e) {
    console.error("[poker] backend settle failed; bot-key close:", e);
    const digest = await closeCooperativeWithRoot({
      signExec: opts.fallbackSignExec,
      tunnelId: opts.tunnelId,
      settlement,
      coinType: opts.coinType,
    });
    return { txDigest: digest, proofUrl: null };
  }
}
