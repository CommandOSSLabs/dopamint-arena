import { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SuiClientProvider, WalletProvider, createNetworkConfig } from "@mysten/dapp-kit";
import { getFullnodeUrl } from "@mysten/sui/client";
import { EnokiFlowProvider } from "@mysten/enoki/react";
import { CustomWalletProvider } from "@/contexts/CustomWallet";
import clientConfig from "@/config/clientConfig";
import "@mysten/dapp-kit/dist/index.css";

const { networkConfig } = createNetworkConfig({
  testnet: { url: getFullnodeUrl("testnet") },
  mainnet: { url: getFullnodeUrl("mainnet") },
  devnet: { url: import.meta.env.VITE_SUI_NETWORK || getFullnodeUrl("devnet") },
});
const queryClient = new QueryClient();
const sessionStorageAdapter = {
  getItem: async (key: string) => sessionStorage.getItem(key),
  setItem: async (key: string, value: string) => sessionStorage.setItem(key, value),
  removeItem: async (key: string) => sessionStorage.removeItem(key),
};

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork={clientConfig.SUI_NETWORK_NAME}>
        <WalletProvider autoConnect storage={sessionStorageAdapter}>
          <EnokiFlowProvider apiKey={clientConfig.ENOKI_API_KEY}>
            <CustomWalletProvider>{children}</CustomWalletProvider>
          </EnokiFlowProvider>
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
