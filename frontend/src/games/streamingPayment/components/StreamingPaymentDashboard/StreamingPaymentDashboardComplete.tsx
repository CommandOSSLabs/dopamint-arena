import { useEffect, useState } from "react";

import { useStreamingPaymentSession } from "../../hooks/useStreamingPaymentSession";
import { AUTO_RETURN_SEC } from "../../utils/constants";

export type ReturnBannerReason = "vest" | "cancel";

interface StreamingPaymentDashboardCompleteProps {
  session: ReturnType<typeof useStreamingPaymentSession>;
  reason: ReturnBannerReason;
}

const BANNER_COPY: Record<ReturnBannerReason, string> = {
  vest: "Stream complete. Back to the lobby in",
  cancel: "Stream cancelled. Back to the lobby in",
};

export function StreamingPaymentDashboardComplete({
  session,
  reason,
}: StreamingPaymentDashboardCompleteProps) {
  const [secondsLeft, setSecondsLeft] = useState(AUTO_RETURN_SEC);

  useEffect(() => {
    setSecondsLeft(AUTO_RETURN_SEC);

    const id = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(id);

          /* 
            Calling session.completeRound() inside the setSecondsLeft updater triggers a parent store update during React's state update.
            Moving completeRound() to timeout is good apporach
          */
          setTimeout(() => {
            session.completeRound();
          }, 0);

          return 0;
        }
        return s - 1;
      });
    }, 1000);

    return () => clearInterval(id);
  }, [reason, session.completeRound]);

  return (
    <p className="rounded-xl border border-border bg-card/60 px-3 py-3 text-center text-sm font-medium text-muted-foreground">
      {BANNER_COPY[reason]}{" "}
      <button
        type="button"
        className="wal-mono font-semibold tabular-nums text-foreground underline-offset-4 hover:underline"
        onClick={session.completeRound}
      >
        {secondsLeft}s
      </button>
      .
    </p>
  );
}
