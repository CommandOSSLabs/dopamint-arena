import { useAgentAllowanceSession } from "../../hooks/useAgentAllowanceSession";
import { Bot, CircleSlash, Pause, Play, Zap } from "lucide-react";
import { formatMtps, timeAgo, txUrl } from "../../utils";
import { LedgerKind } from "../../types";
import {
  OBJ_EXPLORER_URL,
  TX_EXPLORER_URL,
} from "@/games/streamingPayment/utils";

interface AgentAllowanceDashboardActivityProps {
  session: ReturnType<typeof useAgentAllowanceSession>;
}

export default function AgentAllowanceDashboardActivity({
  session,
}: AgentAllowanceDashboardActivityProps) {
  const LEDGER_ICON = {
    create: Bot,
    pull: Zap,
    pause: Pause,
    resume: Play,
    revoke: CircleSlash,
  } as const;

  const LEDGER_LABEL = {
    create: "Started",
    pull: `Paid ${session.providerName}`,
    pause: "Paused",
    resume: "Resumed",
    revoke: "Stopped & refunded",
  } as const;

  return (
    <div className="space-y-2">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        Activity
      </p>

      <ul className="flex flex-col gap-1 max-h-26 overflow-y-auto">
        {session.ledger?.length ? (
          session.ledger.map((meta) => {
            const Icon = LEDGER_ICON[meta.kind];

            return (
              <li
                key={`${meta.kind}-${meta.digest ?? meta.at}`}
                className="flex items-center gap-2 rounded border border-border bg-card/40 px-2 py-1 text-xs"
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />

                <span className="min-w-0 truncate text-foreground">
                  {LEDGER_LABEL[meta.kind]}

                  {meta.amount != null && (
                    <span className="wal-mono ml-1 text-muted-foreground">
                      {formatMtps(meta.amount)} MTPS
                    </span>
                  )}
                </span>

                <div className="text-[10px] ml-auto flex items-center gap-2">
                  <p className="text-muted-foreground">{timeAgo(meta.at)}</p>

                  <>
                    <span>·</span>

                    <a
                      href={TX_EXPLORER_URL(meta.digest)}
                      target="_blank"
                      rel="noreferrer"
                      className="flex gap-1 items-center text-blue-500 hover:underline"
                    >
                      View Explorer
                    </a>
                  </>
                </div>
              </li>
            );
          })
        ) : (
          <li className="text-[11px] text-muted-foreground">
            No activity yet.
          </li>
        )}
      </ul>
    </div>
  );
}
