import { cn } from "@/lib/utils";
import { formatMtps } from "../../utils";
import { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";

interface PaymentsShopHeaderProps {
  session: ReturnType<typeof useRegularPaymentsSession>;
}

export function PaymentsShopHeader({ session }: PaymentsShopHeaderProps) {
  return (
    <header
      className={cn(
        "shrink-0 border-b border-dashed border-(--sketch-ink)/15",
        "px-[clamp(8px,2.4cqmin,14px)] py-[clamp(8px,2cqmin,12px)]",
        "space-y-6",
      )}
    >
      <div className="flex justify-end">
        <button
          className={cn(
            "sketch-btn py-2",
            session.autoMode ? "sketch-btn--call" : "sketch-btn--ghost",
          )}
          onClick={session.toggleAutoMode}
        >
          {session.autoMode ? "Auto mode ON" : "Auto mode OFF"}
        </button>
      </div>

      <div className="flex items-center justify-between gap-2">
        <button
          className={cn("sketch-btn sketch-btn--ghost")}
          disabled={session.busy}
          onClick={session.goLobby}
        >
          ← Back
        </button>

        <span className="sketch-note text-[clamp(10px,2.4cqmin,12px)]">
          {`My Budget ${formatMtps(session.depositBudget)} MTPS`}
        </span>
      </div>
    </header>
  );
}
