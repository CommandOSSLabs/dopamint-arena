import { createContext, useContext, useMemo, ReactNode } from "react";
import {
  useCurrentAccount,
  useDisconnectWallet,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";

interface SponsorAndExecuteProps {
  tx: Transaction;
  allowedAddresses?: string[];
}

interface ExecuteProps {
  tx: Transaction;
}

interface CustomWalletContextProps {
  isConnected: boolean;
  isUsingEnoki: boolean;
  address?: string;
  login: () => void;
  logout: () => void;
  sponsorAndExecute: (props: SponsorAndExecuteProps) => Promise<string>;
  executeTransaction: (props: ExecuteProps) => Promise<string>;
}

const CustomWalletContext = createContext<CustomWalletContextProps>({
  isConnected: false,
  isUsingEnoki: false,
  address: undefined,
  login: () => {},
  logout: () => {},
  sponsorAndExecute: async () => "",
  executeTransaction: async () => "",
});

export const useCustomWallet = () => useContext(CustomWalletContext);

export const CustomWalletProvider = ({ children }: { children: ReactNode }) => {
  const currentAccount = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const { mutate: disconnect } = useDisconnectWallet();
  const suiClient = useSuiClient();

  const isConnected = !!currentAccount;
  const address = currentAccount?.address;
  const isUsingEnoki = false;

  const login = () => {
    console.log("Connect wallet from Dopamint Arena dashboard");
  };

  const logout = () => {
    disconnect();
  };

  const sponsorAndExecute = async (): Promise<string> => {
    throw new Error("Sponsorship not implemented in integrated client");
  };

  const executeTransaction = async ({ tx }: ExecuteProps): Promise<string> => {
    if (!isConnected || !address) {
      throw new Error("Wallet not connected");
    }
    tx.setSender(address);
    const result = await signAndExecute({ transaction: tx });
    await suiClient.waitForTransaction({
      digest: result.digest,
      timeout: 8000,
    });
    return result.digest;
  };

  return (
    <CustomWalletContext.Provider
      value={{
        isConnected,
        isUsingEnoki,
        address,
        login,
        logout,
        sponsorAndExecute,
        executeTransaction,
      }}
    >
      {children}
    </CustomWalletContext.Provider>
  );
};
