import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatMtps } from "../../utils";
import { useRegularPaymentsSession } from "../../hooks/useRegularPaymentsSession";

interface RegularPaymentsLobbyProps {
  session: ReturnType<typeof useRegularPaymentsSession>;
}

export function RegularPaymentsLobby({ session }: RegularPaymentsLobbyProps) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6">
      <div className="wal-glow flex w-full max-w-sm flex-col gap-5 rounded-[20px] border border-border bg-card/75 p-6 backdrop-blur-xl">
        <div className="flex flex-col gap-2">
          <p className="wal-eyebrow">Off-chain checkout</p>
          <h1 className="wal-display text-[clamp(1.6rem,6cqmin,2.25rem)] text-foreground">
            Tunnel <span className="wal-gradient-text">Mart</span>
          </h1>
        </div>

        <p className="text-sm leading-relaxed text-muted-foreground">
          Shop with a budget of{" "}
          <span className="wal-mono text-foreground">
            {formatMtps(session.depositBudget)} MTPS
          </span>
          . Each add-to-cart step is a co-signed payment over the relay to the
          shop bot.
        </p>

        {!session.walletConnected && (
          <p className="text-sm text-destructive">
            Connect your wallet to find a shop.
          </p>
        )}

        {session.error && (
          <p className="text-sm text-destructive">{session.error}</p>
        )}

        <Button
          className="w-full"
          size="lg"
          disabled={!session.walletConnected || session.busy}
          onClick={session.findShop}
        >
          {session.busy && <Loader2 className="animate-spin" />}

          {session.phase === "opening" ? "Opening tunnel" : "Find shop"}
        </Button>
      </div>
    </div>
  );
}
