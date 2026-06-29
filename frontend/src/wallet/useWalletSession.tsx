import { createContext, useContext, useState, type ReactNode } from "react";
import {
  useCurrentAccount,
  useDisconnectWallet,
  useSuiClientQuery,
} from "@mysten/dapp-kit";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "@/onchain/mtps";

const DEMO_KEY = "mtps.demoWallet";
// Display-only fake address + balance so the platform is fully usable for a
// demo without a real Sui wallet installed.
const DEMO_ADDRESS =
  "0xde0d0a7e00000000000000000000000000000000000000000000000000c0ffee";
const DEMO_BALANCE_SUI = 1234.56;
const DEMO_BALANCE_MTPS = 10_000;

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
  /** MTPS balance in whole tokens (0-decimal; owned coins + SIP-58 address balance). */
  balanceMtps: number | null;
  isDemo: boolean;
  connectDemo: () => void;
  disconnect: () => void;
  /** Re-fetch the MTPS balance (e.g. after a faucet) so the UI reflects the new amount. */
  refetchBalance: () => void;
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
  // MTPS balance (0-decimal). Default stakes come from the SIP-58 address balance, so sum the owned
  // coins (`totalBalance`) and the address balance (`fundsInAddressBalance`) for the true holdings.
  const { data: mtpsBalance, refetch: refetchMtps } = useSuiClientQuery(
    "getBalance",
    { owner: realAddress ?? "", coinType: MTPS_COIN_TYPE },
    { enabled: !!realAddress && isMtpsConfigured },
  );
  const mtps = mtpsBalance as
    | { totalBalance: string; fundsInAddressBalance?: string }
    | undefined;
  const balanceMtps = mtps
    ? Number(
        BigInt(mtps.totalBalance) + BigInt(mtps.fundsInAddressBalance ?? "0"),
      )
    : null;

  if (realAddress) {
    return {
      connected: true,
      address: realAddress,
      shortAddress: shorten(realAddress),
      balanceSui: balance ? Number(balance.totalBalance) / 1e9 : null,
      balanceMtps,
      isDemo: false,
      connectDemo: demo.connectDemo,
      disconnect: () => disconnectWallet(),
      refetchBalance: () => {
        void refetchMtps();
      },
    };
  }

  if (demo.isDemo) {
    return {
      connected: true,
      address: DEMO_ADDRESS,
      shortAddress: shorten(DEMO_ADDRESS),
      balanceSui: DEMO_BALANCE_SUI,
      balanceMtps: DEMO_BALANCE_MTPS,
      isDemo: true,
      connectDemo: demo.connectDemo,
      disconnect: demo.disconnectDemo,
      refetchBalance: () => {},
    };
  }

  return {
    connected: false,
    address: null,
    shortAddress: null,
    balanceSui: null,
    balanceMtps: null,
    isDemo: false,
    connectDemo: demo.connectDemo,
    disconnect: () => {},
    refetchBalance: () => {},
  };
}
