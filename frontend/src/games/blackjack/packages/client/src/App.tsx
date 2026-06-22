import { Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import {
  createNetworkConfig,
  SuiClientProvider,
  WalletProvider,
} from "@mysten/dapp-kit";
import { getFullnodeUrl } from "@mysten/sui/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import clientConfig from "@/config/clientConfig";
import "@mysten/dapp-kit/dist/index.css";

import Home from "@/pages/Home";
import PlayerBot from "@/pages/PlayerBot";
import PlayerVsDealer from "@/pages/PlayerVsDealer";
import PvpBlackjack from "@/pages/PvpBlackjack";
import { ScaledWrapper } from "@/components/app/ScaledWrapper";

interface StorageAdapter {
  setItem(key: string, value: string): Promise<void>;
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
}

const sessionStorageAdapter: StorageAdapter = {
  getItem: async (key) => sessionStorage.getItem(key),
  setItem: async (key, value) => sessionStorage.setItem(key, value),
  removeItem: async (key) => sessionStorage.removeItem(key),
};

const queryClient = new QueryClient();

const { networkConfig } = createNetworkConfig({
  testnet: { url: getFullnodeUrl("testnet") },
  mainnet: { url: getFullnodeUrl("mainnet") },
  devnet: { url: getFullnodeUrl("devnet") },
});

// The tunnel modes run their own bot keypairs + SuiClient (no auth gate), but the
// "fund from wallet" action needs a connected wallet. Mount everything under the
// minimal dapp-kit stack: query + SuiClient + WalletProvider.
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider
        networks={networkConfig}
        defaultNetwork={clientConfig.SUI_NETWORK_NAME}
      >
        <WalletProvider autoConnect storage={sessionStorageAdapter}>
          <ScaledWrapper>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/play" element={<PlayerVsDealer />} />
              <Route path="/bot" element={<PlayerBot />} />
              <Route path="/pvp" element={<PvpBlackjack />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </ScaledWrapper>
          <Toaster
            position="top-right"
            reverseOrder
            toastOptions={{
              className: "custom-game-toast",
              duration: 5000,
              style: {
                background: "#09090b",
                color: "#f4f4f5",
                border: "1px solid #27272a",
                borderRadius: "12px",
                padding: "12px 16px",
                fontSize: "13px",
                fontWeight: "600",
                letterSpacing: "0.025em",
                boxShadow:
                  "0 20px 25px -5px rgba(0, 0, 0, 0.7), 0 10px 10px -5px rgba(0, 0, 0, 0.7)",
                fontFamily: "Inter, sans-serif",
              },
              success: {
                style: {
                  border: "1px solid rgba(16, 185, 129, 0.8)",
                  background: "rgba(2, 44, 34, 0.95)",
                  color: "#34d399",
                },
                iconTheme: { primary: "#10b981", secondary: "#022c22" },
              },
              error: {
                style: {
                  border: "1px solid rgba(239, 68, 68, 0.8)",
                  background: "rgba(69, 10, 10, 0.95)",
                  color: "#f87171",
                },
                iconTheme: { primary: "#ef4444", secondary: "#450a0a" },
              },
            }}
          />
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
