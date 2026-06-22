// frontend/src/games/quantumPoker/pokerSettle.ts
// Cooperative close for a poker self-play tunnel: build the root-anchored
// settlement, both seats co-sign in-process, then submit via the gas-sponsored
// backend /settle (Walrus). Fall back to a party-paid on-chain close if /settle
// is down. Mirrors useBattleshipAuto's settle path.
import type { Transcript } from "sui-tunnel-ts/proof/transcript";
import { getControlPlaneClient } from "@/backend/controlPlane";
import { coSignedToSettleRequest } from "@/backend/settleRequest";
import {
  closeCooperativeWithRoot,
  type SignExec,
} from "@/onchain/tunnelTx";
import type { PokerTunnel } from "./pokerSelfPlay";

export async function settlePokerTunnel(opts: {
  tunnel: PokerTunnel;
  transcript: Transcript;
  tunnelId: string;
  createdAt: bigint;
  fallbackSignExec: SignExec;
}): Promise<void> {
  const settlement = opts.tunnel.buildSettlementWithRoot(
    opts.createdAt,
    opts.transcript.root(),
    0n,
  );
  try {
    await getControlPlaneClient().settle(
      opts.tunnelId,
      coSignedToSettleRequest(settlement, opts.transcript.toRecord().entries),
    );
  } catch (e) {
    console.error("[poker] backend settle failed; bot-key close:", e);
    await closeCooperativeWithRoot({
      signExec: opts.fallbackSignExec,
      tunnelId: opts.tunnelId,
      settlement,
    });
  }
}
