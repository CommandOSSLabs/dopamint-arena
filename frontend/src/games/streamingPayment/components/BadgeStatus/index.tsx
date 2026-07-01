import { Badge } from "@/components/ui/badge";
import { StreamStatus, streamStatusName } from "@/onchain/streamingPayment";

interface BadgeStatusProps {
  status: number;
}

export function BadgeStatus({ status }: BadgeStatusProps) {
  const variant =
    status === StreamStatus.ACTIVE
      ? "default"
      : status === StreamStatus.COMPLETED
        ? "secondary"
        : "destructive";

  return <Badge variant={variant}>{streamStatusName(status)}</Badge>;
}
