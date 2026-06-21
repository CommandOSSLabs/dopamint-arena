// The dapp-kit adapter for the agent engine: pulls the connected account + a popup-free signExec
// (routed through the programmatic wallet) and the Sui client, then runs the engine. Renders a
// status line (data-agent-status) the Playwright proof and any showcase view can read.
import { useEffect, useRef, useState } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { parseAgentConfig } from "./agentConfig";
import { runAgent } from "./agentEngine";
import type { SuiReads } from "../onchain/tunnelTx";

export function AgentRunner() {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync } = useSignAndExecuteTransaction();
  const [status, setStatus] = useState("init");
  const started = useRef(false);

  useEffect(() => {
    if (!account || started.current) return;
    started.current = true;
    const signExec = async (
      tx: Parameters<typeof mutateAsync>[0]["transaction"],
    ) => {
      const r = await mutateAsync({ transaction: tx });
      return { digest: r.digest };
    };
    const { concurrency } = parseAgentConfig(window.location.href);
    // No cleanup-stop: under React.StrictMode the dev double-invoke (mount→cleanup→mount)
    // would cancel the still-connecting first run. The agent runs for the page's lifetime;
    // the Playwright/real browser context closing is what ends it.
    runAgent(
      {
        wallet: account.address,
        signExec,
        reads: client as unknown as SuiReads,
        onStatus: (s) => {
          console.log("[agentstatus]", s);
          setStatus(s);
        },
      },
      concurrency,
      () => false,
    ).catch((e) => {
      // A rejected runAgent isn't a pageerror — surface it so the proof/console can see it.
      console.error("[agent] runAgent failed:", e);
      setStatus(`fatal:${String((e as Error)?.message ?? e)}`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  return <div data-agent-status={status}>agent: {status}</div>;
}
