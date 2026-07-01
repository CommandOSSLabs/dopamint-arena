import { CircleSlash, Loader2, Plus, Send, User, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StreamStatus } from "@/onchain/streamingPayment";

import { StreamingPaymentDashboardComplete } from "./StreamingPaymentDashboardComplete";
import { StreamingPaymentDashboardActivity } from "./StreamingPaymentDashboardActivity";
import { StreamingPaymentDashboardStats } from "./StreamingPaymentDashboardStats";
import { useStreamingPaymentSession } from "../../hooks/useStreamingPaymentSession";

interface StreamingPaymentDashboardProps {
  session: ReturnType<typeof useStreamingPaymentSession>;
}

export function StreamingPaymentDashboard({
  session,
}: StreamingPaymentDashboardProps) {
  const stream = session.stream!;

  const isActive = stream.status === StreamStatus.ACTIVE;
  const isCancelled = stream.status === StreamStatus.CANCELLED;
  const isCompleted = session.vestComplete;
  const isTerminal = isCompleted || isCancelled;
  const returnReason = isCompleted ? "vest" : isCancelled ? "cancel" : null;

  return (
    <div className="space-y-6 p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="flex items-center gap-1.5 font-semibold text-foreground">
          <Send className="size-4 text-primary" />
          You
        </span>

        <span className="text-muted-foreground">→</span>

        <span className="flex items-center gap-1.5 text-foreground">
          <User className="size-4 text-muted-foreground" />
          {session.recipientName}
        </span>

        <Button
          variant={session.autoMode ? "default" : "outline"}
          size="sm"
          onClick={session.toggleAutoMode}
          className="ml-auto"
          disabled={!isActive || session.busy}
        >
          <Zap className="size-3" />

          {session.autoMode ? "Auto ON" : "Auto OFF"}
        </Button>
      </div>

      <div className="space-y-3">
        <StreamingPaymentDashboardStats session={session} stream={stream} />

        {returnReason ? (
          <StreamingPaymentDashboardComplete
            session={session}
            reason={returnReason}
          />
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              onClick={session.topUp}
              disabled={session.busy || !isActive || isTerminal}
              className="gap-1.5"
            >
              {session.phase === "toppingUp" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Top up
            </Button>

            <Button
              variant="destructive"
              onClick={session.cancelStream}
              disabled={session.busy || !isActive || isTerminal}
              className="hover:opacity-90"
            >
              {session.phase === "cancelling" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <CircleSlash className="size-4" />
              )}
              Cancel
            </Button>
          </div>
        )}

        {session.error && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {session.error}
          </p>
        )}

        <StreamingPaymentDashboardActivity ledger={session.ledger} />
      </div>
    </div>
  );
}
