// Background DOPAMINT top-up (ADR-0010). Keeps a connected wallet's DOPAMINT balance above a
// threshold by faucet-ing (gas-sponsored, free) whenever it drops below it — so the stake hot-path
// (`prepareStake`) is just a coin lookup, never an in-line faucet. Mounted ONCE app-wide via
// {@link DopamintAutoFaucet} (inside the wallet provider), so a top-up fires the moment any wallet
// connects — no game needs to opt in.
import { useEffect, useRef } from "react";
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit";
import {
  DOPAMINT_COIN_TYPE,
  DOPAMINT_MIN_BALANCE,
  faucetDopamint,
  isDopamintConfigured,
} from "./dopamint";
import { useSponsoredSignExec } from "./useSponsoredSignExec";

/** dapp-kit's v1-compat client exposes `getBalance`; typed narrowly to avoid an `any`. */
interface BalanceReader {
  getBalance: (input: {
    owner: string;
    coinType?: string;
  }) => Promise<{ totalBalance: string }>;
}

const TOP_UP_INTERVAL_MS = 30_000;

export function useDopamintAutoFaucet(): void {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { signExec } = useSponsoredSignExec();
  const owner = account?.address;
  // Guard against overlapping top-ups (a faucet tx is in flight, or the interval re-fires).
  const inFlight = useRef(false);

  useEffect(() => {
    if (!owner || !isDopamintConfigured) return;
    let cancelled = false;
    const reader = client as unknown as BalanceReader;

    const topUp = async () => {
      if (inFlight.current) return;
      try {
        const { totalBalance } = await reader.getBalance({
          owner,
          coinType: DOPAMINT_COIN_TYPE,
        });
        if (cancelled || BigInt(totalBalance) >= DOPAMINT_MIN_BALANCE) return;
        inFlight.current = true;
        await faucetDopamint({ signExec, recipient: owner });
      } catch (e) {
        console.warn("[dopamint] auto-faucet top-up failed", e);
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
  }, [owner, client, signExec]);
}

/**
 * App-wide mount for the background top-up. Render ONCE inside the wallet provider (renders
 * nothing). On wallet connect it checks the DOPAMINT balance and faucets if low — so every game
 * gets a ready balance without each hook opting in.
 */
export function DopamintAutoFaucet(): null {
  useDopamintAutoFaucet();
  return null;
}
