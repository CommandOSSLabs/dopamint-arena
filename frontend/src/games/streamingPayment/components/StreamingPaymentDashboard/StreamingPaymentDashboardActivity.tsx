import { Banknote, Check, CircleSlash, Plus } from "lucide-react";

import { OBJ_EXPLORER_URL, TX_EXPLORER_URL } from "../../utils/constants";
import { formatMtps, timeAgo } from "../../utils/formatMtps";
import { LedgerEntry } from "../../types";

interface StreamingPaymentDashboardActivityProps {
  ledger: LedgerEntry[];
}

export function StreamingPaymentDashboardActivity({
  ledger,
}: StreamingPaymentDashboardActivityProps) {
  const LEDGER_ICON = {
    create: Banknote,
    topup: Plus,
    cancel: CircleSlash,
    complete: Check,
  } as const;

  const LEDGER_LABEL = {
    create: "Stream started",
    topup: "Topped up",
    cancel: "Cancelled & refunded",
    complete: "Stream completed",
  } as const;

  return (
    <div className="space-y-2">
      <p className="wal-eyebrow text-muted-foreground">Activity</p>

      <ul className="flex flex-col gap-1">
        {ledger.length ? (
          ledger.map((meta) => {
            const Icon = LEDGER_ICON[meta.kind];
            const explorerUrl =
              meta.kind === "complete" && meta.digest
                ? OBJ_EXPLORER_URL(meta.digest)
                : meta.digest
                  ? TX_EXPLORER_URL(meta.digest)
                  : null;

            return (
              <li
                key={`${meta.kind}-${meta.digest ?? meta.at}`}
                className="flex items-center gap-2 rounded-lg border border-border bg-card/40 px-2 py-1 text-xs"
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />

                <span className="min-w-0 truncate text-foreground">
                  {LEDGER_LABEL[meta.kind]}

                  {meta.amount ? (
                    <span className="ml-1 wal-mono text-muted-foreground">
                      {formatMtps(meta.amount)} MTPS
                    </span>
                  ) : null}
                </span>

                <div className="text-[10px] ml-auto flex items-center gap-2">
                  <p className="text-muted-foreground">{timeAgo(meta.at)}</p>

                  {explorerUrl ? (
                    <>
                      <span>·</span>

                      <a
                        href={explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex gap-1 items-center text-blue-500 hover:underline"
                      >
                        View Explorer
                      </a>
                    </>
                  ) : null}
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
