import { useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";

import { useTelemetry } from "@/telemetry/TelemetryProvider";
import { getChatSession, type ChatSessionState } from "./chatSession";

export interface ChatSession extends ChatSessionState {
  send: (text: string) => Promise<void>;
  reset: () => void;
}

export function useChatSession(windowId: string): ChatSession {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const session = getChatSession(windowId);
  session.deps = {
    report,
    account,
    client,
    signExec: (async (
      tx: Parameters<typeof signAndExecute>[0]["transaction"],
    ) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    }) as never,
  };

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);

  return {
    status: snap.status,
    transcript: snap.transcript,
    stake: snap.stake,
    error: snap.error,
    isReplying: snap.isReplying,
    send: session.send,
    reset: session.reset,
  };
}
