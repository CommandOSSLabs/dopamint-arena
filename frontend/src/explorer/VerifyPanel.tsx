import { useEffect, useRef, useState } from "react";
import { useSuiClient } from "@mysten/dapp-kit";
import gsap from "gsap";

import { Panel, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { cn } from "@/lib/utils";
import { getTranscript, type SettlementRow } from "@/backend/explorerClient";
import { partiesFromTunnelObject } from "@/backend/tunnelParties";
import {
  verifyTranscript,
  type TranscriptVerification,
} from "../../../sui-tunnel-ts/src/proof/transcript";
import { checksOf, verdictOf, type Verdict } from "./verifyModel";

type Phase = "loading" | "done" | "error";

export function VerifyPanel({ row }: { row: SettlementRow }) {
  const client = useSuiClient();
  const [phase, setPhase] = useState<Phase>("loading");
  const [result, setResult] = useState<TranscriptVerification | null>(null);
  const [hasTranscript, setHasTranscript] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const checksRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // 1) transcript via the api's Walrus proxy (404 => anchored-but-unverifiable).
        let record;
        try {
          record = await getTranscript(row.txDigest);
        } catch {
          if (alive) {
            setHasTranscript(false);
            setPhase("done");
          }
          return;
        }
        // 2) Need an on-chain anchored root to check the transcript against. A close without one
        //    (transcriptRoot null) leaves the transcript uncheckable — not failed, just unverifiable.
        const onchainRoot = row.transcriptRoot;
        if (onchainRoot == null) {
          if (alive) setPhase("done");
          return;
        }
        // 3) party public keys from the authoritative on-chain Tunnel object (trustless).
        const obj = await client.getObject({
          id: row.tunnelId,
          options: { showContent: true },
        });
        const parties = partiesFromTunnelObject((obj.data as any)?.content);
        // 4) re-derive the verdict in-browser. Balances are exact decimal-string MIST (BigInt).
        const lockedTotal =
          BigInt(row.partyABalance ?? 0) + BigInt(row.partyBBalance ?? 0);
        const v = verifyTranscript(record, {
          partyA: parties.partyA,
          partyB: parties.partyB,
          onchainRoot,
          lockedTotal,
        });
        if (alive) {
          setResult(v);
          setPhase("done");
        }
      } catch (e) {
        if (alive) {
          setErr(String(e));
          setPhase("error");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, row]);

  // One orchestrated reveal: the four checks cascade in once the verdict resolves.
  useEffect(() => {
    if (phase === "done" && checksRef.current) {
      gsap.fromTo(
        checksRef.current.children,
        { opacity: 0, y: 8 },
        { opacity: 1, y: 0, duration: 0.35, stagger: 0.08, ease: "power2.out" },
      );
    }
  }, [phase]);

  const hasAnchoredRoot = row.transcriptRoot != null;
  const verdict: Verdict = verdictOf(result, hasTranscript, hasAnchoredRoot);

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Independent verification</PanelTitle>
        <span className="wal-eyebrow ml-auto text-muted-foreground">
          runs in your browser
        </span>
      </PanelHeader>

      <div className="flex flex-col gap-5 p-5">
        <VerdictSeal verdict={verdict} phase={phase} />

        {phase === "error" && <p className="text-sm text-destructive">{err}</p>}

        {verdict === "unverifiable" && (
          <p className="text-sm text-muted-foreground">
            This settlement is <b>anchored on-chain</b>, but its off-chain
            transcript can't be independently re-verified here — either no
            transcript was archived, or it was closed without anchoring a
            transcript root. Its recorded balances and root still stand.
          </p>
        )}

        {result && (
          <ul ref={checksRef} className="flex flex-col gap-2">
            {checksOf(result).map((c) => (
              <li key={c.key} className="flex items-center gap-2 text-sm">
                <span
                  className={cn(
                    "grid size-5 place-items-center rounded-full text-background",
                    c.ok ? "bg-success" : "bg-destructive",
                  )}
                >
                  {c.ok ? "✓" : "✗"}
                </span>
                <span className={c.ok ? "" : "text-destructive"}>
                  {c.label}
                </span>
              </li>
            ))}
          </ul>
        )}

        {result && result.steps.length > 0 && <StepLedger result={result} />}
      </div>
    </Panel>
  );
}

function VerdictSeal({ verdict, phase }: { verdict: Verdict; phase: Phase }) {
  if (phase === "loading") {
    return (
      <div className="wal-eyebrow text-muted-foreground">
        Re-deriving proof…
      </div>
    );
  }
  const map = {
    verified: {
      ring: "border-success text-success",
      title: "Mutually authorized + integrity-verified",
    },
    failed: {
      ring: "border-destructive text-destructive",
      title: "Verification FAILED",
    },
    unverifiable: {
      ring: "border-border text-muted-foreground",
      title: "Anchored — transcript unavailable",
    },
  } as const;
  const s = map[verdict];
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border-2 px-4 py-3",
        s.ring,
      )}
    >
      <span className="text-2xl">
        {verdict === "verified" ? "◆" : verdict === "failed" ? "✗" : "◇"}
      </span>
      <div>
        <div className="wal-display text-base">{s.title}</div>
        <div className="wal-eyebrow text-muted-foreground">
          not a fairness claim — moves stay hashed in stateHash
        </div>
      </div>
    </div>
  );
}

function StepLedger({ result }: { result: TranscriptVerification }) {
  return (
    <details className="rounded-md border border-border">
      <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
        Per-step ledger ({result.stepCount} steps)
      </summary>
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-left text-[11px]">
          <thead className="sticky top-0 bg-card text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5">NONCE</th>
              <th className="px-3 py-1.5">SIG A</th>
              <th className="px-3 py-1.5">SIG B</th>
              <th className="px-3 py-1.5 text-right">A</th>
              <th className="px-3 py-1.5 text-right">B</th>
            </tr>
          </thead>
          <tbody className="wal-mono">
            {result.steps.map((s, i) => (
              <tr key={i} className="border-t border-border/50">
                <td className="px-3 py-1">{s.nonce.toString()}</td>
                <td
                  className={cn(
                    "px-3 py-1",
                    s.sigAValid ? "text-success" : "text-destructive",
                  )}
                >
                  {s.sigAValid ? "✓" : "✗"}
                </td>
                <td
                  className={cn(
                    "px-3 py-1",
                    s.sigBValid ? "text-success" : "text-destructive",
                  )}
                >
                  {s.sigBValid ? "✓" : "✗"}
                </td>
                <td className="px-3 py-1 text-right">
                  {s.partyABalance.toString()}
                </td>
                <td className="px-3 py-1 text-right">
                  {s.partyBBalance.toString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
