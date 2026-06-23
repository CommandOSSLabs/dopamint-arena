import { useEffect, useRef, type ReactNode } from "react";
import { getWallets } from "@mysten/wallet-standard";
import {
  useConnectWallet,
  useCurrentAccount,
  useSuiClient,
} from "@mysten/dapp-kit";
import { programmaticWalletFromSecret } from "../wallet/programmaticWallet";

/** Registers a programmatic wallet from `secretKey` with the Wallet Standard and connects it
 *  once (dapp-kit autoConnect can't pick an unseen wallet on first load), then renders children.
 *  Used by the ?agent (headless) boot path via AgentBoot. */
export function ProgrammaticWalletGate({
  secretKey,
  children,
}: {
  secretKey: string | null;
  children: ReactNode;
}) {
  const client = useSuiClient();
  const account = useCurrentAccount();
  const { mutate: connect } = useConnectWallet();
  const tried = useRef(false);
  useEffect(() => {
    if (!secretKey || tried.current) return;
    tried.current = true;
    const wallet = programmaticWalletFromSecret(secretKey, client);
    getWallets().register(wallet as never);
    connect({ wallet: wallet as never });
  }, [client, connect, secretKey]);
  if (!account) return <div data-agent="connecting">connecting…</div>;
  return <>{children}</>;
}
