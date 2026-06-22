import { createContext, useContext, useState, type ReactNode } from "react";
import {
  useCurrentAccount,
  useDisconnectWallet,
  useSuiClientQuery,
} from "@mysten/dapp-kit";

const DEMO_KEY = "dopamint.demoWallet";
// Display-only fake address + balance so the platform is fully usable for a
// demo without a real Sui wallet installed.
const DEMO_ADDRESS =
  "0xde0d0a7e00000000000000000000000000000000000000000000000000c0ffee";
const DEMO_BALANCE_SUI = 1234.56;

interface DemoContextValue {
  isDemo: boolean;
  connectDemo: () => void;
  disconnectDemo: () => void;
}

const DemoContext = createContext<DemoContextValue | null>(null);

/** Holds the demo-wallet flag (persisted). Mount under SuiProviders in App. */
export function DemoWalletProvider({ children }: { children: ReactNode }) {
  const [isDemo, setIsDemo] = useState(
    () => localStorage.getItem(DEMO_KEY) === "1",
  );
  const connectDemo = () => {
    localStorage.setItem(DEMO_KEY, "1");
    setIsDemo(true);
  };
  const disconnectDemo = () => {
    localStorage.removeItem(DEMO_KEY);
    setIsDemo(false);
  };
  return (
    <DemoContext.Provider value={{ isDemo, connectDemo, disconnectDemo }}>
      {children}
    </DemoContext.Provider>
  );
}

export interface WalletSession {
  connected: boolean;
  address: string | null;
  /** Truncated display form, e.g. 0xde0d0a…c0ffee. */
  shortAddress: string | null;
  balanceSui: number | null;
  isDemo: boolean;
  connectDemo: () => void;
  disconnect: () => void;
}

const shorten = (addr: string) =>
  addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;

/**
 * Unified wallet state: a real connected `@mysten/dapp-kit` account (with live
 * SUI balance) takes precedence; otherwise the demo wallet if enabled; otherwise
 * disconnected.
 */
export function useWalletSession(): WalletSession {
  const demo = useContext(DemoContext);
  if (!demo) throw new Error("useWalletSession requires DemoWalletProvider");

  const account = useCurrentAccount();
  const { mutate: disconnectWallet } = useDisconnectWallet();
  const realAddress = account?.address ?? null;

  const { data: balance } = useSuiClientQuery(
    "getBalance",
    { owner: realAddress ?? "" },
    { enabled: !!realAddress },
  );

  if (realAddress) {
    return {
      connected: true,
      address: realAddress,
      shortAddress: shorten(realAddress),
      balanceSui: balance ? Number(balance.totalBalance) / 1e9 : null,
      isDemo: false,
      connectDemo: demo.connectDemo,
      disconnect: () => disconnectWallet(),
    };
  }

  if (demo.isDemo) {
    return {
      connected: true,
      address: DEMO_ADDRESS,
      shortAddress: shorten(DEMO_ADDRESS),
      balanceSui: DEMO_BALANCE_SUI,
      isDemo: true,
      connectDemo: demo.connectDemo,
      disconnect: demo.disconnectDemo,
    };
  }

  return {
    connected: false,
    address: null,
    shortAddress: null,
    balanceSui: null,
    isDemo: false,
    connectDemo: demo.connectDemo,
    disconnect: () => {},
  };
}
