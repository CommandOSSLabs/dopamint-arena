// app/src/contexts/BalanceContext.tsx
import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from "react";
import { useSuiClient } from "@mysten/dapp-kit";
import { MIST_PER_SUI } from "@mysten/sui/utils";
import { useCustomWallet } from "@/contexts/CustomWallet";
import { CoinStruct } from "@mysten/sui/client";

interface BalanceContextType {
  balance: number;
  isLoading: boolean;
  balanceFetched: boolean;
  userCoins: CoinStruct[];
  refreshBalance: () => Promise<void>;
}

const BalanceContext = createContext<BalanceContextType | undefined>(undefined);

export const BalanceProvider = ({ children }: { children: any }) => {
  const suiClient = useSuiClient();
  const [balance, setBalance] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [balanceFetched, setBalanceFetched] = useState(false);
  const [userCoins, setUserCoins] = useState<CoinStruct[]>([]);
  const { address } = useCustomWallet();

  const fetchUserCoins = useCallback(async () => {
    try {
      let coins: CoinStruct[] = [];
      let nextCursor: string | null | undefined;
      let res;
      do {
        res = await suiClient!.getAllCoins({
          owner: address!,
          cursor: nextCursor,
        });
        coins = coins.concat(res.data);
        nextCursor = res.nextCursor;
      } while (res.hasNextPage);
      setUserCoins(coins);
    } catch (err) {
      console.error(err);
      setUserCoins([]);
    }
  }, [suiClient, address]);

  const refreshBalance = useCallback(async () => {
    if (address) {
      setIsLoading(true);
      try {
        const resp = await suiClient.getBalance({
          owner: address,
          coinType: import.meta.env.VITE_COIN_TYPE as string,
        });
        setBalance(Number(resp.totalBalance) / Number(MIST_PER_SUI));
        await fetchUserCoins();
      } catch (err) {
        console.error(err);
        setBalance(0);
      } finally {
        setIsLoading(false);
        setBalanceFetched(true);
      }
    }
  }, [suiClient, address, fetchUserCoins]);

  useEffect(() => {
    if (address) {
      refreshBalance();
    }
  }, [refreshBalance, address]);

  return (
    <BalanceContext.Provider
      value={{ balance, isLoading, balanceFetched, userCoins, refreshBalance }}
    >
      {children}
    </BalanceContext.Provider>
  );
};

export const useBalance = () => {
  const context = useContext(BalanceContext);
  if (context === undefined) {
    throw new Error("useBalance must be used within a BalanceProvider");
  }
  return context;
};
