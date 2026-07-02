import { cn } from "@/lib/utils";
import { formatMtps } from "../../utils";
import { useAgentAllowanceSession } from "../../hooks/useAgentAllowanceSession";
import { AllowanceFields } from "@/onchain/agentAllowance";

interface AgentAllowanceDashboardStatsProps {
  session: ReturnType<typeof useAgentAllowanceSession>;
  allowance: AllowanceFields;
}

export default function AgentAllowanceDashboardStats({
  session,
  allowance,
}: AgentAllowanceDashboardStatsProps) {
  const ListStat = [
    {
      key: "Budget left",
      value: formatMtps(allowance.escrowBalance),
    },
    {
      key: "Paid",
      value: formatMtps(allowance.spent),
    },
    {
      key: "Per sec",
      value: formatMtps(allowance.ratePerSecond),
    },
  ];

  return (
    <>
      <div
        className={cn(
          "rounded-lg border border-border bg-card/60 p-3 transition-opacity",

          session.isPaused && "opacity-60",
        )}
      >
        <div className="flex items-center gap-2 text-[11px]">
          <span className="uppercase tracking-wide text-muted-foreground">
            {session.isPaused ? "Paused — not accruing" : "Ready to pay"}
          </span>

          {session.expiryLabel !== "no expiry" ? (
            <>
              <span>·</span>

              <span className="">{session.expiryLabel}</span>
            </>
          ) : null}
        </div>

        <div className="wal-mono mt-0.5 text-2xl font-semibold text-foreground">
          {formatMtps(session.available)}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            MTPS
          </span>
        </div>

        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200"
            style={{ width: `${session.fillPct}%` }}
          />
        </div>

        <div className="wal-mono mt-1 flex justify-between text-[11px] text-muted-foreground">
          <span>used {formatMtps(session.entitled)}</span>
          <span>budget {formatMtps(allowance.spendCap, 0)}</span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        {ListStat.map((meta) => (
          <div
            key={meta.key}
            className="rounded border border-border bg-card/40 px-1 py-1.5"
          >
            <div className="wal-mono text-sm text-foreground">{meta.value}</div>

            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {meta.key}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
