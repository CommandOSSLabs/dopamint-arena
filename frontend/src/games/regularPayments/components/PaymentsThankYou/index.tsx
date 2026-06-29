import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { formatGrammarLength, formatMtps } from "../../utils";
import type { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";

const AUTO_RETURN_SEC = 3;

interface PaymentsThankYouProps {
  session: ReturnType<typeof useRegularPaymentsSession>;
}

export function PaymentsThankYou({ session }: PaymentsThankYouProps) {
  const [secondsLeft, setSecondsLeft] = useState(AUTO_RETURN_SEC);

  useEffect(() => {
    const id = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(id);
          session.completeRound();
          return 0;
        }

        return s - 1;
      });
    }, 1000);

    return () => clearInterval(id);
  }, [session.completeRound]);

  return (
    <div className="sketch-welcome h-full min-h-0">
      <div
        className={cn(
          "sketch-welcome__card sketch-panel sketch-stroke sketch-stroke--felt",
          "w-full max-w-sm",
          "gap-2!",
        )}
      >
        <p className="text-[clamp(2.5rem,10cqmin,3.5rem)] leading-none text-(--sketch-felt)">
          ✓
        </p>

        <h2 className="sketch-title text-[clamp(1.1rem,4cqmin,1.4rem)]">
          Thank you for shopping at Tunnel Mart
        </h2>

        <p className="sketch-note">
          Your off-chain payment completed.
          {`Total paid: ${formatMtps(session.cartTotal)} MTPS · ${session.cart.length} ${formatGrammarLength("line", session.cart.length)}`}
        </p>

        {session.settleUrl && (
          <p className="sketch-note">
            <a
              href={session.settleUrl}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              View settle tx
            </a>
          </p>
        )}

        <div className="sketch-welcome__actions w-full max-w-none">
          <button
            className={cn("sketch-btn sketch-btn--call w-full py-3 font-bold")}
            onClick={session.completeRound}
          >
            {`Go lobby (${secondsLeft}s)`}
          </button>
        </div>
      </div>
    </div>
  );
}
