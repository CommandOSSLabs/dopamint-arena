import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";

import { Panel, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { Input } from "@/components/ui/input";
import { suivisionTxUrl, truncateMiddle } from "@/lib/suivision";
import {
  listSettlements,
  openExplorerStream,
  type SettlementRow,
} from "@/backend/explorerClient";
import { useSuiClientContext } from "@mysten/dapp-kit";

function fmtSui(mist: number | null): string {
  if (mist == null) return "—";
  return (mist / 1e9).toFixed(3).replace(/\.?0+$/, "") + " SUI";
}

export function ExplorerPage() {
  const { network } = useSuiClientContext();
  const [rows, setRows] = useState<SettlementRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [address, setAddress] = useState("");
  const loading = useRef(false);

  const load = useCallback(
    async (reset: boolean) => {
      if (loading.current) return;
      loading.current = true;
      try {
        const page = await listSettlements({
          limit: 50,
          cursor: reset ? undefined : cursor ?? undefined,
          address: address.trim() || undefined,
          kind: "settled",
        });
        setRows((prev) => (reset ? page.rows : [...prev, ...page.rows]));
        setCursor(page.nextCursor);
        setDone(page.nextCursor == null);
      } finally {
        loading.current = false;
      }
    },
    [cursor, address],
  );

  useEffect(() => {
    void load(true);
    // Live-prepend new settlements as the indexer emits them.
    return openExplorerStream((row) => {
      if (row.kind !== "settled") return;
      setRows((prev) => (prev.some((r) => r.txDigest === row.txDigest) ? prev : [row, ...prev]));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <span className="wal-eyebrow text-muted-foreground">Dopamint · proof explorer</span>
        <h1 className="wal-display text-2xl">Settlements</h1>
        <p className="text-sm text-muted-foreground">
          Every row is an on-chain settlement. Open one to re-verify the off-chain transcript
          yourself — signatures, nonces, balance conservation, and the anchored root.
        </p>
      </header>

      <Panel className="flex min-h-0 flex-1 flex-col">
        <PanelHeader className="gap-3">
          <PanelTitle>Recent</PanelTitle>
          <Input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load(true)}
            placeholder="Filter by address (0x…)"
            className="ml-auto h-8 w-64 text-xs"
          />
        </PanelHeader>

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">DIGEST</th>
                <th className="px-3 py-2 font-medium">TUNNEL</th>
                <th className="px-3 py-2 font-medium">CHECKPOINT</th>
                <th className="px-3 py-2 font-medium">TIME</th>
                <th className="px-3 py-2 text-right font-medium">POT</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                    No settlements yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.txDigest} className="border-t border-border/60 hover:bg-secondary/40">
                    <td className="wal-mono px-3 py-2">
                      <a
                        href={suivisionTxUrl(r.txDigest, network)}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-foreground/80 hover:text-primary hover:underline"
                      >
                        {truncateMiddle(r.txDigest)}
                      </a>
                    </td>
                    <td className="wal-mono px-3 py-2 text-muted-foreground">
                      {truncateMiddle(r.tunnelId)}
                    </td>
                    <td className="wal-mono px-3 py-2">{r.checkpoint || "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {new Date(r.timestampMs).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {fmtSui((r.partyABalance ?? 0) + (r.partyBBalance ?? 0))}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link
                        to="/explorer/$digest"
                        params={{ digest: r.txDigest }}
                        className="text-primary hover:underline"
                      >
                        Verify →
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!done && rows.length > 0 && (
          <button
            type="button"
            onClick={() => load(false)}
            className="border-t border-border py-2 text-xs text-muted-foreground hover:text-foreground"
          >
            Load more
          </button>
        )}
      </Panel>
    </div>
  );
}
