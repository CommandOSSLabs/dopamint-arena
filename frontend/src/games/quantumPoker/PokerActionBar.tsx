import type { JSX } from "react";
import type { PokerMove } from "sui-tunnel-ts/protocol/quantumPoker";
import { pokerRaiseSizes } from "./pokerBetting";

/** The legal-action fields the bar needs — satisfied by both the self-play `PokerLegalActions` and
 *  PvP's `PvpPokerLegal`, so the Bot and PvP lanes share one bar. (`canBet` is derived: minBet > 0.) */
export interface PokerActionLegal {
  canCheck: boolean;
  canCall: boolean;
  callAmount: bigint;
  minBet: bigint;
  maxBet: bigint;
}

/**
 * Hand-drawn betting controls shared by the Bot and PvP windows. Emits abstract `PokerMove`s through
 * `onAct`; each caller adapts them to its own hook (the Bot lane's single `act`, PvP's fold/call/bet).
 * Three pot-relative raise sizes (½ pot, pot, all-in) come from the shared `pokerRaiseSizes` helper.
 */
export function PokerActionBar({
  legal,
  pot,
  onAct,
  secondsLeft,
}: {
  legal: PokerActionLegal;
  pot: bigint;
  onAct: (move: PokerMove) => void;
  secondsLeft: number | null;
}): JSX.Element {
  const raise = (amt: bigint) => onAct({ kind: "bet", amount: amt });
  const sizes = pokerRaiseSizes({
    pot,
    callAmount: legal.callAmount,
    minBet: legal.minBet,
    maxBet: legal.maxBet,
    canBet: legal.minBet > 0n,
  });
  return (
    <div className="flex flex-wrap items-center gap-[clamp(5px,1.8cqmin,12px)]">
      {secondsLeft != null && (
        <span
          className={`qp-timer tabular-nums${secondsLeft <= 3 ? " qp-timer--low motion-safe:animate-pulse" : ""}`}
        >
          {secondsLeft}s
        </span>
      )}
      <button type="button" className="qp-btn qp-btn--stop" onClick={() => onAct({ kind: "fold" })}>
        Fold
      </button>
      {legal.canCheck && (
        <button type="button" className="qp-btn" onClick={() => onAct({ kind: "check" })}>
          Check
        </button>
      )}
      {legal.canCall && (
        <button type="button" className="qp-btn qp-btn--call" onClick={() => onAct({ kind: "call" })}>
          Call {legal.callAmount.toString()}
        </button>
      )}
      {sizes.showHalf && (
        <button type="button" className="qp-btn" onClick={() => raise(sizes.half)}>
          ½ Pot · {sizes.half.toString()}
        </button>
      )}
      {sizes.showFull && (
        <button type="button" className="qp-btn" onClick={() => raise(sizes.full)}>
          Pot · {sizes.full.toString()}
        </button>
      )}
      {sizes.showAllIn && (
        <button type="button" className="qp-btn qp-btn--go" onClick={() => raise(sizes.allIn)}>
          All-in · {sizes.allIn.toString()}
        </button>
      )}
    </div>
  );
}
