import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@mysten/dapp-kit/dist/index.css";
import "./styles/index.css";
import { SuiProviders } from "./providers/SuiProviders";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <SuiProviders>
      <App />
    </SuiProviders>
  </StrictMode>,
);
