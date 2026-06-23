import { createContext, useContext, useMemo, ReactNode } from "react";
import {
  useCurrentAccount,
  useDisconnectWallet,
  useSignAndExecuteTransaction,
  useSignTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { makeSponsoredSignExec } from "@/onchain/sponsor";

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
  const { mutateAsync: signTransaction } = useSignTransaction();
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

  // Gas-sponsored execute (ADR-0009): the backend settler wraps the tx in its own SIP-58 gas, the
  // wallet co-signs, both are submitted — so a 0-SUI player pays nothing. The backend allowlist
  // (not this client) decides what it will pay for. `allowedAddresses` is unused: the settler,
  // not the client, scopes sponsorship.
  const sponsorAndExecute = async ({
    tx,
  }: SponsorAndExecuteProps): Promise<string> => {
    if (!isConnected || !address) {
      throw new Error("Wallet not connected");
    }
    const signExec = makeSponsoredSignExec({
      sender: address,
      client: suiClient as never,
      signTransaction: signTransaction as never,
    });
    const { digest } = await signExec(tx);
    return digest;
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
