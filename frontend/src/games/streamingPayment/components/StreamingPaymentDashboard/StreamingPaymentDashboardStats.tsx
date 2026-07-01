import { Progress } from "@/components/ui/progress";
import { useStreamingPaymentSession } from "../../hooks/useStreamingPaymentSession";
import { useStreamClockMeter } from "../../hooks/useStreamClockMeter";
import { formatMtps } from "../../utils";
import { BadgeStatus } from "../BadgeStatus";
import { StreamFields } from "@/onchain/streamingPayment";

interface StreamingPaymentDashboardStatsProps {
  session: ReturnType<typeof useStreamingPaymentSession>;
  stream: StreamFields;
}

export function StreamingPaymentDashboardStats({
  session,
  stream,
}: StreamingPaymentDashboardStatsProps) {
  const meter = useStreamClockMeter(stream);

  const ListStat = [
    {
      key: "Locked",
      value: formatMtps(meter.locked),
    },
    {
      key: "Withdrawn",
      value: formatMtps(stream.withdrawnAmount),
    },
    {
      key: "Per sec",
      value: formatMtps(session.ratePerSecond),
    },
  ];

  return (
    <>
      <div className="wal-glow rounded-[20px] border border-border bg-card/75 p-3 backdrop-blur-xl">
        <div className="flex justify-between">
          <span className="wal-eyebrow text-muted-foreground">Streamed</span>

          <span className="flex items-center gap-2">
            <BadgeStatus status={stream.status} />
          </span>
        </div>

        <div className="mt-0.5 wal-mono text-2xl font-semibold text-foreground">
          {formatMtps(meter.clockUnlocked)}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            / {formatMtps(stream.totalAmount, 0)} MTPS
          </span>
        </div>

        <Progress value={meter.fillPct} className="mt-2 h-1.5" />

        <div className="mt-1 wal-mono text-[11px] text-muted-foreground">
          {`${session.recipientName} can withdraw ${formatMtps(meter.available)} MTPS`}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {ListStat.map((stat) => (
          <div
            key={stat.key}
            className="rounded-xl border border-border bg-card/40 px-2 py-2 text-center"
          >
            <div className="wal-mono text-sm text-foreground">{stat.value}</div>

            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {stat.key}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
