import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@mysten/dapp-kit/dist/index.css";
import "./styles/index.css";
import { SuiProviders } from "./providers/SuiProviders";
import { App } from "./App";
import { parseAgentConfig } from "./agent/agentConfig";
import { AgentBoot } from "./agent/AgentBoot";
import { AgentRunner } from "./agent/AgentRunner";
import { installWasmCryptoBackend } from "./onchain/wasmEd25519Backend";

// Make libsodium-WASM the default self-play crypto backend (falls back to @noble until ready).
installWasmCryptoBackend();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

const cfg = parseAgentConfig(window.location.href);

createRoot(root).render(
  <StrictMode>
    <SuiProviders>
      {cfg.enabled ? (
        <AgentBoot>
          <AgentRunner />
        </AgentBoot>
      ) : (
        <App />
      )}
    </SuiProviders>
  </StrictMode>,
);
