/**
 * SuiVision explorer links, resolved against the active network so feeds never
 * hardcode a host. Pass the dapp-kit network name (`useSuiClientContext().network`);
 * unknown values fall back to testnet.
 */

export type SuiNetwork = "mainnet" | "testnet" | "devnet" | "localnet";

/** Per-network SuiVision host. Mainnet is the bare domain; the rest are subdomains. */
const SUIVISION_HOST: Record<SuiNetwork, string> = {
  mainnet: "https://suivision.xyz",
  testnet: "https://testnet.suivision.xyz",
  devnet: "https://devnet.suivision.xyz",
  // localnet has no public explorer — point at testnet so links don't dead-end.
  localnet: "https://testnet.suivision.xyz",
};

function host(network: string): string {
  return SUIVISION_HOST[network as SuiNetwork] ?? SUIVISION_HOST.testnet;
}

/** Explorer page for a transaction block (its digest). */
export function suivisionTxUrl(digest: string, network: string): string {
  return `${host(network)}/txblock/${digest}`;
}

/** Explorer page for an account (its address). */
export function suivisionAccountUrl(address: string, network: string): string {
  return `${host(network)}/account/${address}`;
}

/** Middle-truncates a long hash/address for display, e.g. `6h9C3o…JSys`. */
export function truncateMiddle(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
