import { useEffect, useState } from "react";
import { Routes, Route } from "react-router-dom";
import toast, { Toaster, useToasterStore } from "react-hot-toast";
import { EnokiFlowProvider } from "@mysten/enoki/react";
import {
  createNetworkConfig,
  SuiClientProvider,
  WalletProvider,
} from "@mysten/dapp-kit";
import { getFullnodeUrl } from "@mysten/sui/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CustomWalletProvider } from "@/contexts/CustomWallet";
import { AuthenticationProvider } from "@/contexts/Authentication";
import { BalanceProvider } from "@/contexts/BalanceContext";
import { LargeScreenLayout } from "@/components/layouts/LargeScreenLayout";
import { MobileLayout } from "@/components/layouts/MobileLayout";
import { useIsMobile } from "@/hooks/useIsMobile";
import clientConfig from "@/config/clientConfig";
import "@mysten/dapp-kit/dist/index.css";

import Home from "@/pages/Home";
import Auth from "@/pages/Auth";
import Admin from "@/pages/Admin";
import Dealer from "@/pages/Dealer";
import DealerUtils from "@/pages/DealerUtils";
import Player from "@/pages/Player";
import PlayerGame from "@/pages/PlayerGame";
import PlayerHex from "@/pages/PlayerHex";
import PlayerPoc from "@/pages/PlayerPoc";
import Transfer from "@/pages/Transfer";
import Test from "@/pages/Test";
import NotFound from "@/pages/NotFound";

import AdminLayout from "@/layouts/AdminLayout";
import DealerLayout from "@/layouts/DealerLayout";
import DealerUtilsLayout from "@/layouts/DealerUtilsLayout";
import PlayerLayout from "@/layouts/PlayerLayout";
import PlayerGameLayout from "@/layouts/PlayerGameLayout";
import PlayerPocLayout from "@/layouts/PlayerPocLayout";

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

function AppShell() {
  const { isMobile } = useIsMobile();
  const { toasts } = useToasterStore();
  const [gutter, setGutter] = useState(8);

  useEffect(() => {
    const visibleToasts = toasts.filter((t) => t.visible);
    if (visibleToasts.length > 5) {
      visibleToasts
        .slice(0, visibleToasts.length - 5)
        .forEach((t) => toast.dismiss(t.id));
    }
  }, [toasts]);

  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (width < 350 || height < 400) {
        setGutter(-22);
      } else if (width < 400 || height < 500) {
        setGutter(-15);
      } else if (width < 500 || height < 650) {
        setGutter(-8);
      } else if (width < 768 || height < 800) {
        setGutter(-2);
      } else {
        setGutter(8);
      }
    };
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const routes = (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/auth" element={<Auth />} />

      <Route element={<AdminLayout />}>
        <Route path="/admin" element={<Admin />} />
      </Route>

      <Route element={<DealerLayout />}>
        <Route path="/dealer" element={<Dealer />} />
        <Route element={<DealerUtilsLayout />}>
          <Route path="/dealer/utils" element={<DealerUtils />} />
        </Route>
      </Route>

      <Route element={<PlayerLayout />}>
        <Route path="/player" element={<Player />} />
        <Route element={<PlayerGameLayout />}>
          <Route path="/player/game" element={<PlayerGame />} />
        </Route>
        <Route path="/player/hex" element={<PlayerHex />} />
        <Route element={<PlayerPocLayout />}>
          <Route path="/player/poc" element={<PlayerPoc />} />
        </Route>
      </Route>

      <Route path="/transfer" element={<Transfer />} />
      <Route path="/test" element={<Test />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
  return (
    <main className="min-h-screen w-screen bg-gray-100">
      {isMobile ? (
        <MobileLayout>{routes}</MobileLayout>
      ) : (
        <LargeScreenLayout>{routes}</LargeScreenLayout>
      )}
      <Toaster
        position="top-right"
        reverseOrder={true}
        gutter={gutter}
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
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.7), 0 10px 10px -5px rgba(0, 0, 0, 0.7)",
            fontFamily: "Inter, sans-serif",
          },
          success: {
            style: {
              border: "1px solid rgba(16, 185, 129, 0.8)",
              background: "rgba(2, 44, 34, 0.95)",
              color: "#34d399",
            },
            iconTheme: {
              primary: "#10b981",
              secondary: "#022c22",
            },
          },
          error: {
            style: {
              border: "1px solid rgba(239, 68, 68, 0.8)",
              background: "rgba(69, 10, 10, 0.95)",
              color: "#f87171",
            },
            iconTheme: {
              primary: "#ef4444",
              secondary: "#450a0a",
            },
          },
        }}
      />
    </main>
  );
}

export default function App() {
  const { networkConfig } = createNetworkConfig({
    testnet: { url: getFullnodeUrl("testnet") },
    mainnet: { url: getFullnodeUrl("mainnet") },
    devnet: {
      url: import.meta.env.VITE_SUI_NETWORK || getFullnodeUrl("devnet"),
    },
  });

  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider
        networks={networkConfig}
        defaultNetwork={clientConfig.SUI_NETWORK_NAME}
      >
        <WalletProvider autoConnect storage={sessionStorageAdapter}>
          <EnokiFlowProvider apiKey={clientConfig.ENOKI_API_KEY}>
            <AuthenticationProvider>
              <CustomWalletProvider>
                <BalanceProvider>
                  <AppShell />
                </BalanceProvider>
              </CustomWalletProvider>
            </AuthenticationProvider>
          </EnokiFlowProvider>
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
