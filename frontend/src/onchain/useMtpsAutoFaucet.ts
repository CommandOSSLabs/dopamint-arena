// Background MTPS top-up (ADR-0010). Keeps a connected wallet's MTPS balance above a
// threshold by faucet-ing (gas-sponsored, free) whenever it drops below it — so the stake hot-path
// (`prepareStake`) is just a coin lookup, never an in-line faucet. Mounted ONCE app-wide via
// {@link MtpsAutoFaucet} (inside the wallet provider), so a top-up fires the moment any wallet
// connects — no game needs to opt in.
import { useEffect, useRef } from "react";
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit";
import {
  MTPS_COIN_TYPE,
  MTPS_MIN_BALANCE,
  faucetMtps,
  isMtpsAddressBalance,
  isMtpsConfigured,
} from "./mtps";

/** dapp-kit's v1-compat client exposes `getBalance`; typed narrowly to avoid an `any`. */
interface BalanceReader {
  getBalance: (input: {
    owner: string;
    coinType?: string;
  }) => Promise<{ totalBalance: string; fundsInAddressBalance?: string }>;
}

const TOP_UP_INTERVAL_MS = 30_000;

export function useMtpsAutoFaucet(): void {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const owner = account?.address;
  // Guard against overlapping top-ups (a faucet tx is in flight, or the interval re-fires).
  const inFlight = useRef(false);

  useEffect(() => {
    if (!owner || !isMtpsConfigured) return;
    let cancelled = false;
    const reader = client as unknown as BalanceReader;

    const topUp = async () => {
      if (inFlight.current) return;
      try {
        const bal = await reader.getBalance({
          owner,
          coinType: MTPS_COIN_TYPE,
        });
        // The balance that matters is whatever the stake path consumes: the SIP-58 address balance
        // in the default mode, or the owned-coin total in coin mode. Top up that one, in kind.
        const have = isMtpsAddressBalance
          ? BigInt(bal.fundsInAddressBalance ?? "0")
          : BigInt(bal.totalBalance);
        if (cancelled || have >= MTPS_MIN_BALANCE) return;
        inFlight.current = true;
        await faucetMtps({ recipient: owner, toBalance: isMtpsAddressBalance });
      } catch (e) {
        console.warn("[mtps] auto-faucet top-up failed", e);
      } finally {
        inFlight.current = false;
      }
    };

    void topUp(); // eager: top up as soon as a wallet connects
    const id = setInterval(() => void topUp(), TOP_UP_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [owner, client]);
}

/**
 * App-wide mount for the background top-up. Render ONCE inside the wallet provider (renders
 * nothing). On wallet connect it checks the MTPS balance and faucets if low — so every game
 * gets a ready balance without each hook opting in.
 */
export function MtpsAutoFaucet(): null {
  useMtpsAutoFaucet();
  return null;
}
