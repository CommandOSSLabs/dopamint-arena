import { cn } from "@/lib/utils";
import { AllowanceStatus, allowanceStatusName } from "@/onchain/agentAllowance";

export default function BadgeStatus({ status }: { status: number }) {
  const isActive = status === AllowanceStatus.ACTIVE;
  const isPaused = status === AllowanceStatus.PAUSED;

  const color = isActive
    ? "text-emerald-500 border-emerald-500/40"
    : isPaused
      ? "text-amber-500 border-amber-500/40"
      : "text-rose-500 border-rose-500/40";

  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[10px] font-medium",
        color,
      )}
    >
      {allowanceStatusName(status)}
    </span>
  );
}
