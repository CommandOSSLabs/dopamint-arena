// Temporary test helper: connect a programmatic wallet from ?devKey without entering agent mode.
import { useEffect, useRef, type ReactNode } from "react";
import { getWallets } from "@mysten/wallet-standard";
import { useConnectWallet, useCurrentAccount, useSuiClient } from "@mysten/dapp-kit";
import { programmaticWalletFromSecret } from "./programmaticWallet";

export function DevWalletBoot({ children }: { children: ReactNode }) {
  const client = useSuiClient();
  const account = useCurrentAccount();
  const { mutate: connect } = useConnectWallet();
  const tried = useRef(false);
  const key = new URL(window.location.href).searchParams.get("devKey");

  useEffect(() => {
    if (!key || tried.current) return;
    tried.current = true;
    const wallet = programmaticWalletFromSecret(key, client);
    getWallets().register(wallet as never);
    connect({ wallet: wallet as never });
  }, [client, connect, key]);

  // Only block the UI when a devKey was supplied and the programmatic wallet
  // hasn't connected yet. Without a devKey we fall through to the normal
  // connect-wallet flow.
  if (key && !account) return <div data-dev-wallet="connecting">dev wallet connecting…</div>;
  return <>{children}</>;
}
