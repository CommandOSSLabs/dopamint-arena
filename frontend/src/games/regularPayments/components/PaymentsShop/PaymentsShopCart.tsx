import { cn } from "@/lib/utils";
import type { RefObject } from "react";
import { formatGrammarLength, formatMtps } from "../../utils";
import { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";
import { Trash2Icon } from "lucide-react";

interface PaymentsShopCartProps {
  session: ReturnType<typeof useRegularPaymentsSession>;
  cartTargetRef?: RefObject<HTMLSpanElement | null>;
}

export function PaymentsShopCart({
  session,
  cartTargetRef,
}: PaymentsShopCartProps) {
  const progressPct = Math.min(
    100,
    (Number(session.paidSoFar) / Number(session.depositBudget)) * 100,
  );

  return (
    <div
      className={cn(
        "shrink-0 border-t-[3px] border-(--sketch-felt)",
        "bg-[color-mix(in_srgb,var(--sketch-felt-fill)_55%,var(--sketch-paper))]",
      )}
    >
      <div
        className={cn(
          "px-[clamp(10px,2.6cqmin,14px)] py-[clamp(8px,2cqmin,12px)]",
          "space-y-2",
        )}
      >
        <div className="flex items-center justify-between">
          <div
            className={cn(
              "flex items-center gap-2",
              "text-[clamp(12px,3cqmin,15px)]",
            )}
          >
            <span ref={cartTargetRef}>🛒</span>

            <span>
              {`${session.itemCount} ${formatGrammarLength("item", session.itemCount)} · ${formatMtps(session.cartTotal)} MTPS`}
            </span>
          </div>

          <button
            disabled={!session.itemCount || session.busy}
            onClick={() => session.payNow()}
            className={cn("sketch-btn sketch-btn--go py-3 font-bold")}
          >
            {(function () {
              switch (session.phase) {
                case "paying":
                  return "Paying";

                case "settling":
                  return "Settling";

                default:
                  return "Pay now";
              }
            })()}
          </button>
        </div>

        {progressPct ? (
          <div>
            <div
              className={cn(
                "h-2 overflow-hidden rounded-sm border border-(--sketch-ink)/20",
                "bg-(--sketch-paper)",
              )}
            >
              <div
                className="h-full bg-(--sketch-felt)"
                style={{ width: `${progressPct}%` }}
              />
            </div>

            <p className="sketch-note mt-1 text-[clamp(9px,2.2cqmin,11px)]">
              {`Paid ${formatMtps(session.paidSoFar)} MTPS`}
            </p>
          </div>
        ) : null}
      </div>

      <ul
        className={cn(
          "px-[clamp(10px,2.6cqmin,14px)] pb-[clamp(6px,1.6cqmin,10px)]",
          "max-h-22 overflow-y-auto",
          "flex flex-col gap-2",
        )}
      >
        {session.cart.map((line) => (
          <li
            key={line.id}
            className={cn(
              "sketch-panel sketch-stroke flex items-center gap-2",
              "px-2 py-1.5",
            )}
          >
            <span className="text-lg leading-none">{line.emoji}</span>

            <span className="min-w-0 flex-1 truncate text-[clamp(10px,2.6cqmin,12px)]">
              {line.qty}× {line.name}
            </span>

            <div className="flex items-center gap-1">
              <span className="sketch-note text-[clamp(10px,2.4cqmin,12px)]">
                {formatMtps(line.priceMtps * BigInt(line.qty))} MTPS
              </span>

              <button
                type="button"
                className="shrink-0 p-0.5 disabled:opacity-45"
                disabled={session.busy}
                onClick={() => {
                  // stop Auto mode when click manually
                  if (session.autoMode) session.toggleAutoMode();

                  session.removeFromCart(line.id);
                }}
              >
                <Trash2Icon className="size-5 text-red-500" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
