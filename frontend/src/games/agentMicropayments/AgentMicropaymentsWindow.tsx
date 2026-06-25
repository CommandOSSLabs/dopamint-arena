import type { MicropaymentsState } from "sui-tunnel-ts/protocol/agentMicropayments";
import { createAgentMicropaymentsKit } from "@/agent/games/agentMicropayments/kit";
import type { GameWindowProps } from "../types";
import { PaymentSelfPlay } from "../paymentSelfPlay/PaymentSelfPlay";

// 1 MTPS per seat; price = stake/10 so the budget drains in ~10 requests.
const STAKE_PER_SEAT = 1_000_000_000n;
const makeKit = (stake: bigint) =>
  createAgentMicropaymentsKit(stake / 10n, stake);

/** Real on-chain self-play: a consumer agent streams pay-per-request to a provider over a tunnel. */
export function AgentMicropaymentsWindow({ windowId }: GameWindowProps) {
  return (
    <PaymentSelfPlay
      windowId={windowId}
      createKit={makeKit}
      stakePerSeat={STAKE_PER_SEAT}
      countOf={(s: MicropaymentsState) => s.requests}
      consumer="Consumer agent"
      provider="Provider API"
      unit="request"
      blurb="A consumer agent streams pay-per-request to a provider over a real tunnel — metered off-chain, settled cooperatively."
    />
  );
}
