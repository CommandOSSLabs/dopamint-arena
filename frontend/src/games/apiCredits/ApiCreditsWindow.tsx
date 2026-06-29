import type { ApiCreditsState } from "sui-tunnel-ts/protocol/apiCredits";
import { createApiCreditsKit } from "@/agent/games/apiCredits/kit";
import type { GameWindowProps } from "../types";
import { PaymentSelfPlay } from "../paymentSelfPlay/PaymentSelfPlay";

// 1 MTPS per seat; cost = stake/10 so the credits drain in ~10 calls.
const STAKE_PER_SEAT = 1_000_000_000n;
const makeKit = (stake: bigint) => createApiCreditsKit(stake / 10n, stake);

/** Real on-chain self-play: a client spends prepaid credits per API call over a tunnel. */
export function ApiCreditsWindow({ windowId }: GameWindowProps) {
  return (
    <PaymentSelfPlay
      windowId={windowId}
      createKit={makeKit}
      stakePerSeat={STAKE_PER_SEAT}
      countOf={(s: ApiCreditsState) => s.calls}
      consumer="Client app"
      provider="API provider"
      unit="call"
      blurb="A client prepays credits and spends one per API call over a real tunnel — 2 on-chain txns regardless of call count."
    />
  );
}
