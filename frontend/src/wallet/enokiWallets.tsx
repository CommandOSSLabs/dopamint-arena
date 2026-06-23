import { useEffect } from "react";
import { useSuiClientContext } from "@mysten/dapp-kit";
import { isEnokiNetwork, registerEnokiWallets } from "@mysten/enoki";

// Public client identifiers (safe to ship in the bundle). zkLogin sign-in only lights up
// when BOTH are present; otherwise registration is skipped and the Google entry never
// appears in the connect modal.
const ENOKI_API_KEY = import.meta.env.VITE_ENOKI_API_KEY;
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

/** Whether Enoki Google zkLogin is configured. Gates the sign-in UI off a misconfigured env. */
export const isEnokiZkLoginEnabled = Boolean(ENOKI_API_KEY && GOOGLE_CLIENT_ID);

/**
 * Registers Enoki's Google zkLogin wallet as a wallet-standard wallet so dapp-kit's
 * ConnectModal can offer "Sign in with Google" alongside (or, here, instead of) browser
 * wallets. Renders nothing.
 *
 * Must mount ABOVE WalletProvider so the wallet exists before the wallet store enumerates
 * wallets. Enoki wallets are network-bound, so we re-register on client/network change and
 * return `unregister` to tear down the stale wallet when the network switches.
 */
export function RegisterEnokiWallets() {
  const { client, network } = useSuiClientContext();

  useEffect(() => {
    // Checking the env consts directly (not the boolean flag) narrows them to `string`;
    // isEnokiNetwork narrows `network` to the EnokiNetwork union registerEnokiWallets wants.
    if (!ENOKI_API_KEY || !GOOGLE_CLIENT_ID || !isEnokiNetwork(network)) return;

    const { unregister } = registerEnokiWallets({
      apiKey: ENOKI_API_KEY,
      providers: {
        // Google is the only provider we expose; add facebook/twitch here to widen it.
        google: { clientId: GOOGLE_CLIENT_ID },
      },
      client,
      network,
    });

    return unregister;
  }, [client, network]);

  return null;
}
