import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  ReactNode,
} from "react";
import { useEnokiFlow, useZkLogin } from "@mysten/enoki/react";
import {
  useCurrentWallet,
  useCurrentAccount,
  useSignTransaction,
  useDisconnectWallet,
  useSuiClient,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { fromB64, toB64 } from "@mysten/sui/utils";
import clientConfig from "@/config/clientConfig";

const API = import.meta.env.VITE_API_URL;

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
  const suiClient = useSuiClient();
  const { address: enokiAddress } = useZkLogin();
  const enokiFlow = useEnokiFlow();
  const currentAccount = useCurrentAccount();
  const { isConnected: isWalletConnected } = useCurrentWallet();
  const { mutateAsync: signTransactionBlock } = useSignTransaction();
  const { mutate: disconnect } = useDisconnectWallet();

  const { isConnected, isUsingEnoki, address } = useMemo(
    () => ({
      isConnected: !!enokiAddress || isWalletConnected,
      isUsingEnoki: !!enokiAddress,
      address: enokiAddress || currentAccount?.address,
    }),
    [enokiAddress, currentAccount?.address, isWalletConnected],
  );

  // Enoki redirects to `${origin}/auth#id_token=…`; handle it without a router.
  useEffect(() => {
    if (window.location.hash.includes("id_token")) {
      enokiFlow
        .handleAuthCallback()
        .catch((e) => console.error("enoki auth callback failed", e))
        .finally(() =>
          history.replaceState(null, "", window.location.pathname),
        );
    }
  }, [enokiFlow]);

  const login = () => {
    enokiFlow
      .createAuthorizationURL({
        provider: "google",
        network: clientConfig.SUI_NETWORK_NAME,
        clientId: clientConfig.GOOGLE_CLIENT_ID,
        redirectUrl: `${window.location.origin}/auth`,
        extraParams: { scope: ["openid", "email", "profile"] },
      })
      .then((url) => {
        window.location.href = url;
      })
      .catch((e) => console.error("failed to create auth url", e));
  };

  const logout = () => {
    if (isUsingEnoki) enokiFlow.logout();
    else {
      disconnect();
      sessionStorage.clear();
    }
  };

  const signTransaction = async (bytes: Uint8Array): Promise<string> => {
    if (isUsingEnoki) {
      // Enoki only accepts "mainnet" | "testnet"; cast from the wider union that includes "devnet".
      const signer = await enokiFlow.getKeypair({
        network: clientConfig.SUI_NETWORK_NAME as unknown as
          | "mainnet"
          | "testnet",
      });
      const sig = await signer.signTransaction(bytes);
      return sig.signature;
    }
    const tx = Transaction.from(bytes);
    // dapp-kit vendors @mysten/sui@1.24.0; our Transaction comes from @mysten/sui@1.45.2.
    // The two Transaction classes are structurally incompatible due to #private fields.
    const resp = await signTransactionBlock({
      transaction: tx as unknown as Parameters<
        typeof signTransactionBlock
      >[0]["transaction"],
      chain: `sui:${clientConfig.SUI_NETWORK_NAME}`,
    });
    return resp.signature;
  };

  // Backend-sponsored execution (works for both Enoki and wallet). Returns the tx digest.
  const sponsorAndExecute = async ({
    tx,
    allowedAddresses = [],
  }: SponsorAndExecuteProps): Promise<string> => {
    if (!isConnected || !address) throw new Error("wallet not connected");
    // suiClient comes from dapp-kit (@mysten/sui@1.24.0); tx.build expects ClientWithCoreApi from @mysten/sui@1.45.2.
    // Cast through unknown to bridge the structural incompatibility.
    const txBytes = await tx.build({
      client: suiClient as unknown as Parameters<typeof tx.build>[0] extends {
        client?: infer C;
      }
        ? NonNullable<C>
        : never,
      onlyTransactionKind: true,
    });
    const sponsorRes = await fetch(`${API}/sponsor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        network: clientConfig.SUI_NETWORK_NAME,
        txBytes: toB64(txBytes),
        sender: address,
        allowedAddresses,
      }),
    });
    const sponsorData = await sponsorRes.json();
    if (!sponsorRes.ok) throw new Error(sponsorData.error ?? "sponsor failed");
    const signature = await signTransaction(fromB64(sponsorData.bytes));
    const execRes = await fetch(`${API}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ digest: sponsorData.digest, signature }),
    });
    const execData = await execRes.json();
    if (!execRes.ok) throw new Error(execData.error ?? "execute failed");
    await suiClient.waitForTransaction({
      digest: execData.digest,
      timeout: 8000,
    });
    return execData.digest;
  };

  // Wallet-signed, sender-pays-gas execution (no Enoki sponsorship) — matches Black Jack's
  // settle path (`executeTransactionBlockWithoutSponsorship`). Use this when the connected
  // wallet (e.g. Slush) holds gas. Returns the tx digest.
  const executeTransaction = async ({ tx }: ExecuteProps): Promise<string> => {
    if (!isConnected || !address) throw new Error("wallet not connected");
    tx.setSender(address);
    const txBytes = await tx.build({
      client: suiClient as unknown as Parameters<typeof tx.build>[0] extends {
        client?: infer C;
      }
        ? NonNullable<C>
        : never,
    });
    const signature = await signTransaction(txBytes);
    const res = await suiClient.executeTransactionBlock({
      transactionBlock: txBytes,
      signature,
      options: { showEffects: true },
    });
    await suiClient.waitForTransaction({ digest: res.digest, timeout: 8000 });
    return res.digest;
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
