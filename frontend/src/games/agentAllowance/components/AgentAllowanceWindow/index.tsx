import { Wallet } from "lucide-react";

import type { GameWindowProps } from "../../../types";
import { isAgentAllowanceConfigured } from "@/onchain/agentAllowance";

import { useAgentAllowanceSession } from "../../hooks/useAgentAllowanceSession";
import { AgentAllowanceDashboard } from "../AgentAllowanceDashboard";
import { AgentAllowanceLobby } from "../AgentAllowanceLobby";

export function AgentAllowanceWindow({ windowId }: GameWindowProps) {
  const session = useAgentAllowanceSession(windowId);

  if (!isAgentAllowanceConfigured) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Agent Allowance isn&apos;t configured. Set{" "}
        <code className="text-foreground">VITE_AGENT_ALLOWANCE_PACKAGE_ID</code>{" "}
        and the MTPS env vars.
      </div>
    );
  }

  if (!session.walletConnected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center">
        <Wallet className="size-7 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Sign in to fund an agent&apos;s spending budget.
        </p>
      </div>
    );
  }

  return (
    <div className="flex size-full flex-col overflow-y-auto text-foreground">
      {session.screen === "lobby" && <AgentAllowanceLobby session={session} />}

      {session.screen === "dashboard" && (
        <AgentAllowanceDashboard session={session} />
      )}
    </div>
  );
}
