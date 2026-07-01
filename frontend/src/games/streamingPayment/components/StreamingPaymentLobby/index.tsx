import { useStreamingPaymentSession } from "../../hooks/useStreamingPaymentSession";
import { DURATIONS, formatMtps } from "../../utils";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { StreamingPaymentLobbyFieldForm } from "./StreamingPaymentLobbyFieldForm";

interface StreamingPaymentLobbyProps {
  session: ReturnType<typeof useStreamingPaymentSession>;
}

export function StreamingPaymentLobby({ session }: StreamingPaymentLobbyProps) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6">
      <div
        className={cn(
          "wal-glow bg-card/75 p-6 backdrop-blur-xl",
          "max-w-sm space-y-3",
          "rounded-[20px] border border-border",
        )}
      >
        <div className="space-y-1.5">
          <h1 className="wal-display text-[clamp(1.6rem,6cqmin,2.25rem)] text-foreground">
            Based <span className="wal-gradient-text">escrow</span>
          </h1>

          <p className="text-sm leading-relaxed text-muted-foreground">
            Stream payments with your custom budget and duration. Funds
            automatically charge at a set rate per second, unlocking on-chain in
            real time.
          </p>
        </div>

        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <StreamingPaymentLobbyFieldForm label="Amount">
              <div className="flex items-center rounded-lg border border-border bg-background focus-within:border-primary">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  value={session.totalInput}
                  onChange={(e) => session.setTotalInput(e.target.value)}
                  disabled={session.busy}
                  className="w-full min-w-0 bg-transparent px-2 py-1.5 text-sm outline-none"
                />

                <span className="px-2 text-[11px] text-muted-foreground">
                  MTPS
                </span>
              </div>
            </StreamingPaymentLobbyFieldForm>

            <StreamingPaymentLobbyFieldForm label="Over">
              <select
                value={session.durationIdx}
                onChange={(e) => session.setDurationIdx(Number(e.target.value))}
                disabled={session.busy}
                className={cn(
                  "w-full rounded-lg border border-border bg-background px-2 py-1.5",
                  "text-sm text-foreground outline-none focus:border-primary",
                )}
              >
                {DURATIONS.map((d, i) => (
                  <option key={d.label} value={i}>
                    {d.label}
                  </option>
                ))}
              </select>
            </StreamingPaymentLobbyFieldForm>
          </div>

          <span className="wal-mono text-[11px] text-muted-foreground">
            ≈ {formatMtps(session.formRate)} MTPS / sec
          </span>

          {session.error && (
            <p className="text-sm text-destructive break-all">
              {session.error}
            </p>
          )}
        </div>

        <Button
          onClick={session.startStream}
          disabled={session.busy || !session.walletConnected}
          className="w-full gap-1.5"
        >
          {session.phase === "creating" && (
            <Loader2 className="size-4 animate-spin" />
          )}

          {session.phase === "creating" ? "Creating stream" : "Start stream"}
        </Button>
      </div>
    </div>
  );
}
