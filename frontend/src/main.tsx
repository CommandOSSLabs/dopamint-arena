import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@mysten/dapp-kit/dist/index.css";
import "./styles/index.css";
import { SuiProviders } from "./providers/SuiProviders";
import { App } from "./App";
import { installWasmCryptoBackend } from "./onchain/wasmEd25519Backend";

// Make libsodium-WASM the default move-signing crypto backend (falls back to @noble until ready).
installWasmCryptoBackend();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <SuiProviders>
      <App />
    </SuiProviders>
  </StrictMode>,
);
