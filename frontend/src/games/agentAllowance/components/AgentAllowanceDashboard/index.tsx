import {
  Bot,
  CircleSlash,
  Loader2,
  PauseIcon,
  PlayIcon,
  Server,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { useAgentAllowanceSession } from "../../hooks/useAgentAllowanceSession";
import BadgeStatus from "../BadgeStatus";
import AgentAllowanceDashboardStats from "./AgentAllowanceDashboardStats";
import AgentAllowanceDashboardActivity from "./AgentAllowanceDashboardActivity";

interface AgentAllowanceDashboardProps {
  session: ReturnType<typeof useAgentAllowanceSession>;
}

export function AgentAllowanceDashboard({
  session,
}: AgentAllowanceDashboardProps) {
  const allowance = session.allowance!;

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="flex items-center gap-1.5 font-semibold text-foreground">
          <Bot className="size-4 text-primary" />
          {session.displayAgent}
        </span>

        <span className="text-muted-foreground">→</span>

        <span className="flex items-center gap-1.5 text-foreground">
          <Server className="size-4 text-muted-foreground" />
          {session.providerName}
        </span>

        <span className="ml-auto">
          <BadgeStatus status={allowance.status} />
        </span>
      </div>

      <AgentAllowanceDashboardStats session={session} allowance={allowance} />

      <div className="flex flex-col gap-1">
        <Button
          onClick={session.claim}
          disabled={session.busy || session.claimable <= 0n || session.isPaused}
          className="gap-1.5"
        >
          {session.phase === "claiming" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Zap className="size-4" />
          )}

          {session.phase === "claiming" ? "Paying" : "Pay now"}
        </Button>

        {!session.isPaused && !session.busy && session.claimable <= 0n && (
          <span className="text-center text-[11px] text-muted-foreground">
            Funds are building up — you can pay in a few seconds.
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          onClick={session.isPaused ? session.resume : session.pause}
          disabled={session.busy}
          className="gap-1.5"
        >
          {(function () {
            if (session.phase === "resuming" || session.phase === "pausing") {
              return <Loader2 className="animate-spin" />;
            }

            return session.isPaused ? <PlayIcon /> : <PauseIcon />;
          })()}

          {session.isPaused ? "Resume" : "Pause"}
        </Button>

        <Button
          variant="destructive"
          className="hover:opacity-90"
          disabled={session.busy}
          onClick={session.revoke}
        >
          {session.phase === "revoking" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <CircleSlash />
          )}
          Stop
        </Button>
      </div>

      {session.error && (
        <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {session.error}
        </p>
      )}

      <AgentAllowanceDashboardActivity session={session} />
    </div>
  );
}
