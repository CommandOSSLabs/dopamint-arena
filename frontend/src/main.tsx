import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@mysten/dapp-kit/dist/index.css";
import "./styles/index.css";
import { SuiProviders } from "./providers/SuiProviders";
import { App } from "./App";
import { parseAgentConfig } from "./agent/agentConfig";
import { AgentBoot } from "./agent/AgentBoot";
import { AgentRunner } from "./agent/AgentRunner";
import { DevWalletBoot } from "./wallet/DevWalletBoot";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

// Agent mode (?agent) drives the real app headless over the same providers a human uses —
// just dapp-kit (for the programmatic wallet + signing), not the desktop/router chrome.
const agentMode = parseAgentConfig(window.location.href).enabled;

createRoot(root).render(
  <StrictMode>
    <SuiProviders>
      {agentMode ? (
        <AgentBoot>
          <AgentRunner />
        </AgentBoot>
      ) : (
        <DevWalletBoot>
          <App />
        </DevWalletBoot>
      )}
    </SuiProviders>
  </StrictMode>,
);
