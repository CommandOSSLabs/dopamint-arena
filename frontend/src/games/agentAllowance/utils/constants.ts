/** Register id and control-plane game key. */
export const GAME_ID = "agent-allowance";

/**
 * Sample services an agent can pay — distinct on-chain addresses (the contract
 * forbids payee === funder). Budget and per-second rate are user-entered in the lobby.
 */
export const PROVIDERS = [
  {
    name: "AI Inference",
    blurb: "AI text generation",
    address:
      "0xa9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7a9e7",
  },
  {
    name: "Web Search",
    blurb: "Web search queries",
    address:
      "0x5ea45ea45ea45ea45ea45ea45ea45ea45ea45ea45ea45ea45ea45ea45ea45ea4",
  },
  {
    name: "Market Data",
    blurb: "Live market prices",
    address:
      "0xda7ada7ada7ada7ada7ada7ada7ada7ada7ada7ada7ada7ada7ada7ada7ada7a",
  },
] as const;

/** Policy expiry choices; `0` = open-ended. */
export const EXPIRY_OPTIONS = [
  { label: "Never", ms: 0n },
  { label: "1 hour", ms: 3_600_000n },
  { label: "1 day", ms: 86_400_000n },
] as const;

/**
 * On-chain `claim` checks `amount <= entitled(Clock) - spent`. Discount wall-clock
 * so the requested amount stays under what the chain has vested (ENotYetVested).
 */
export const CLAIM_SKEW_MS = 5000n;

export const METER_INTERVAL_MS = 250;

export const txUrl = (digest: string) =>
  `https://suiscan.xyz/testnet/tx/${digest}`;
export const objUrl = (id: string) =>
  `https://suiscan.xyz/testnet/object/${id}`;
