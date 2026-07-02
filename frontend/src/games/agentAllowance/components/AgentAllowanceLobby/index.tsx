import { Bot, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { useAgentAllowanceSession } from "../../hooks/useAgentAllowanceSession";
import {
  EXPIRY_OPTIONS,
  PROVIDERS,
  shortAddr,
  validateMandateInputs,
} from "../../utils";
import AgentAllowanceLobbyField from "./AgentAllowanceLobbyField";
import AgentAllowanceLobbyNumberInput from "./AgentAllowanceLobbyNumberInput";

interface AgentAllowanceLobbyProps {
  session: ReturnType<typeof useAgentAllowanceSession>;
}

export function AgentAllowanceLobby({ session }: AgentAllowanceLobbyProps) {
  const provider = PROVIDERS[session.providerIdx];
  const mandateError = validateMandateInputs(
    session.capInput,
    session.rateInput,
  );
  const showMandateError =
    mandateError !== null &&
    (session.capInput.trim() !== "" || session.rateInput.trim() !== "");
  const formError = session.error ?? (showMandateError ? mandateError : null);

  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6">
      <div
        className={cn(
          "wal-glow max-w-sm space-y-3 rounded-[20px] border border-border",
          "bg-card/75 p-6 backdrop-blur-xl",
        )}
      >
        {session.isRevoked ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            Agent stopped. The service kept what it earned; the unused budget
            was refunded to you. Start a new one below.
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-muted-foreground">
            Give an AI agent a budget to pay a service for you. It pays a little
            every second as it works — pause or stop anytime and get the unused
            budget back.
          </p>
        )}

        <AgentAllowanceLobbyField label="Agent">
          <input
            value={session.agentName}
            onChange={(e) => session.setAgentName(e.target.value)}
            disabled={session.busy}
            placeholder="Research Agent"
            className={cn(
              "w-full rounded-lg border border-border bg-background px-2 py-1.5",
              "text-sm text-foreground outline-none focus:border-primary",
            )}
          />
        </AgentAllowanceLobbyField>

        <AgentAllowanceLobbyField label="Service to pay">
          <select
            value={session.providerIdx}
            onChange={(e) => session.setProviderIdx(Number(e.target.value))}
            disabled={session.busy}
            className={cn(
              "w-full rounded-lg border border-border bg-background px-2 py-1.5",
              "text-sm text-foreground outline-none focus:border-primary",
            )}
          >
            {PROVIDERS.map((p, i) => (
              <option key={p.name} value={i}>
                {p.name} — {p.blurb}
              </option>
            ))}
          </select>
          <span className="wal-mono text-[11px] text-muted-foreground">
            {shortAddr(provider.address)}
          </span>
        </AgentAllowanceLobbyField>

        <div className="grid grid-cols-2 gap-2">
          <AgentAllowanceLobbyField label="Budget">
            <AgentAllowanceLobbyNumberInput
              value={session.capInput}
              onChange={session.setCapInput}
              suffix="MTPS"
              disabled={session.busy}
            />
          </AgentAllowanceLobbyField>
          <AgentAllowanceLobbyField label="Per second">
            <AgentAllowanceLobbyNumberInput
              value={session.rateInput}
              onChange={session.setRateInput}
              suffix="MTPS"
              disabled={session.busy}
            />
          </AgentAllowanceLobbyField>
        </div>

        <AgentAllowanceLobbyField label="Expires">
          <select
            value={session.expiryIdx}
            onChange={(e) => session.setExpiryIdx(Number(e.target.value))}
            disabled={session.busy}
            className={cn(
              "w-full rounded-lg border border-border bg-background px-2 py-1.5",
              "text-sm text-foreground outline-none focus:border-primary",
            )}
          >
            {EXPIRY_OPTIONS.map((o, i) => (
              <option key={o.label} value={i}>
                {o.label}
              </option>
            ))}
          </select>
        </AgentAllowanceLobbyField>

        {formError && (
          <p className="break-all text-sm text-destructive">{formError}</p>
        )}

        <Button
          onClick={session.deploy}
          disabled={
            session.busy || !session.walletConnected || mandateError !== null
          }
          className="mt-1 w-full gap-1.5"
        >
          {session.phase === "deploying" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Bot className="size-4" />
          )}

          {session.phase === "deploying" ? "Starting agent" : "Start agent"}
        </Button>
      </div>
    </div>
  );
}
