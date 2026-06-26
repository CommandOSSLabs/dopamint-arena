import { type ReactNode } from "react";
import { parseAgentConfig } from "./agentConfig";
import { ProgrammaticWalletGate } from "./ProgrammaticWalletGate";

// Comment to build
export function AgentBoot({ children }: { children: ReactNode }) {
  const cfg = parseAgentConfig(window.location.href);
  return (
    <ProgrammaticWalletGate secretKey={cfg.secretKey}>
      {children}
    </ProgrammaticWalletGate>
  );
}
