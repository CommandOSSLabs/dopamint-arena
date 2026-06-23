import { SUI_DECIMALS } from "@mysten/sui/utils";

/**
 * Signature types (matching Move constants)
 */
export const SignatureType = {
  ED25519: 0,
  BLS12381_MIN_SIG: 1,
  BLS12381_MIN_PK: 2,
  SECP256K1: 3,
} as const;

export const DefaultFundTunnel = 0.1 * 10 ** SUI_DECIMALS; // 0.1 SUI in MIST
export const DefaultTimeoutTunnel = 5 * 60 * 1000; // 5 minutes in milliseconds
