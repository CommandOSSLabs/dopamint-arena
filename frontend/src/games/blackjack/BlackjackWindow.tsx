import type { GameWindowProps } from "../types";
import { useBlackjackSession } from "./useBlackjackSession";
import { BetPanel } from "./components/BetPanel";
import { BlackjackTable } from "./components/BlackjackTable";

/** Bot-vs-bot Blackjack over a Sui tunnel. The player only sets a stake. */
export function BlackjackWindow(_props: GameWindowProps) {
  const { status, view, result, start, reset } = useBlackjackSession();

  if (status === "idle" || !view) {
    return <BetPanel onDeal={start} />;
  }

  return (
    <BlackjackTable
      view={view}
      result={result}
      settled={status === "settled"}
      onPlayAgain={reset}
    />
  );
}
