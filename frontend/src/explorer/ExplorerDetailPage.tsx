import { useEffect, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useSuiClientContext } from "@mysten/dapp-kit";

import { Panel, PanelHeader, PanelTitle } from "@/components/ui/panel";
import {
  suivisionTxUrl,
  suivisionAccountUrl,
  truncateMiddle,
} from "@/lib/suivision";
import { getSettlement, type SettlementRow } from "@/backend/explorerClient";
import { VerifyPanel } from "./VerifyPanel";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="wal-eyebrow text-muted-foreground">{label}</span>
      <span className="wal-mono text-sm">{children}</span>
    </div>
  );
}

export function ExplorerDetailPage() {
  const { digest } = useParams({ from: "/explorer/$digest" });
  const { network } = useSuiClientContext();
  const [row, setRow] = useState<SettlementRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettlement(digest)
      .then(setRow)
      .catch((e) => setError(String(e)));
  }, [digest]);

  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-4 p-6">
      <Link
        to="/explorer"
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        ← All settlements
      </Link>

      <Panel>
        <PanelHeader>
          <PanelTitle>On-chain anchor</PanelTitle>
        </PanelHeader>
        <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3">
          {error && <p className="col-span-full text-destructive">{error}</p>}
          {row && (
            <>
              <Field label="Settle tx">
                <a
                  href={suivisionTxUrl(row.txDigest, network)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="hover:text-primary hover:underline"
                >
                  {truncateMiddle(row.txDigest)}
                </a>
              </Field>
              <Field label="Checkpoint">{row.checkpoint}</Field>
              <Field label="Closed at">
                {row.closedAtMs
                  ? new Date(row.closedAtMs).toLocaleString()
                  : "—"}
              </Field>
              <Field label="Tunnel">{truncateMiddle(row.tunnelId)}</Field>
              <Field label="Party A">
                {row.partyAAddr ? (
                  <a
                    href={suivisionAccountUrl(row.partyAAddr, network)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="hover:text-primary hover:underline"
                  >
                    {truncateMiddle(row.partyAAddr)}
                  </a>
                ) : (
                  "—"
                )}
              </Field>
              <Field label="Party B">
                {row.partyBAddr ? (
                  <a
                    href={suivisionAccountUrl(row.partyBAddr, network)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="hover:text-primary hover:underline"
                  >
                    {truncateMiddle(row.partyBAddr)}
                  </a>
                ) : (
                  "—"
                )}
              </Field>
              <Field label="Anchored root">
                {row.transcriptRoot
                  ? truncateMiddle(row.transcriptRoot, 8, 8)
                  : "—"}
              </Field>
              <Field label="Final balances">
                {(Number(row.partyABalance ?? 0) / 1e9).toString()} /{" "}
                {(Number(row.partyBBalance ?? 0) / 1e9).toString()} SUI
              </Field>
            </>
          )}
        </div>
      </Panel>

      {row && <VerifyPanel row={row} />}
    </div>
  );
}
