import { Wallet } from "lucide-react";

import type { GameWindowProps } from "../../../types";

import { StreamingPaymentDashboard } from "../StreamingPaymentDashboard";
import { useStreamingPaymentSession } from "../../hooks/useStreamingPaymentSession";
import { StreamingPaymentLobby } from "../StreamingPaymentLobby";

export function StreamingPaymentWindow({ windowId }: GameWindowProps) {
  const session = useStreamingPaymentSession(windowId);

  if (!session.walletConnected) {
    return (
      <div className="flex flex-col justify-center items-center gap-2 py-8 h-full text-center">
        <Wallet className="size-7 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Sign in to stream a payment to someone.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col size-full overflow-y-auto text-foreground">
      <div className="flex flex-col flex-1 gap-4">
        {session.screen === "dashboard" && (
          <StreamingPaymentDashboard session={session} />
        )}

        {session.screen === "lobby" && (
          <StreamingPaymentLobby session={session} />
        )}
      </div>
    </div>
  );
}
