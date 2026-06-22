export const PACKAGE_ID = `0x8cada1f71e9339fb47cae4539744ad2596fbfb330aea82519e6facf6382de09a`;

/**
 * Signature types (matching Move constants)
 */
export const SignatureType = {
  ED25519: 0,
  BLS12381_MIN_SIG: 1,
  BLS12381_MIN_PK: 2,
  SECP256K1: 3,
} as const;
