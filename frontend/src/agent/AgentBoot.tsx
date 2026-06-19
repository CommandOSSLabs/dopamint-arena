// Agent mode: build a programmatic wallet from the injected ?key, register it with the Wallet
// Standard, and explicitly connect it ONCE (dapp-kit autoConnect can't pick an unseen wallet on
// first load). Renders children once an account is connected.
import { useEffect, useRef, type ReactNode } from "react";
import { getWallets } from "@mysten/wallet-standard";
import { useConnectWallet, useCurrentAccount, useSuiClient } from "@mysten/dapp-kit";
import { programmaticWalletFromSecret } from "../wallet/programmaticWallet";
import { parseAgentConfig } from "./agentConfig";

export function AgentBoot({ children }: { children: ReactNode }) {
  const client = useSuiClient();
  const account = useCurrentAccount();
  const { mutate: connect } = useConnectWallet();
  const tried = useRef(false);

  useEffect(() => {
    const cfg = parseAgentConfig(window.location.href);
    if (!cfg.enabled || !cfg.secretKey || tried.current) return;
    tried.current = true;
    const wallet = programmaticWalletFromSecret(cfg.secretKey, client);
    getWallets().register(wallet as never);
    connect({ wallet: wallet as never });
  }, [client, connect]);

  if (!account) return <div data-agent="connecting">agent connecting…</div>;
  return <>{children}</>;
}
